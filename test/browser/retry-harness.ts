import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { fixture, startRedis, testConfig } from '../helpers/redis.js';
import type { BrowserResult } from './harness.js';

export const retryCases = ['false', '400', '401', '422', 'network'] as const;
export async function startRetryHarness() {
  const redis = await startRedis();
  const cleanups: Array<() => Promise<void>> = [redis.stop];
  const urls: string[] = [];
  const results: BrowserResult[] = [];
  let finish!: (results: BrowserResult[]) => void;
  const completed = new Promise<BrowserResult[]>((resolve) => { finish = resolve; });
  try {
    const widgetJs = await readFile(fileURLToPath(import.meta.resolve('altcha')), 'utf8');
    const runner = await readFile(new URL('./retry-runner.js', import.meta.url), 'utf8');
    for (const name of retryCases) {
      const probe = createServer(); await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((r) => probe.close(() => r()));
      const origin = `http://127.0.0.1:${port}`;
      const config = testConfig(); config.sites.example!.origins = [origin];
      const f = await fixture(redis.url, config); cleanups.push(f.close);
      let issued = 0;
      const submissions: Array<{ keys: string[]; payload: string; code: string }> = [];
      // Controlled UI fixture only, before designing production image lifecycle.
      const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="220" height="70"><text x="20" y="45" font-size="32">ABC23</text></svg>').toString('base64');
      f.app.addHook('onSend', async (request, _reply, payload) => {
        if (request.url.startsWith('/api/captcha/challenge') && typeof payload === 'string') {
          issued++;
          return JSON.stringify({ ...JSON.parse(payload), codeChallenge: { image, length: 5 } });
        }
        return payload;
      });
      f.app.get('/widget.js', async (_r, reply) => reply.type('text/javascript').send(widgetJs));
      f.app.get('/runner.js', async (_r, reply) => reply.type('text/javascript').send(runner));
      f.app.get('/observations', async () => ({ issued, submissions }));
      f.app.post<{ Body: { payload: string; code: string } }>('/probe/verify', async (request, reply) => {
        submissions.push({ keys: Object.keys(request.body).sort(), ...request.body });
        if (name === 'network') { reply.hijack(); reply.raw.destroy(); return; }
        return reply.code(name === 'false' ? 200 : Number(name)).send({ verified: false, reason: 'Wrong code', error: name === 'false' ? undefined : 'Wrong code' });
      });
      f.app.post<{ Body: BrowserResult }>('/result', async (request) => {
        if (!results.some((r) => r.name === name)) results.push({ ...request.body, name });
        if (results.length === retryCases.length) setImmediate(() => finish(results));
        return { ok: true };
      });
      f.app.get('/case', async (_r, reply) => reply.type('text/html; charset=utf-8').send(`<!doctype html><html><body><h2>retry ${name}</h2>
        <form><altcha-widget></altcha-widget></form><output>Running</output><script>window.retryCase=${JSON.stringify(name)}</script>
        <script src="/runner.js"></script><script type="module" src="/widget.js"></script></body></html>`));
      urls.push(`${origin}/case`);
      if (name === retryCases[0]) f.app.get('/suite', async (_r, reply) => reply.type('text/html; charset=utf-8').send(
        `<!doctype html><html><body><h1>ALTCHA code retry runtime research</h1>${urls.map((url) => `<iframe src="${url}" width="700" height="270"></iframe>`).join('')}</body></html>`));
      await f.app.listen({ host: '127.0.0.1', port });
    }
    return { url: urls[0]!.replace('/case', '/suite'), completed, close: async () => { for (const cleanup of cleanups.reverse()) await cleanup(); } };
  } catch (error) { for (const cleanup of cleanups.reverse()) await cleanup(); throw error; }
}
