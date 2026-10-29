import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { buildApp } from '../src/app.js';
import { CaptchaError, CaptchaStore } from '../src/captcha.js';

async function setup(t: TestContext) {
  const app = await buildApp({
    hmacSecret: 'a'.repeat(64), powCost: 10,
    imageFactory: () => ({ image: 'data:image/png;base64,', code: 'ABC234' }),
  });
  t.after(() => app.close());
  return app;
}

async function issue(app: Awaited<ReturnType<typeof buildApp>>) {
  const bootstrap = await app.inject({ method: 'GET', url: '/api/captcha/challenge' });
  const raw = bootstrap.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]!;
  const response = await app.inject({
    method: 'POST', url: '/api/captcha/challenge', headers: { cookie },
    payload: { his: { focus: [], pointer: [], scroll: [], touch: [], maxTouchPoints: 0, time: Date.now() } },
  });
  const challenge = response.json<Challenge>();
  const solution = await solveChallenge({ challenge, deriveKey });
  assert.ok(solution);
  const payload = Buffer.from(JSON.stringify({
    challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution,
  })).toString('base64');
  return { cookie, payload };
}

test('native verification accepts real PoW and code and preserves protected submission', async (t) => {
  const app = await setup(t);
  const { cookie, payload } = await issue(app);
  const verification = await app.inject({
    method: 'POST', url: '/api/captcha/verify', headers: { cookie }, payload: { payload, code: 'ABC234' },
  });
  assert.equal(verification.statusCode, 200);
  assert.deepEqual(verification.json(), { verified: true });
  const submitted = await app.inject({
    method: 'POST', url: '/api/demo/submit', headers: { cookie }, payload: { message: 'Native verification', altcha: payload },
  });
  assert.equal(submitted.statusCode, 200);
  const replay = await app.inject({
    method: 'POST', url: '/api/captcha/verify', headers: { cookie }, payload: { payload, code: 'ABC234' },
  });
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), { verified: false, reason: new CaptchaError('CAPTCHA_ALREADY_USED').message });
});

test('native refusals use HTTP 200 and retain missing-code and attempt-limit checks', async (t) => {
  const app = await setup(t);
  const { cookie, payload } = await issue(app);
  for (const [code, failure] of [
    [undefined, 'CAPTCHA_CODE_MISSING'], ['000000', 'CAPTCHA_CODE_INVALID'],
    ['000000', 'CAPTCHA_CODE_INVALID'], ['000000', 'CAPTCHA_CODE_LOCKED'], ['ABC234', 'CAPTCHA_CODE_LOCKED'],
  ] as const) {
    const response = await app.inject({
      method: 'POST', url: '/api/captcha/verify', headers: { cookie }, payload: { payload, code },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { verified: false, reason: new CaptchaError(failure).message });
  }
  const submitted = await app.inject({
    method: 'POST', url: '/api/demo/submit', headers: { cookie }, payload: { message: 'Locked', altcha: payload },
  });
  assert.equal(submitted.statusCode, 429);
  assert.equal(submitted.json().code, 'CAPTCHA_CODE_LOCKED');
});

test('missing payload and a different session receive native refusals', async (t) => {
  const app = await setup(t);
  const missing = await app.inject({ method: 'POST', url: '/api/captcha/verify', payload: {} });
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.json(), { verified: false, reason: new CaptchaError('CAPTCHA_MISSING').message });
  const { payload } = await issue(app);
  const mismatch = await app.inject({ method: 'POST', url: '/api/captcha/verify', payload: { payload, code: 'ABC234' } });
  assert.equal(mismatch.statusCode, 200);
  assert.deepEqual(mismatch.json(), { verified: false, reason: new CaptchaError('CAPTCHA_SESSION_MISMATCH').message });
});

test('internal verification errors retain HTTP 500', async (t) => {
  const app = await setup(t);
  t.mock.method(CaptchaStore.prototype, 'verifyCode', async () => { throw new Error('internal failure'); });
  const response = await app.inject({ method: 'POST', url: '/api/captcha/verify', payload: {} });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().code, 'INTERNAL_ERROR');
});

test('native refusals still enforce real PoW and challenge expiration', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const app = await setup(t);
  const { cookie, payload } = await issue(app);
  const changed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  changed.solution.derivedKey = '0'.repeat(64);
  const invalid = await app.inject({
    method: 'POST', url: '/api/captcha/verify', headers: { cookie },
    payload: { payload: Buffer.from(JSON.stringify(changed)).toString('base64'), code: 'ABC234' },
  });
  assert.equal(invalid.statusCode, 200);
  assert.deepEqual(invalid.json(), { verified: false, reason: new CaptchaError('CAPTCHA_INVALID').message });
  t.mock.timers.tick(121_000);
  const expired = await app.inject({
    method: 'POST', url: '/api/captcha/verify', headers: { cookie }, payload: { payload, code: 'ABC234' },
  });
  assert.equal(expired.statusCode, 200);
  assert.deepEqual(expired.json(), { verified: false, reason: new CaptchaError('CAPTCHA_EXPIRED').message });
});

test('request rate limits retain HTTP 429 independently of CAPTCHA refusals', async (t) => {
  const app = await setup(t);
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await app.inject({ method: 'POST', url: '/api/captcha/verify', payload: {} });
    assert.equal(response.statusCode, 200);
  }
  const response = await app.inject({ method: 'POST', url: '/api/captcha/verify', payload: {} });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().code, 'REQUEST_INVALID');
});
