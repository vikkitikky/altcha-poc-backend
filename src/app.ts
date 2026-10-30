import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import { assertOrigin, idPattern, resolveContext, validateConfig, type CaptchaConfig } from './config.js';
import { ApiError } from './errors.js';
import { HisError, parseHis } from './his.js';
import { CaptchaService } from './service.js';
import { CanvasImageGenerator, type ImageGenerator } from './image.js';
import { RedisStore } from './store.js';

export interface AppOptions {
  config: CaptchaConfig;
  store: RedisStore;
  logger?: boolean | { level: string };
  rateLimit?: number;
  imageGenerator?: ImageGenerator;
}
const identifier = { type: 'string', pattern: idPattern.source, maxLength: 100 };
const querySchema = { type: 'object', required: ['site_id'], additionalProperties: false,
  properties: { site_id: identifier, action: identifier, policy: identifier } };
type Query = { site_id: string; action?: string; policy?: string };
export async function buildApp(options: AppOptions) {
  validateConfig(options.config);
  const config = structuredClone(options.config);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 32768, trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: 10000, connectionTimeout: 10000 });
  const service = new CaptchaService(config, options.store, options.imageGenerator ?? new CanvasImageGenerator());
  // Attach authorization scopes without exposing credentials on request/logs.
  const serviceScopes = new WeakMap<object, string[]>();
  const origins = [...new Set(Object.values(config.sites).flatMap((site) => site.origins))];
  await app.register(cors, { origin: origins, methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'], maxAge: 600 });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (request.routeOptions.url === '/api/health' || request.method === 'OPTIONS') return;
    const key = createHash('sha256').update(request.ip).digest('hex');
    if (!await options.store.takeRate(key, options.rateLimit ?? 120, 60)) {
      reply.header('Retry-After', '60'); throw new ApiError(429, 'RATE_LIMITED');
    }
    if (request.headers.origin && !origins.includes(request.headers.origin)) throw new ApiError(403, 'ORIGIN_FORBIDDEN');
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HisError) return reply.code(400).send({ verified: false, error: error.code });
    if (error instanceof ApiError) return reply.code(error.status).send({ verified: false, error: error.code });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ verified: false, error: 'REQUEST_INVALID' });
    }
    request.log.error({ event: 'internal_error', errorType: error instanceof Error ? error.name : 'Unknown' }, 'Internal request failure');
    return reply.code(500).send({ verified: false, error: 'INTERNAL_ERROR' });
  });
  app.get('/api/health', async () => { await options.store.ping(); return { ok: true }; });
  app.get<{ Querystring: Query }>('/api/captcha/challenge', { schema: { querystring: querySchema } }, async (request) => {
    const context = resolveContext(config, request.query.site_id, request.query.action, request.query.policy);
    assertOrigin(config, context, request.headers.origin);
    if (config.hisEnabled) {
      return { his: { url: `/api/captcha/challenge?${new URLSearchParams({ ...context })}` } };
    }
    return service.issue(context, false);
  });
  app.post<{ Querystring: Query; Body: { his: unknown } }>('/api/captcha/challenge', {
    schema: { querystring: querySchema, body: { type: 'object', required: ['his'], additionalProperties: false, properties: { his: {} } } },
  }, async (request) => {
    if (!config.hisEnabled) throw new ApiError(400, 'HIS_DISABLED');
    const context = resolveContext(config, request.query.site_id, request.query.action, request.query.policy);
    assertOrigin(config, context, request.headers.origin);
    parseHis(request.body.his); // Validate once and discard; do not persist or log samples.
    return service.issue(context, true);
  });
  app.post<{ Body: { payload: string; code?: string; fields?: Record<string, string>; timeZone?: string } }>('/api/captcha/verify', {
    schema: { body: { type: 'object', required: ['payload'], additionalProperties: false, properties: {
      payload: { type: 'string', minLength: 1, maxLength: 16384 },
      code: { type: 'string', maxLength: 128 },
      fields: { type: 'object', maxProperties: 20, additionalProperties: { type: 'string', maxLength: 2000 } },
      timeZone: { type: 'string', maxLength: 100 },
    } } },
  }, async (request) => {
    // Native optional form/timeZone fields are accepted but never scored or stored.
    return service.verify(request.body.payload, request.headers.origin, request.body.code, createHash('sha256').update(request.ip).digest('hex'));
  });
  app.post<{ Body: { payload: string; site_id: string; action: string; policy: string } }>('/internal/captcha/validate', {
    onRequest: async (request) => {
      const auth = request.headers.authorization;
      if (!auth || !/^Bearer [^\s]{32,512}$/.test(auth)) throw new ApiError(401, 'SERVICE_UNAUTHORIZED');
      const presented = createHash('sha256').update(auth.slice(7)).digest();
      let allowedSites: string[] | undefined;
      for (const client of Object.values(config.clients)) {
        if (timingSafeEqual(presented, createHash('sha256').update(client.secret).digest())) allowedSites = client.sites;
      }
      if (!allowedSites) throw new ApiError(401, 'SERVICE_UNAUTHORIZED');
      serviceScopes.set(request, allowedSites);
    },
    schema: { body: { type: 'object', required: ['payload', 'site_id', 'action', 'policy'], additionalProperties: false,
      properties: { payload: { type: 'string', minLength: 1, maxLength: 8192 }, site_id: identifier, action: identifier, policy: identifier } } },
  }, async (request) => {
    if (!serviceScopes.get(request)!.includes(request.body.site_id)) throw new ApiError(403, 'SERVICE_SCOPE_FORBIDDEN');
    return service.validate(request.body.payload, { site_id: request.body.site_id, action: request.body.action, policy: request.body.policy });
  });
  return app;
}
