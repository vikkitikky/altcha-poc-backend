import { createHash, randomInt, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createChallenge, verifySolution, type Challenge, type Solution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { SignJWT, jwtVerify } from 'jose';
import { assertOrigin, resolveContext, type CaptchaConfig, type Context } from './config.js';
import { ApiError } from './errors.js';
import { RedisStore } from './store.js';

const issuer = 'captcha-ms';
const audience = 'business-ms';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keyBytes = (secret: string) => new TextEncoder().encode(secret);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
interface ChallengeRecord { challenge: Challenge; context: Context; hisReceived: boolean }
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
  return createHash('sha256').update(JSON.stringify([policy.cost, policy.counterMin, policy.counterMax, policy.challengeTtl, policy.tokenTtl, !!policy.graphics])).digest('hex');
}
export class CaptchaService {
  constructor(private readonly config: CaptchaConfig, private readonly store: RedisStore) {}
  async issue(context: Context, hisReceived: boolean): Promise<Challenge> {
    if (this.config.hisEnabled && !hisReceived) throw new ApiError(400, 'HIS_MISSING');
    const policy = this.config.policies[context.policy]!;
    const id = randomUUID();
    const kid = this.config.challengeKeys.active;
    const expires = Math.floor(Date.now() / 1000) + policy.challengeTtl;
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256', cost: policy.cost,
      counter: randomInt(policy.counterMin, policy.counterMax + 1), deriveKey,
      hmacSignatureSecret: this.config.challengeKeys.keys[kid]!, expiresAt: expires,
      data: { challenge_id: id, kid, ...context, policy_revision: policyRevision(this.config, context), his_received: hisReceived },
    });
    // JSON roundtrip removes undefined optional parameters exactly as HTTP does.
    await this.store.putChallenge(id, JSON.stringify({ challenge, context, hisReceived } satisfies ChallengeRecord), expires);
    return challenge;
  }
  async verify(rawPayload: string, origin?: string) {
    const submitted = decodePayload(rawPayload);
    const id = String(submitted.challenge.parameters.data!.challenge_id);
    const stored = await this.store.getChallenge(id);
    if (!stored) throw new ApiError(400, 'CHALLENGE_NOT_USABLE');
    const record = JSON.parse(stored) as ChallengeRecord;
    if (!isDeepStrictEqual(submitted.challenge, record.challenge)) throw new ApiError(400, 'CHALLENGE_TAMPERED');
    const context = resolveContext(this.config, record.context.site_id, record.context.action, record.context.policy);
    assertOrigin(this.config, context, origin);
    const policy = this.config.policies[context.policy]!;
    if (record.challenge.parameters.cost !== policy.cost
      || record.challenge.parameters.data!.policy_revision !== policyRevision(this.config, context)
      || (this.config.hisEnabled && !record.hisReceived)) throw new ApiError(400, 'POLICY_MISMATCH');
    const kid = String(record.challenge.parameters.data!.kid);
    const secret = Object.hasOwn(this.config.challengeKeys.keys, kid) ? this.config.challengeKeys.keys[kid] : undefined;
    if (!secret) throw new ApiError(400, 'KEY_RETIRED');
    if (record.challenge.parameters.expiresAt! <= Date.now() / 1000) throw new ApiError(400, 'CHALLENGE_EXPIRED');
    const result = await verifySolution({ challenge: record.challenge, solution: submitted.solution, deriveKey, hmacSignatureSecret: secret });
    if (!result.verified) throw new ApiError(400, 'POW_INVALID');
    const now = Math.floor(Date.now() / 1000);
    const expires = now + policy.tokenTtl;
    const tokenId = randomUUID();
    const tokenKid = this.config.tokenKeys.active;
    const token = await new SignJWT({ ...context, policy_revision: policyRevision(this.config, context), his_received: record.hisReceived, v: 1 })
      .setProtectedHeader({ alg: 'HS256', kid: tokenKid, typ: 'JWT' })
      .setIssuer(issuer).setAudience(audience).setJti(tokenId).setIssuedAt(now).setExpirationTime(expires)
      .sign(keyBytes(this.config.tokenKeys.keys[tokenKid]!));
    const claimed = await this.store.completePow(id, tokenId, tokenHash(token), expires);
    if (claimed !== 1) throw new ApiError(400, claimed === 0 ? 'POW_REPLAYED' : 'CHALLENGE_EXPIRED');
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
    if (this.config.hisEnabled && !claims.his_received) throw new ApiError(400, 'POLICY_MISMATCH');
    if (!await this.store.consumeToken(claims.jti!, tokenHash(token))) throw new ApiError(400, 'TOKEN_NOT_USABLE');
    return { valid: true as const, ...expected };
  }
}
