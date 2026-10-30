import Fastify, { LogController } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { configFromEnv, resolveContext } from '../src/config.js';

export interface BusinessOptions {
  captchaOrigin: string;
  serviceSecret: string;
  siteId: string;
  action: string;
  policy: string;
  origins?: string[];
}
/** Demonstration Business MS: context comes exclusively from the operation config. */
export async function buildBusinessApp(options: BusinessOptions) {
  const app = Fastify({ bodyLimit: 32768, logController: new LogController({ disableRequestLogging: true }),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  await app.register(cors, { origin: options.origins ?? [], methods: ['POST'], allowedHeaders: ['Content-Type'] });
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: 'REQUEST_INVALID' }));
  app.post<{ Body: { payload: string; message: string } }>('/api/business/submit', {
    schema: { body: { type: 'object', required: ['payload', 'message'], additionalProperties: false,
      properties: { payload: { type: 'string', minLength: 1, maxLength: 8192 }, message: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S' } } } },
  }, async (request, reply) => {
    let response: Response;
    try {
      response = await fetch(new URL('/internal/captcha/validate', options.captchaOrigin), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.serviceSecret}` },
        body: JSON.stringify({ payload: request.body.payload, site_id: options.siteId, action: options.action, policy: options.policy }),
        signal: AbortSignal.timeout(3000),
      });
    } catch { return reply.code(503).send({ error: 'CAPTCHA_UNAVAILABLE' }); }
    if (!response.ok) return reply.code(response.status >= 500 ? 503 : 400).send({ error: 'CAPTCHA_REJECTED' });
    const result = await response.json() as { valid?: boolean };
    if (result.valid !== true) return reply.code(400).send({ error: 'CAPTCHA_REJECTED' });
    // Replace this demo result with a separately authenticated/authorized business operation.
    return { accepted: true, operation_id: randomUUID() };
  });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv({ path: new URL('../.env.native', import.meta.url), quiet: true });
  const config = configFromEnv(process.env);
  const context = resolveContext(config, 'example', process.env.DEMO_CAPTCHA_ACTION ?? 'submit_form');
  const app = await buildBusinessApp({ captchaOrigin: process.env.CAPTCHA_ORIGIN ?? 'http://127.0.0.1:3001',
    serviceSecret: config.clients.business!.secret, siteId: context.site_id, action: context.action, policy: context.policy,
    origins: config.sites.example!.origins });
  await app.listen({ host: '127.0.0.1', port: 3002 });
  console.log('Demo Business MS: http://127.0.0.1:3002');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
