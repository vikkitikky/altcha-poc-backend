import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createChallenge, verifySolution, type Challenge, type Solution } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { FastifyBaseLogger } from 'fastify';
import { CapacityError, type Session } from './session.js';
import { createImageChallenge, IMAGE_CODE_LENGTH, type CaptchaImage } from './image-captcha.js';
import type { HisData } from './his.js';

export type CaptchaCode = 'CAPTCHA_MISSING' | 'CAPTCHA_INVALID' | 'CAPTCHA_EXPIRED'
  | 'CAPTCHA_SESSION_MISMATCH' | 'CAPTCHA_ALREADY_USED' | 'CAPTCHA_CODE_REQUIRED'
  | 'CAPTCHA_CODE_MISSING' | 'CAPTCHA_CODE_INVALID' | 'CAPTCHA_CODE_LOCKED';

const failures: Record<CaptchaCode, { status: number; message: string }> = {
  CAPTCHA_MISSING: { status: 400, message: 'Отсутствует ALTCHA payload' },
  CAPTCHA_INVALID: { status: 400, message: 'Некорректный ALTCHA payload или решение' },
  CAPTCHA_EXPIRED: { status: 410, message: 'Срок действия challenge истёк' },
  CAPTCHA_SESSION_MISMATCH: { status: 403, message: 'Challenge принадлежит другой сессии' },
  CAPTCHA_ALREADY_USED: { status: 409, message: 'Challenge уже использован' },
  CAPTCHA_CODE_REQUIRED: { status: 403, message: 'Сначала введите символы с картинки и подтвердите CAPTCHA' },
  CAPTCHA_CODE_MISSING: { status: 400, message: 'Введите шесть символов с картинки' },
  CAPTCHA_CODE_INVALID: { status: 400, message: 'Неверные символы. Сбросьте CAPTCHA и попробуйте с новой картинкой' },
  CAPTCHA_CODE_LOCKED: { status: 429, message: 'Лимит попыток исчерпан. Получите новую картинку' },
};

export class CaptchaError extends Error {
  readonly status: number;
  constructor(readonly code: CaptchaCode) {
    super(failures[code].message);
    this.status = failures[code].status;
  }
}

interface ChallengeRecord {
  challenge: Challenge;
  sessionId: string;
  expiresAt: number;
  used: boolean;
  codeHash?: Buffer;
  codeAttempts: number;
  codeVerified: boolean;
  his: HisData;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decode(value: unknown): { challenge: Record<string, unknown>; id: string; solution: Solution } {
  if (value === undefined || value === null || value === '') throw new CaptchaError('CAPTCHA_MISSING');
  if (typeof value !== 'string' || value.length > 16_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new CaptchaError('CAPTCHA_INVALID');
  }
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); }
  catch { throw new CaptchaError('CAPTCHA_INVALID'); }
  if (!object(payload) || !object(payload.challenge) || !object(payload.challenge.parameters)
    || !object(payload.challenge.parameters.data) || typeof payload.challenge.parameters.data.id !== 'string'
    || !object(payload.solution)) throw new CaptchaError('CAPTCHA_INVALID');
  const { counter, derivedKey } = payload.solution;
  if (typeof counter !== 'number' || !Number.isInteger(counter) || counter < 0 || counter > 0xffffffff
    || typeof derivedKey !== 'string' || !/^[a-f0-9]{64}$/.test(derivedKey)) throw new CaptchaError('CAPTCHA_INVALID');
  return { challenge: payload.challenge, id: payload.challenge.parameters.data.id, solution: { counter, derivedKey } };
}

export class CaptchaStore {
  private readonly challenges = new Map<string, ChallengeRecord>();
  private pending = 0;

  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
    private readonly cost: number,
    private readonly imageCaptcha = true,
    private readonly imageFactory: () => CaptchaImage = createImageChallenge,
    private readonly limit = 10_000,
  ) {}

  async issue(session: Session, log: FastifyBaseLogger, his: HisData): Promise<Challenge> {
    this.cleanup();
    // Reserve capacity before awaiting crypto so parallel requests cannot exceed the cap.
    if (this.challenges.size + this.pending >= this.limit) throw new CapacityError('Challenge capacity reached');
    this.pending++;
    try {
      const id = randomUUID();
      const image = this.imageCaptcha ? this.imageFactory() : undefined;
      const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds;
      const challenge = await createChallenge({
        algorithm: 'PBKDF2/SHA-256',
        cost: this.cost,
        counter: randomInt(20, 81),
        deriveKey,
        hmacSignatureSecret: this.secret,
        expiresAt,
        data: { id, codeRequired: Boolean(image) },
      });
      this.challenges.set(id, {
        challenge, sessionId: session.id, expiresAt, used: false,
        codeHash: image ? this.hashCode(id, image.code) : undefined,
        codeAttempts: 0, codeVerified: false,
        his: structuredClone(his),
      });
      log.info({ event: 'challenge_issued', challengeId: id }, 'Выдан подписанный challenge');
      return image ? { ...challenge, codeChallenge: { image: image.image, length: IMAGE_CODE_LENGTH } } : challenge;
    } finally { this.pending--; }
  }

  private async validate(value: unknown, log: FastifyBaseLogger): Promise<{ record: ChallengeRecord; id: string }> {
    log.info({ event: 'verification_started' }, 'Начало серверной проверки');
    const payload = decode(value);
    const record = this.challenges.get(payload.id);
    if (!record) throw new CaptchaError('CAPTCHA_INVALID');
    // Only accept the exact challenge issued here. Never let client-supplied cost/algorithm
    // control server crypto, and never classify expiry/session/replay from untrusted metadata.
    if (!isDeepStrictEqual(payload.challenge, record.challenge)) {
      log.warn({ event: 'signature_integrity_invalid', challengeId: payload.id }, 'Изменена подпись или подписанные параметры challenge');
      throw new CaptchaError('CAPTCHA_INVALID');
    }
    const result = await verifySolution({
      challenge: record.challenge,
      solution: payload.solution,
      deriveKey,
      hmacSignatureSecret: this.secret,
    });
    if (result.invalidSignature) {
      log.warn({ event: 'signature_invalid', challengeId: payload.id }, 'HMAC-подпись не прошла проверку');
      throw new CaptchaError('CAPTCHA_INVALID');
    }
    if (result.expired) this.fail('CAPTCHA_EXPIRED', payload.id, log);
    if (!result.verified) throw new CaptchaError('CAPTCHA_INVALID');

    return { record, id: payload.id };
  }

  private assertActive(record: ChallengeRecord, id: string, session: Session, log: FastifyBaseLogger): void {
    if (record.expiresAt * 1000 <= Date.now()) this.fail('CAPTCHA_EXPIRED', id, log);
    if (record.sessionId !== session.id || session.expiresAt <= Date.now()) this.fail('CAPTCHA_SESSION_MISMATCH', id, log);
    if (record.used) this.fail('CAPTCHA_ALREADY_USED', id, log);
  }

  private hashCode(id: string, code: string): Buffer {
    return createHmac('sha256', this.secret).update(`image-answer\0${id}\0${code}`).digest();
  }

  async verifyCode(value: unknown, code: unknown, session: Session, log: FastifyBaseLogger): Promise<void> {
    const { record, id } = await this.validate(value, log);
    // No await after this point: checks, attempt count and approval are atomic in this process.
    this.assertActive(record, id, session, log);
    if (!record.codeHash || record.codeVerified) return;
    if (record.codeAttempts >= 3) this.fail('CAPTCHA_CODE_LOCKED', id, log);
    if (code === undefined || code === null || code === '') this.fail('CAPTCHA_CODE_MISSING', id, log);
    record.codeAttempts++;
    const normalized = typeof code === 'string' && code.length <= 16 ? code.trim().toUpperCase() : '';
    if (!/^[2-9A-HJKMNP-Z]{6}$/.test(normalized) || !timingSafeEqual(record.codeHash, this.hashCode(id, normalized))) {
      this.fail(record.codeAttempts >= 3 ? 'CAPTCHA_CODE_LOCKED' : 'CAPTCHA_CODE_INVALID', id, log);
    }
    record.codeVerified = true;
    log.info({ event: 'image_code_verified', challengeId: id }, 'Символы с картинки проверены');
  }

  async consume(value: unknown, session: Session, log: FastifyBaseLogger): Promise<HisData> {
    const { record, id } = await this.validate(value, log);
    // Re-check after the last await, immediately before consuming the challenge.
    this.assertActive(record, id, session, log);
    if (record.codeHash && !record.codeVerified) {
      this.fail(record.codeAttempts >= 3 ? 'CAPTCHA_CODE_LOCKED' : 'CAPTCHA_CODE_REQUIRED', id, log);
    }
    record.used = true;
    log.info({ event: 'verification_succeeded', challengeId: id }, 'CAPTCHA успешно проверена и использована');
    return structuredClone(record.his);
  }

  private fail(code: CaptchaCode, id: string, log: FastifyBaseLogger): never {
    log.warn({ event: code, challengeId: id }, failures[code].message);
    throw new CaptchaError(code);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, record] of this.challenges) {
      // Keep expired/used records for five extra minutes to give a reliable error code.
      // After removal, unknown challenges fail closed with CAPTCHA_INVALID.
      if ((record.expiresAt + 300) * 1000 <= now) this.challenges.delete(id);
    }
  }
}
