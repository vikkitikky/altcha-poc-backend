import type { FastifyInstance } from 'fastify';
import { MockCaptchaMs, MsRejection, parseContext } from './ms-captcha.js';
import { MockBusinessMs } from './ms-business.js';

// Fault injection is local PoC infrastructure carried outside the proposed JSON contract.
function controls(header: string | string[] | undefined): Record<string, unknown> {
  try { const result: unknown = JSON.parse(typeof header === 'string' ? header : '{}');
    return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
  } catch { return {}; }
}
function number(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function registerMsRoutes(app: FastifyInstance, secret: string) {
  const captcha = new MockCaptchaMs(secret);
  const business = new MockBusinessMs(captcha);
  app.post('/api/captcha/challenges', async (request, reply) => {
    try {
      const mock = controls(request.headers['x-poc-mock']);
      if (mock.challengeFault === '500') return reply.code(500).send({ error: 'MOCK_CHALLENGE_FAILURE' });
      return await captcha.issue(parseContext(request.body), request.anonymousSession.id,
        number(mock.ttl, 120, -1, 600), number(mock.cost, 1000, 10, 100_000));
    } catch (error) {
      if (!(error instanceof MsRejection)) throw error;
      return reply.code(400).send({ error: error.code });
    }
  });
  app.post<{ Body: { payload?: unknown } }>('/api/captcha/verifications', async (request, reply) => {
    const mock = controls(request.headers['x-poc-mock']);
    await pause(number(mock.delay, 0, 0, 30_000));
    if (mock.verificationFault === '500') return reply.code(500).send({ verified: false, error: 'MOCK_HTTP_500' });
    if (mock.verificationFault === '400') return reply.code(400).send({ verified: false, error: 'MOCK_HTTP_400' });
    if (mock.verificationFault === 'false200') return { verified: false, reason: 'MOCK_REJECTED' };
    try {
      return await captcha.preverify(request.body?.payload, parseContext(request.body), request.anonymousSession.id);
    } catch (error) {
      if (!(error instanceof MsRejection)) throw error;
      return reply.code(400).send({ verified: false, error: error.code });
    }
  });
  app.post<{ Body: { message?: unknown; name?: unknown; mode?: unknown; site_id?: unknown; policy?: unknown; action?: unknown } }>(
    '/api/business/submit', async (request, reply) => {
      const started = performance.now();
      const body = request.body;
      if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000
        || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100
        || (body.mode !== 'pow' && body.mode !== 'record')) {
        return reply.code(400).send({ success: false, code: 'BUSINESS_REQUEST_INVALID' });
      }
      try {
        // Context is the expected operation context in this mock; real Business MS must derive it from its route/config.
        const result = await business.submit(body.mode, request.headers['x-captcha-payload'], parseContext(body),
          request.anonymousSession.id, controls(request.headers['x-poc-mock']).businessDeny === true);
        return reply.code(result.success ? 200 : 422).send(result);
      } catch (error) {
        if (!(error instanceof MsRejection)) throw error;
        return reply.code(403).send({ success: false, code: error.code, captcha: { allowed: false, mode: body.mode },
          internal_call: { transport: 'in-process', duration_ms: performance.now() - started } });
      }
    });
  const timer = setInterval(() => captcha.cleanup(), 30_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
}
