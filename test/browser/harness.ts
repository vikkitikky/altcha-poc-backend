import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { fixture, startRedis, testConfig } from '../helpers/redis.js';
import { CanvasImageGenerator } from '../../src/image.js';
import { defaultImageSettings } from '../../src/config.js';
import { createClient } from 'redis';
import { buildBusinessApp } from '../../examples/business.js';

export interface BrowserResult { name: string; passed: boolean; error?: string; userAgent: string }
export const cases = ['native-pow-business', 'his-reset', 'his-disabled', 'native-retry', 'image-business', 'image-wrong-retry', 'image-his', 'image-reload'] as const;
export type BrowserCase = typeof cases[number];
export async function startBrowserHarness() {
  const redis = await startRedis();
  const cleanups: Array<() => Promise<void>> = [redis.stop];
  const urls: string[] = [];
  const results: BrowserResult[] = [];
  let finish!: (value: BrowserResult[]) => void;
  const completed = new Promise<BrowserResult[]>((resolve) => { finish = resolve; });
  const widgetJs = await readFile(fileURLToPath(import.meta.resolve('altcha')), 'utf8');
  const runnerJs = await readFile(new URL('./runner.js', import.meta.url), 'utf8');
  try {
    for (const name of cases) {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const origin = `http://127.0.0.1:${port}`;
      const config = testConfig(name === 'his-reset' || name === 'his-disabled' || name === 'image-his');
      config.sites.example!.origins = [origin];
      const imageCase = name.startsWith('image-');
      if (imageCase) { config.image = { ...defaultImageSettings, enabled: true }; config.policies.standard!.mode = 'pow+image'; }
      let testAnswer = '';
      const generator = new CanvasImageGenerator();
      const f = await fixture(redis.url, config, undefined, 10000, { async generate(length) {
        const image = await generator.generate(length); testAnswer = image.answer; return image;
      } });
      let lastPowId: string | undefined;
      // Test-only oracle. This file is not part of src/dist/server or production routes.
      if (imageCase) {
        f.app.get('/test-answer', async () => ({ answer: testAnswer }));
        f.app.get('/test-security', async () => {
          const client = createClient({ url: redis.url }); await client.connect();
          try { const prefix = `captcha:{${f.namespace}}:`; return {
            permits: (await client.keys(`${prefix}token:*`)).length,
            powUsed: lastPowId ? await client.get(`${prefix}pow-used:${lastPowId}`) : null,
            attempts: lastPowId ? await client.hGet(`${prefix}image:${lastPowId}`, 'attempts') : null,
          }; } finally { client.destroy(); }
        });
      }
      cleanups.push(f.close);
      const business = await buildBusinessApp({ captchaOrigin: origin, serviceSecret: config.clients.business!.secret,
        siteId: 'example', action: 'submit_form', policy: 'standard', origins: [origin] });
      cleanups.push(() => business.close());
      const businessOrigin = await business.listen({ host: '127.0.0.1', port: 0 });
      const observations: Array<{ method: string; path: string; keys: string[]; hisKeys?: string[] }> = [];
      f.app.addHook('preValidation', async (request) => {
        const path = request.url.split('?')[0]!;
        if (path.startsWith('/api/captcha/')) {
          const body = request.body as Record<string, unknown> | undefined;
          if (typeof body?.payload === 'string') {
            try { lastPowId = JSON.parse(Buffer.from(body.payload,'base64').toString()).challenge.parameters.data.challenge_id; } catch {}
          }
          observations.push({ method: request.method, path, keys: body ? Object.keys(body) : [],
            ...(body?.his && typeof body.his === 'object' ? { hisKeys: Object.keys(body.his).sort() } : {}) });
        }
      });
      f.app.get('/widget.js', async (_request, reply) => reply.type('text/javascript').send(widgetJs));
      f.app.get('/runner.js', async (_request, reply) => reply.type('text/javascript').send(runnerJs));
      f.app.get('/observations', async () => observations);
      f.app.post<{ Body: BrowserResult }>('/result', async (request) => {
        if (!results.some((r) => r.name === name)) results.push({ ...request.body, name });
        if (results.length === cases.length) setImmediate(() => finish(results));
        return { ok: true };
      });
      f.app.get('/case', async (_request, reply) => reply.type('text/html; charset=utf-8').send(`<!doctype html><html><body>
        <h2>${name}</h2><form><input name="message" value="Test operation">
        <altcha-widget configuration='${JSON.stringify({ humanInteractionSignature: name !== 'his-disabled' && name !== 'native-pow-business' })}'></altcha-widget></form>
        <output>Running…</output><script>window.testCase = ${JSON.stringify({ name, businessOrigin })};</script>
        <script src="/runner.js"></script><script type="module" src="/widget.js"></script></body></html>`));
      urls.push(`${origin}/case`);
      // The first service hosts a simple index with the independent same-origin test pages.
      if (name === cases[0]) f.app.get('/suite', async (_request, reply) => reply.type('text/html; charset=utf-8').send(
        `<!doctype html><html><body><h1>ALTCHA 3.5.0 native integration tests</h1>${urls.map((url) => `<iframe src="${url}" width="700" height="360"></iframe>`).join('')}</body></html>`));
      await f.app.listen({ host: '127.0.0.1', port });
    }
    return { url: urls[0]!.replace('/case', '/suite'), caseUrls: urls, completed,
      close: async () => { for (const cleanup of cleanups.reverse()) await cleanup(); } };
  } catch (error) { for (const cleanup of cleanups.reverse()) await cleanup(); throw error; }
}
