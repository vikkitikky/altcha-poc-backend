import { randomInt, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createChallenge, verifySolution, type Challenge, type Solution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';

export interface MsContext { site_id: string; policy: string; action: string }
export type ResultMode = 'pow' | 'record';
export class MsRejection extends Error {
  constructor(readonly code: string) { super(code); }
}
interface ChallengeRecord {
  challenge: Challenge;
  context: MsContext;
  session: string;
  expires: number;
  used: boolean;
  verificationId?: string;
}
export interface VerificationRecord extends MsContext {
  verified: true;
  verification_id: string;
  verified_at: string;
  expires_at: string;
}
interface StoredVerification { response: VerificationRecord; challengeId: string }

export function parseContext(value: unknown): MsContext {
  if (!value || typeof value !== 'object') throw new MsRejection('CONTEXT_INVALID');
  const context = value as Record<string, unknown>;
  for (const key of ['site_id', 'policy', 'action']) {
    if (typeof context[key] !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(context[key])) {
      throw new MsRejection('CONTEXT_INVALID');
    }
  }
  return { site_id: context.site_id as string, policy: context.policy as string, action: context.action as string };
}

/** Local research service. In-memory records and single-use/session rules are PoC hypotheses. */
export class MockCaptchaMs {
  private challenges = new Map<string, ChallengeRecord>();
  private verifications = new Map<string, StoredVerification>();
  constructor(private secret: string, private clock: () => number = Date.now) {}

  async issue(context: MsContext, session: string, ttl = 120, cost = 1000) {
    this.cleanup();
    if (this.challenges.size >= 10_000) throw new MsRejection('MOCK_CAPACITY');
    const id = randomUUID();
    const expires = Math.floor(this.clock() / 1000) + ttl;
    const challenge = await createChallenge({
      algorithm: 'PBKDF2/SHA-256', cost, counter: randomInt(40, 81), deriveKey,
      hmacSignatureSecret: this.secret, expiresAt: expires,
      data: { challenge_id: id, ...context },
    });
    this.challenges.set(id, { challenge, context: { ...context }, session, expires, used: false });
    return { challenge_id: id, site_id: context.site_id, policy: context.policy, challenge,
      expires_at: new Date(expires * 1000).toISOString() };
  }

  private assertUsable(record: ChallengeRecord, context: MsContext, session: string) {
    if (record.expires * 1000 <= this.clock()) throw new MsRejection('EXPIRED');
    if (!isDeepStrictEqual(record.context, context)) throw new MsRejection('CONTEXT_MISMATCH');
    if (record.session !== session) throw new MsRejection('SESSION_MISMATCH');
    if (record.used) throw new MsRejection('ALREADY_USED');
  }

  private async validate(payload: unknown, context: MsContext, session: string) {
    if (typeof payload !== 'string' || !payload || payload.length > 16_384
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) throw new MsRejection('PAYLOAD_INVALID');
    let decoded: { challenge?: Challenge; solution?: Solution };
    try { decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')); }
    catch { throw new MsRejection('PAYLOAD_INVALID'); }
    if (!decoded || typeof decoded !== 'object') throw new MsRejection('PAYLOAD_INVALID');
    const id = decoded.challenge?.parameters?.data?.challenge_id;
    const record = typeof id === 'string' ? this.challenges.get(id) : undefined;
    if (!record || !isDeepStrictEqual(decoded.challenge, record.challenge)) throw new MsRejection('CHALLENGE_INVALID');
    const solution = decoded.solution;
    if (!solution || !Number.isInteger(solution.counter) || solution.counter < 0 || solution.counter > 0xffffffff
      || typeof solution.derivedKey !== 'string' || !/^[a-f0-9]{64}$/.test(solution.derivedKey)) {
      throw new MsRejection('SOLUTION_INVALID');
    }
    this.assertUsable(record, context, session);
    const result = await verifySolution({ challenge: record.challenge, solution, deriveKey, hmacSignatureSecret: this.secret });
    if (!result.verified) throw new MsRejection(result.expired ? 'EXPIRED' : 'SOLUTION_INVALID');
    // All use/context checks repeated after crypto await, immediately before mutation.
    this.assertUsable(record, context, session);
    return { id: id as string, record };
  }

  async preverify(payload: unknown, context: MsContext, session: string): Promise<VerificationRecord> {
    const { id, record } = await this.validate(payload, context, session);
    if (record.verificationId) return { ...this.verifications.get(record.verificationId)!.response };
    const response: VerificationRecord = {
      verified: true, verification_id: randomUUID(), ...record.context,
      verified_at: new Date(this.clock()).toISOString(), expires_at: new Date(record.expires * 1000).toISOString(),
    };
    record.verificationId = response.verification_id;
    this.verifications.set(response.verification_id, { challengeId: id, response });
    return { ...response };
  }

  /** Models the internal CAPTCHA MS API. No frontend state can approve this call. */
  async authorize(mode: ResultMode, candidate: unknown, context: MsContext, session: string) {
    let record: ChallengeRecord;
    if (mode === 'pow') {
      ({ record } = await this.validate(candidate, context, session));
    } else {
      const verification = typeof candidate === 'string' ? this.verifications.get(candidate) : undefined;
      const found = verification && this.challenges.get(verification.challengeId);
      if (!found || !verification.response.verified) throw new MsRejection('VERIFICATION_UNKNOWN');
      record = found;
    }
    this.assertUsable(record, context, session);
    record.used = true; // Atomic in this process; shared by both experimental modes.
    return { allowed: true, mode, context: { ...record.context }, consumed: true };
  }

  cleanup() {
    for (const [id, record] of this.challenges) {
      if ((record.expires + 300) * 1000 <= this.clock()) {
        this.challenges.delete(id);
        if (record.verificationId) this.verifications.delete(record.verificationId);
      }
    }
  }
}
