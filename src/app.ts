import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import cors from '@fastify/cors';
import { CaptchaError, CaptchaStore } from './captcha.js';
import { CapacityError, SessionStore, type Session } from './session.js';
import type { CaptchaImage } from './image-captcha.js';
import { HisError, parseHis } from './his.js';
import { registerMsRoutes } from './ms-routes.js';

declare module 'fastify' {
  interface FastifyRequest { anonymousSession: Session }
}

export interface AppOptions {
  hmacSecret: string;
  sessionTtlSeconds?: number;
  challengeTtlSeconds?: number;
  powCost?: number;
  imageCaptcha?: boolean;
  imageFactory?: () => CaptchaImage;
  corsOrigins?: string[];
  logger?: boolean | { level: string };
}

export async function buildApp(options: AppOptions) {
  if (options.hmacSecret.length < 32) throw new Error('HMAC_SECRET must contain at least 32 characters');
  const corsOrigins = [...(options.corsOrigins ?? ['http://localhost:3000'])];
  for (const origin of corsOrigins) {
    let url: URL;
    try { url = new URL(origin); }
    catch { throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins without paths or wildcards'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error('CORS_ORIGINS must contain exact HTTP(S) origins without paths or wildcards');
    }
  }
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32_768,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const sessions = new SessionStore(options.sessionTtlSeconds ?? 3600);
  const captcha = new CaptchaStore(
    options.hmacSecret, options.challengeTtlSeconds ?? 120, options.powCost ?? 1000,
    options.imageCaptcha ?? true, options.imageFactory,
  );
  // Complete browser preflights before session creation: OPTIONS has no credentials.
  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Captcha-Payload', 'X-Poc-Mock'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.decorateRequest('anonymousSession');
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    request.anonymousSession = sessions.getOrCreate(request, reply);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HisError) {
      request.log.info({ event: 'his_rejected', code: error.code }, error.message);
      return reply.code(400).send({ success: false, code: error.code, message: error.message });
    }
    if (error instanceof CaptchaError) {
      request.log.info({ event: 'verification_rejected', code: error.code }, error.message);
      return reply.code(error.status).send({ success: false, code: error.code, message: error.message });
    }
    if (error instanceof CapacityError) {
      return reply.code(503).send({ success: false, code: 'CAPACITY_REACHED', message: 'Лимит локального хранилища; повторите позже' });
    }
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
      && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ success: false, code: 'REQUEST_INVALID', message: 'Недопустимый запрос или превышен лимит запросов' });
    }
    request.log.error({ event: 'internal_error', errorType: error instanceof Error ? error.name : 'Unknown' }, 'Внутренняя ошибка');
    return reply.code(500).send({ success: false, code: 'INTERNAL_ERROR', message: 'Внутренняя ошибка сервера' });
  });
  app.get('/api/health', async () => ({ ok: true }));
  registerMsRoutes(app, options.hmacSecret);
  app.get('/api/captcha/challenge', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async () => ({ his: { url: '/api/captcha/challenge' } }));
  app.post<{ Body: { his?: unknown } }>('/api/captcha/challenge', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: { type: 'object', additionalProperties: false, properties: { his: {} } },
    },
  }, async (request) => {
    const his = parseHis(request.body.his);
    request.log.info({
      event: 'his_received', focusSamples: his.focus.length, pointerSamples: his.pointer.length,
      scrollSamples: his.scroll.length, touchSamples: his.touch.length,
    }, 'Получен снимок HIS; данные переданы клиентом');
    return captcha.issue(request.anonymousSession, request.log, his);
  });
  app.post<{ Body: { payload?: unknown; code?: unknown } }>('/api/captcha/verify', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: { payload: {}, code: {} },
      },
    },
  }, async (request) => {
    try {
      await captcha.verifyCode(request.body.payload, request.body.code, request.anonymousSession, request.log);
      return { verified: true };
    } catch (error) {
      if (!(error instanceof CaptchaError)) throw error;
      request.log.info({ event: 'verification_rejected', code: error.code }, error.message);
      return { verified: false, reason: error.message };
    }
  });
  app.post<{ Body: { message: string; altcha?: unknown } }>('/api/demo/submit', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        additionalProperties: false,
        properties: {
          message: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' },
          // Validate payload in the service so malformed/missing values get CAPTCHA codes.
          altcha: {},
        },
      },
    },
  }, async (request) => {
    const his = await captcha.consume(request.body.altcha, request.anonymousSession, request.log);
    return { success: true, message: 'CAPTCHA успешно проверена', his };
  });
  const cleanup = setInterval(() => { sessions.cleanup(); captcha.cleanup(); }, 30_000);
  cleanup.unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); });
  return app;
}
