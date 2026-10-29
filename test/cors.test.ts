import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { buildApp, type AppOptions } from '../src/app.js';
import { createImageChallenge } from '../src/image-captcha.js';

const origin = 'http://localhost:3000';

async function setup(t: TestContext, options: Partial<AppOptions> = {}) {
  const app = await buildApp({ hmacSecret: randomBytes(32).toString('hex'), powCost: 10, ...options });
  t.after(async () => { await app.close(); });
  return app;
}

test('JSON preflight allows localhost:3000 with credentials and creates no session', async (t) => {
  const app = await setup(t);
  for (const url of ['/api/captcha/challenge', '/api/captcha/verify', '/api/demo/submit']) {
    const response = await app.inject({
      method: 'OPTIONS', url,
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], origin);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.match(String(response.headers['access-control-allow-methods']), /POST/);
    assert.match(String(response.headers['access-control-allow-headers']), /content-type/i);
    assert.equal(response.headers['set-cookie'], undefined);
  }
});

test('the full image CAPTCHA and HIS flow returns credentialed CORS headers', async (t) => {
  let answer = '';
  const app = await setup(t, {
    imageFactory: () => {
      const image = createImageChallenge();
      answer = image.code;
      return image;
    },
  });
  const bootstrap = await app.inject({ method: 'GET', url: '/api/captcha/challenge', headers: { origin } });
  assert.equal(bootstrap.headers['access-control-allow-origin'], origin);
  assert.equal(bootstrap.headers['access-control-allow-credentials'], 'true');
  assert.match(String(bootstrap.headers.vary), /Origin/i);
  const rawCookie = bootstrap.headers['set-cookie'];
  const setCookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  assert.ok(setCookie);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  const cookie = setCookie.split(';')[0];
  assert.ok(cookie);
  const his = { focus: [], maxTouchPoints: 0, pointer: [], scroll: [], time: Date.now(), touch: [] };
  const challengeResponse = await app.inject({
    method: 'POST', url: '/api/captcha/challenge', headers: { origin, cookie }, payload: { his },
  });
  assert.equal(challengeResponse.statusCode, 200);
  assert.equal(challengeResponse.headers['set-cookie'], undefined);
  assert.equal(challengeResponse.headers['access-control-allow-origin'], origin);
  const challenge = challengeResponse.json<Challenge>();
  const solution = await solveChallenge({ challenge, deriveKey });
  assert.ok(solution);
  const payload = Buffer.from(JSON.stringify({
    challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution,
  })).toString('base64');
  const verification = await app.inject({
    method: 'POST', url: '/api/captcha/verify', headers: { origin, cookie }, payload: { payload, code: answer },
  });
  assert.equal(verification.statusCode, 200);
  assert.equal(verification.json().verified, true);
  assert.equal(verification.headers['access-control-allow-origin'], origin);
  assert.equal(verification.headers['access-control-allow-credentials'], 'true');
  const submitted = await app.inject({
    method: 'POST', url: '/api/demo/submit', headers: { origin, cookie }, payload: { message: 'CORS test', altcha: payload },
  });
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.json().success, true);
  assert.deepEqual(submitted.json().his, his);
  assert.equal(submitted.headers['access-control-allow-origin'], origin);
  assert.equal(submitted.headers['access-control-allow-credentials'], 'true');
});

test('CAPTCHA error responses are readable by the allowed frontend', async (t) => {
  const app = await setup(t);
  const response = await app.inject({
    method: 'POST', url: '/api/demo/submit', headers: { origin }, payload: { message: 'Тест' },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'CAPTCHA_MISSING');
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
});

test('unlisted origins do not receive a CORS allow-origin header', async (t) => {
  const app = await setup(t);
  for (const unlisted of ['http://evil.test:3000', 'http://localhost:30000', 'https://localhost:3000', 'http://127.0.0.1:3000', 'null']) {
    const response = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: unlisted } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
});

test('an explicit CORS allowlist replaces the default and can disable cross-origin access', async (t) => {
  const custom = 'http://localhost:4000';
  const app = await setup(t, { corsOrigins: [custom] });
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { origin: custom } })).headers['access-control-allow-origin'], custom);
  assert.equal((await app.inject({ method: 'GET', url: '/api/health', headers: { origin } })).headers['access-control-allow-origin'], undefined);
  const disabled = await setup(t, { corsOrigins: [] });
  assert.equal((await disabled.inject({ method: 'GET', url: '/api/health', headers: { origin } })).headers['access-control-allow-origin'], undefined);
});

test('CORS configuration rejects wildcards and values other than exact HTTP(S) origins', async () => {
  for (const invalid of ['*', 'http://localhost:3000/path', 'http://localhost:3000/', 'http://name:password@localhost:3000', 'file:///tmp/test']) {
    await assert.rejects(buildApp({ hmacSecret: randomBytes(32).toString('hex'), corsOrigins: [invalid] }), /CORS_ORIGINS/);
  }
});
