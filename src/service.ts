import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createChallenge, verifySolution, type Challenge, type Solution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { SignJWT, jwtVerify } from 'jose';
import { assertOrigin, resolveContext, captchaMode, imageSettings, type CaptchaConfig, type Context } from './config.js';
import { ApiError } from './errors.js';
import { CanvasImageGenerator, imageAlphabet, type ImageGenerator } from './image.js';
import { RedisStore } from './store.js';

const issuer = 'captcha-ms';
const audience = 'business-ms';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyBytes = (secret: string) => new TextEncoder().encode(secret);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
interface ChallengeRecord { challenge: Challenge; context: Context; hisReceived: boolean; imageId?: string }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function decodePayload(payload: string): { challenge: Challenge; solution: Solution } {
  try {
    if (!payload || payload.length > 16384 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(payload)) throw new Error();
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.toString('base64') !== payload) throw new Error();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!object(value) || Object.keys(value).length !== 2 || !object(value.challenge) || !object(value.solution)
      || !object(value.challenge.parameters) || !object(value.challenge.parameters.data)
      || typeof value.challenge.parameters.data.challenge_id !== 'string' || !uuid.test(value.challenge.parameters.data.challenge_id)
      || !Number.isSafeInteger(value.solution.counter) || Number(value.solution.counter) < 0 || Number(value.solution.counter) > 0xffffffff
      || typeof value.solution.derivedKey !== 'string' || !/^[0-9a-f]{64}$/.test(value.solution.derivedKey)
      || Object.keys(value.solution).some((key) => !['counter', 'derivedKey', 'time'].includes(key))
      || (value.solution.time !== undefined && (typeof value.solution.time !== 'number' || !Number.isFinite(value.solution.time) || value.solution.time < 0))) {
      throw new Error();
    }
    return value as unknown as { challenge: Challenge; solution: Solution };
  } catch { throw new ApiError(400, 'PAYLOAD_INVALID'); }
}
export function policyRevision(config: CaptchaConfig, context: Context): string {
  const policy = config.policies[context.policy]!;
  const base: unknown[] = [policy.cost, policy.counterMin, policy.counterMax, policy.challengeTtl, policy.tokenTtl, !!policy.graphics];
  if (captchaMode(policy) === 'pow+image') { const image = imageSettings(config); base.push('pow+image', image.length, image.ttl); }
  return createHash('sha256').update(JSON.stringify(base)).digest('hex');
}
function imageDigest(secret: string, imageId: string, answer: string) {
  return createHmac('sha256', secret).update(`altcha-image-v1\0${imageId}\0${answer}`).digest('hex');
}
export class CaptchaService {
  constructor(private readonly config: CaptchaConfig, private readonly store: RedisStore,
    private readonly images: ImageGenerator = new CanvasImageGenerator()) {}
  async issue(context: Context, hisReceived: boolean): Promise<Challenge> {
    if (this.config.hisEnabled && !hisReceived) throw new ApiError(400, 'HIS_MISSING');
    const policy = this.config.policies[context.policy]!;
    const id = randomUUID();
    const kid = this.config.challengeKeys.active;
    const settings = imageSettings(this.config);
    const image = captchaMode(policy) === 'pow+image' ? await this.images.generate(settings.length) : undefined;
    const imageId = image ? randomUUID() : undefined;
    const expires = Math.floor(Date.now() / 1000) + (image ? Math.min(policy.challengeTtl, settings.ttl) : policy.challengeTtl);
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256', cost: policy.cost,
      counter: randomInt(policy.counterMin, policy.counterMax + 1), deriveKey,
      hmacSignatureSecret: this.config.challengeKeys.keys[kid]!, expiresAt: expires,
      data: { challenge_id: id, kid, ...context, policy_revision: policyRevision(this.config, context), his_received: hisReceived,
        ...(image ? { captcha_mode: 'pow+image', image_id: imageId! } : {}) },
    });
    // The widget includes only parameters/signature in its PoW payload, never codeChallenge.
    await this.store.putChallenge(id, JSON.stringify({ challenge, context, hisReceived, imageId } satisfies ChallengeRecord), expires,
      image ? { id: imageId!, digest: imageDigest(this.config.challengeKeys.keys[kid]!, imageId!, image.answer) } : undefined);
    return image ? { ...challenge, codeChallenge: { image: `data:image/png;base64,${Buffer.from(image.png).toString('base64')}`, length: settings.length } } : challenge;
  }
  async verify(rawPayload: string, origin?: string, code?: string, clientKey = 'direct') {
    const submitted = decodePayload(rawPayload);
    try { return await this.verifyDecoded(submitted, origin, code, clientKey); }
    catch (error) {
      // Expected image refusals must complete the native code-submission promise.
      // HTTP errors in Widget 3.5.0's Code path otherwise strand it in verifying.
      if (submitted.challenge.parameters.data!.captcha_mode === 'pow+image' && error instanceof ApiError && error.status < 500) {
        return { verified: false as const, reason: error.code };
      }
      throw error;
    }
  }
  private async verifyDecoded(submitted: { challenge: Challenge; solution: Solution }, origin: string | undefined, code: string | undefined, clientKey: string) {
    const id = String(submitted.challenge.parameters.data!.challenge_id);
    const stored = await this.store.getChallenge(id);
    if (!stored) throw new ApiError(400, 'CHALLENGE_NOT_USABLE');
    const record = JSON.parse(stored) as ChallengeRecord;
    if (!isDeepStrictEqual(submitted.challenge, record.challenge)) throw new ApiError(400, 'CHALLENGE_TAMPERED');
    const context = resolveContext(this.config, record.context.site_id, record.context.action, record.context.policy);
    assertOrigin(this.config, context, origin);
    const policy = this.config.policies[context.policy]!;
    const mode = captchaMode(policy);
    if (record.challenge.parameters.cost !== policy.cost
      || record.challenge.parameters.data!.policy_revision !== policyRevision(this.config, context)
      || (this.config.hisEnabled && !record.hisReceived)) throw new ApiError(400, 'POLICY_MISMATCH');
    const kid = String(record.challenge.parameters.data!.kid);
    const secret = Object.hasOwn(this.config.challengeKeys.keys, kid) ? this.config.challengeKeys.keys[kid] : undefined;
    if (!secret) throw new ApiError(400, 'KEY_RETIRED');
    if (record.challenge.parameters.expiresAt! <= Date.now() / 1000) throw new ApiError(400, 'CHALLENGE_EXPIRED');
    const result = await verifySolution({ challenge: record.challenge, solution: submitted.solution, deriveKey, hmacSignatureSecret: secret });
    if (!result.verified) throw new ApiError(400, 'POW_INVALID');
    let imageAttempt: { id: string; digest: string; rateKey: string; limit: number } | undefined;
    if (mode === 'pow+image') {
      if (code === undefined || code.trim() === '') throw new ApiError(400, 'IMAGE_CODE_REQUIRED');
      const normalized = code.trim().toUpperCase();
      const settings = imageSettings(this.config);
      if (normalized.length !== settings.length || [...normalized].some(c => !imageAlphabet.includes(c))) throw new ApiError(400, 'IMAGE_CODE_INVALID');
      if (!record.imageId || record.challenge.parameters.data!.image_id !== record.imageId) throw new ApiError(400, 'IMAGE_NOT_USABLE');
      imageAttempt = { id: record.imageId, digest: imageDigest(secret, record.imageId, normalized), rateKey: clientKey, limit: settings.rateLimit };
    } else if (code !== undefined) throw new ApiError(400, 'CODE_UNEXPECTED');
    const now = Math.floor(Date.now() / 1000);
    const expires = now + policy.tokenTtl;
    const tokenId = randomUUID();
    const tokenKid = this.config.tokenKeys.active;
    const token = await new SignJWT({ ...context, policy_revision: policyRevision(this.config, context), his_received: record.hisReceived, v: 1,
      ...(imageAttempt ? { captcha_mode: mode, image_id: record.imageId, image_verified: true } : {}) })
      .setProtectedHeader({ alg: 'HS256', kid: tokenKid, typ: 'JWT' })
      .setIssuer(issuer).setAudience(audience).setJti(tokenId).setIssuedAt(now).setExpirationTime(expires)
      .sign(keyBytes(this.config.tokenKeys.keys[tokenKid]!));
    const claimed = await this.store.completePow(id, tokenId, tokenHash(token), expires, imageAttempt);
    if (claimed !== 1) {
      const reasons: Record<number, string> = { 0: 'POW_REPLAYED', [-1]: 'CHALLENGE_EXPIRED', [-2]: 'IMAGE_NOT_USABLE', [-3]: 'IMAGE_ALREADY_ATTEMPTED', [-4]: 'IMAGE_RATE_LIMITED', [-5]: 'IMAGE_INCORRECT' };
      throw new ApiError(400, reasons[claimed] ?? 'IMAGE_NOT_USABLE');
    }
    return { verified: true as const, payload: token };
  }
  async validate(token: string, expected: Context) {
    let claims;
    try {
      const result = await jwtVerify(token, (header) => {
        if (header.alg !== 'HS256' || header.typ !== 'JWT' || !header.kid || !Object.hasOwn(this.config.tokenKeys.keys, header.kid)) throw new Error();
        return keyBytes(this.config.tokenKeys.keys[header.kid]!);
      }, { algorithms: ['HS256'], issuer, audience, requiredClaims: ['exp', 'iat', 'jti', 'site_id', 'action', 'policy', 'policy_revision', 'v'], maxTokenAge: 120 });
      claims = result.payload;
      const now = Math.floor(Date.now() / 1000);
      if (claims.v !== 1 || typeof claims.jti !== 'string' || !uuid.test(claims.jti)
        || typeof claims.exp !== 'number' || typeof claims.iat !== 'number'
        || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat)
        || claims.iat > now || claims.exp - claims.iat > 120 || claims.exp <= claims.iat
        || typeof claims.his_received !== 'boolean') throw new Error();
    } catch { throw new ApiError(400, 'TOKEN_INVALID'); }
    if (claims.site_id !== expected.site_id || claims.action !== expected.action || claims.policy !== expected.policy) {
      throw new ApiError(400, 'CONTEXT_MISMATCH');
    }
    resolveContext(this.config, expected.site_id, expected.action, expected.policy);
    if (claims.policy_revision !== policyRevision(this.config, expected)) throw new ApiError(400, 'POLICY_MISMATCH');
    const mode = captchaMode(this.config.policies[expected.policy]!);
    if ((claims.captcha_mode ?? 'pow') !== mode || (mode === 'pow+image' && (claims.image_verified !== true || typeof claims.image_id !== 'string' || !uuid.test(claims.image_id)))) throw new ApiError(400, 'POLICY_MISMATCH');
    if (this.config.hisEnabled && !claims.his_received) throw new ApiError(400, 'POLICY_MISMATCH');
    if (!await this.store.consumeToken(claims.jti!, tokenHash(token))) throw new ApiError(400, 'TOKEN_NOT_USABLE');
    return { valid: true as const, ...expected };
  }
}
