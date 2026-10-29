import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { solveChallenge, type Challenge, type Payload } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { buildApp, type AppOptions } from '../src/app.js';
import { createImageChallenge } from '../src/image-captcha.js';
import type { HisData } from '../src/his.js';
import { CaptchaError } from '../src/captcha.js';

function emptyHis(): HisData {
  return { focus: [], maxTouchPoints: 0, pointer: [], scroll: [], time: Date.now(), touch: [] };
}

async function setup(t: TestContext, options: Partial<Omit<AppOptions, 'hmacSecret'>> = {}) {
  const app = await buildApp({ hmacSecret: randomBytes(32).toString('hex'), powCost: 10, imageCaptcha: false, ...options });
  t.after(async () => { await app.close(); });
  return app;
}

async function issue(app: Awaited<ReturnType<typeof buildApp>>, cookie?: string, his: HisData = emptyHis()) {
  const response = await app.inject({ method: 'GET', url: '/api/captcha/challenge', headers: cookie ? { cookie } : {} });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { his: { url: '/api/captcha/challenge' } });
  const rawCookie = response.headers['set-cookie'];
  const header = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
  const jar = header?.split(';')[0] ?? cookie;
  assert.ok(jar);
  const challengeResponse = await app.inject({
    method: 'POST', url: '/api/captcha/challenge', headers: { cookie: jar }, payload: { his },
  });
  assert.equal(challengeResponse.statusCode, 200);
  const challenge = challengeResponse.json<Challenge>();
  const solution = await solveChallenge({ challenge, deriveKey });
  assert.ok(solution, 'Official ALTCHA solver must solve the challenge');
  // The official widget strips the image before encoding its PoW payload.
  const data: Payload = { challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution };
  return { cookie: jar, data, challenge, his, payload: encode(data), response };
}

function encode(payload: Payload): string { return Buffer.from(JSON.stringify(payload)).toString('base64'); }
function submit(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, altcha?: unknown) {
  return app.inject({ method: 'POST', url: '/api/demo/submit', headers: { cookie }, payload: { message: 'Тест', altcha } });
}

test('valid real ALTCHA payload, secure local cookie flags, no-store, unique challenge IDs', async (t) => {
  const app = await setup(t);
  const issued = await issue(app);
  const raw = String(issued.response.headers['set-cookie']);
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Lax/i);
  assert.match(raw, /Path=\//i);
  assert.match(raw, /Max-Age=3600/i);
  assert.doesNotMatch(raw, /; Secure/i);
  assert.equal(issued.response.headers['cache-control'], 'no-store');
  assert.ok(issued.data.challenge.signature);
  const second = await issue(app, issued.cookie);
  assert.notEqual(issued.data.challenge.parameters.data?.id, second.data.challenge.parameters.data?.id);
  const response = await submit(app, issued.cookie, issued.payload);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { success: true, message: 'CAPTCHA успешно проверена', his: issued.his });
});

test('missing CAPTCHA has a stable error code', async (t) => {
  const app = await setup(t);
  const response = await app.inject({ method: 'POST', url: '/api/demo/submit', payload: { message: 'Тест' } });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'CAPTCHA_MISSING');
});

test('tampered solution is rejected, original solution remains usable', async (t) => {
  const app = await setup(t);
  const issued = await issue(app);
  const changed = structuredClone(issued.data);
  changed.solution.counter++;
  const response = await submit(app, issued.cookie, encode(changed));
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'CAPTCHA_INVALID');
  assert.equal((await submit(app, issued.cookie, issued.payload)).statusCode, 200);
});

test('tampered HMAC signature, expiry, ID and cost are rejected', async (t) => {
  const app = await setup(t);
  const issued = await issue(app);
  const variants: Payload[] = [];
  const signature = structuredClone(issued.data);
  signature.challenge.signature = '0'.repeat(64);
  variants.push(signature);
  const expiry = structuredClone(issued.data);
  expiry.challenge.parameters.expiresAt = 1;
  variants.push(expiry);
  const cost = structuredClone(issued.data);
  cost.challenge.parameters.cost = 2 ** 31;
  variants.push(cost);
  const id = structuredClone(issued.data);
  id.challenge.parameters.data = { id: 'attacker-controlled-id' };
  variants.push(id);
  for (const changed of variants) {
    const response = await submit(app, issued.cookie, encode(changed));
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'CAPTCHA_INVALID');
  }
});

test('sequential reuse is rejected', async (t) => {
  const app = await setup(t);
  const issued = await issue(app);
  assert.equal((await submit(app, issued.cookie, issued.payload)).statusCode, 200);
  const response = await submit(app, issued.cookie, issued.payload);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'CAPTCHA_ALREADY_USED');
});

test('concurrent duplicate requests: exactly one consumes the challenge', async (t) => {
  const app = await setup(t);
  const issued = await issue(app);
  const responses = await Promise.all(Array.from({ length: 8 }, () => submit(app, issued.cookie, issued.payload)));
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(responses.filter((response) => response.json().code === 'CAPTCHA_ALREADY_USED').length, 7);
});

test('a different anonymous session cannot consume a valid payload', async (t) => {
  const app = await setup(t);
  const alice = await issue(app);
  const bob = await issue(app);
  assert.notEqual(alice.cookie, bob.cookie);
  const response = await submit(app, bob.cookie, alice.payload);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, 'CAPTCHA_SESSION_MISMATCH');
  assert.equal((await submit(app, alice.cookie, alice.payload)).statusCode, 200);
});

test('expired challenge uses controlled time and real ALTCHA verification', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const app = await setup(t, { challengeTtlSeconds: 1 });
  const issued = await issue(app);
  t.mock.timers.tick(2000);
  const response = await submit(app, issued.cookie, issued.payload);
  assert.equal(response.statusCode, 410);
  assert.equal(response.json().code, 'CAPTCHA_EXPIRED');
});

test('expired session is replaced; a supplied unknown session ID is not adopted', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const app = await setup(t, { sessionTtlSeconds: 1 });
  const issued = await issue(app);
  t.mock.timers.tick(2000);
  const response = await submit(app, issued.cookie, issued.payload);
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, 'CAPTCHA_SESSION_MISMATCH');
  assert.ok(response.headers['set-cookie']);
  const unknown = await issue(app, 'altcha_poc_sid=fixed-by-attacker');
  assert.doesNotMatch(String(unknown.response.headers['set-cookie']), /fixed-by-attacker/);
});

test('malformed payloads fail closed without a server error', async (t) => {
  const app = await setup(t);
  const issued = await issue(app);
  for (const value of ['not-base64!', 'e30=', { challenge: true }, 42, 'A'.repeat(17000), Buffer.from('null').toString('base64')]) {
    const response = await submit(app, issued.cookie, value);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'CAPTCHA_INVALID');
  }
});

test('expired tombstones are cleaned up and subsequently fail closed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const app = await setup(t, { challengeTtlSeconds: 1 });
  const issued = await issue(app);
  t.mock.timers.tick(302_000);
  await issue(app, issued.cookie); // Issue also runs cleanup without waiting for the interval.
  const response = await submit(app, issued.cookie, issued.payload);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().code, 'CAPTCHA_INVALID');
});

async function imageSetup(t: TestContext, options: Partial<AppOptions> = {}) {
  const answers: string[] = [];
  const app = await setup(t, {
    ...options, imageCaptcha: true,
    imageFactory: () => {
      // Observe the real generator only on the server side; verification is never mocked.
      const image = createImageChallenge();
      answers.push(image.code);
      return image;
    },
  });
  return { app, answers };
}

function verifyCode(app: Awaited<ReturnType<typeof buildApp>>, cookie: string, payload: string, code?: unknown) {
  return app.inject({ method: 'POST', url: '/api/captcha/verify', headers: { cookie }, payload: { payload, code } });
}

test('image CAPTCHA issues real PNG pixels and needs the code before submit', async (t) => {
  const { app, answers } = await imageSetup(t);
  const issued = await issue(app);
  assert.ok(issued.challenge.codeChallenge);
  assert.equal(issued.challenge.codeChallenge.length, 6);
  assert.deepEqual(Object.keys(issued.challenge.codeChallenge).sort(), ['image', 'length']);
  const png = Buffer.from(issued.challenge.codeChallenge.image.split(',')[1] ?? '', 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), 264);
  assert.equal(png.readUInt32BE(20), 88);
  assert.equal(issued.data.challenge.parameters.data?.codeRequired, true);
  const bypass = await submit(app, issued.cookie, issued.payload);
  assert.equal(bypass.statusCode, 403);
  assert.equal(bypass.json().code, 'CAPTCHA_CODE_REQUIRED');
  const verified = await verifyCode(app, issued.cookie, issued.payload, answers[0]?.toLowerCase());
  assert.equal(verified.statusCode, 200);
  assert.deepEqual(verified.json(), { verified: true });
  assert.equal((await submit(app, issued.cookie, issued.payload)).statusCode, 200);
  assert.equal((await submit(app, issued.cookie, issued.payload)).json().code, 'CAPTCHA_ALREADY_USED');
});

test('missing/wrong image code fails; three attempts lock the challenge', async (t) => {
  const { app, answers } = await imageSetup(t);
  const issued = await issue(app);
  const missing = await verifyCode(app, issued.cookie, issued.payload);
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.json(), { verified: false, reason: new CaptchaError('CAPTCHA_CODE_MISSING').message });
  for (let i = 0; i < 2; i++) {
    const response = await verifyCode(app, issued.cookie, issued.payload, '000000');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { verified: false, reason: new CaptchaError('CAPTCHA_CODE_INVALID').message });
  }
  const locked = await verifyCode(app, issued.cookie, issued.payload, '000000');
  assert.equal(locked.statusCode, 200);
  assert.deepEqual(locked.json(), { verified: false, reason: new CaptchaError('CAPTCHA_CODE_LOCKED').message });
  const stillLocked = await verifyCode(app, issued.cookie, issued.payload, answers[0]);
  assert.equal(stillLocked.statusCode, 200);
  assert.deepEqual(stillLocked.json(), { verified: false, reason: new CaptchaError('CAPTCHA_CODE_LOCKED').message });
  assert.equal((await submit(app, issued.cookie, issued.payload)).json().code, 'CAPTCHA_CODE_LOCKED');
});

test('an image code cannot be confirmed in another session', async (t) => {
  const { app, answers } = await imageSetup(t);
  const alice = await issue(app);
  const bob = await issue(app);
  const response = await verifyCode(app, bob.cookie, alice.payload, answers[0]);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { verified: false, reason: new CaptchaError('CAPTCHA_SESSION_MISMATCH').message });
  const accepted = await verifyCode(app, alice.cookie, alice.payload, answers[0]);
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), { verified: true });
});

test('removing the signed image requirement cannot bypass code verification', async (t) => {
  const { app } = await imageSetup(t);
  const issued = await issue(app);
  const changed = structuredClone(issued.data);
  assert.ok(changed.challenge.parameters.data);
  changed.challenge.parameters.data.codeRequired = false;
  assert.equal((await submit(app, issued.cookie, encode(changed))).json().code, 'CAPTCHA_INVALID');
  const invalid = await verifyCode(app, issued.cookie, issued.payload, { verified: true });
  assert.equal(invalid.statusCode, 200);
  assert.deepEqual(invalid.json(), { verified: false, reason: new CaptchaError('CAPTCHA_CODE_INVALID').message });
  assert.equal((await submit(app, issued.cookie, issued.payload)).json().code, 'CAPTCHA_CODE_REQUIRED');
});

test('a correct image code still requires real PoW and an unexpired challenge', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { app, answers } = await imageSetup(t, { challengeTtlSeconds: 1 });
  const issued = await issue(app);
  const changed = structuredClone(issued.data);
  changed.solution.counter++;
  const invalid = await verifyCode(app, issued.cookie, encode(changed), answers[0]);
  assert.equal(invalid.statusCode, 200);
  assert.deepEqual(invalid.json(), { verified: false, reason: new CaptchaError('CAPTCHA_INVALID').message });
  t.mock.timers.tick(2000);
  const expired = await verifyCode(app, issued.cookie, issued.payload, answers[0]);
  assert.equal(expired.statusCode, 200);
  assert.deepEqual(expired.json(), { verified: false, reason: new CaptchaError('CAPTCHA_EXPIRED').message });
});

test('image confirmation preserves atomic one-time submission', async (t) => {
  const { app, answers } = await imageSetup(t);
  const issued = await issue(app);
  const verified = await verifyCode(app, issued.cookie, issued.payload, answers[0]);
  assert.equal(verified.statusCode, 200);
  assert.deepEqual(verified.json(), { verified: true });
  const responses = await Promise.all(Array.from({ length: 8 }, () => submit(app, issued.cookie, issued.payload)));
  assert.equal(responses.filter((response) => response.statusCode === 200).length, 1);
  assert.equal(responses.filter((response) => response.json().code === 'CAPTCHA_ALREADY_USED').length, 7);
});

test('native HIS handshake and exact snapshot round-trip in the submit result', async (t) => {
  const app = await setup(t);
  const his: HisData = {
    focus: [[0, 0, 2, 0], [800, -1, 4, 1]],
    maxTouchPoints: 2,
    pointer: [[120, 250, 1050], [-2, 260, 1100]],
    scroll: [[0, 1300], [450, 1450]],
    time: Date.now(),
    touch: [[33, 47, 1600, 0.625, 9, 12]],
  };
  const issued = await issue(app, undefined, his);
  const response = await submit(app, issued.cookie, issued.payload);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().his, his);
  // No fabricated automation score is produced by the PoC.
  assert.equal(response.json().score, undefined);
  assert.equal(response.json().human, undefined);
});

test('HIS is required for challenge issuance; bad snapshots fail before issuing a challenge', async (t) => {
  const app = await setup(t);
  for (const his of [undefined, null]) {
    const response = await app.inject({ method: 'POST', url: '/api/captcha/challenge', payload: { his } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'HIS_MISSING');
    assert.equal(response.json().parameters, undefined);
  }
});

test('HIS validates numeric tuples, sample limits and exact keys without coercion', async (t) => {
  const app = await setup(t);
  const invalid = [
    {}, [], 'not HIS', 42,
    { ...emptyHis(), extra: 'field value must not be accepted' },
    { ...emptyHis(), time: '123' },
    { ...emptyHis(), time: -1 },
    { ...emptyHis(), maxTouchPoints: 1.5 },
    { ...emptyHis(), focus: [[0, 0, 2]] },
    { ...emptyHis(), focus: [[0, 0, 2, 2]] },
    { ...emptyHis(), pointer: [[1, 2, '100']] },
    { ...emptyHis(), pointer: Array.from({ length: 61 }, () => [1, 2, 3]) },
    { ...emptyHis(), scroll: [[1, 2, 3]] },
    { ...emptyHis(), touch: [[1, 2, 3, 2, 4, 5]] },
    { ...emptyHis(), pointer: [[1, 2, null]] },
  ];
  for (const his of invalid) {
    const response = await app.inject({ method: 'POST', url: '/api/captcha/challenge', payload: { his } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'HIS_INVALID');
    assert.equal(response.json().parameters, undefined);
  }
});

test('empty HIS is valid telemetry and is not treated as proof of a human', async (t) => {
  const app = await setup(t);
  const issued = await issue(app, undefined, emptyHis());
  const response = await submit(app, issued.cookie, issued.payload);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().his.pointer, []);
  assert.deepEqual(response.json().his.focus, []);
});

test('each challenge retains its own HIS; final submit cannot replace it', async (t) => {
  const app = await setup(t);
  const firstHis: HisData = { ...emptyHis(), pointer: [[10, 20, 100]] };
  const secondHis: HisData = { ...emptyHis(), pointer: [[30, 40, 200]] };
  const first = await issue(app, undefined, firstHis);
  const second = await issue(app, first.cookie, secondHis);
  assert.deepEqual((await submit(app, second.cookie, second.payload)).json().his, secondHis);
  const response = await app.inject({
    method: 'POST', url: '/api/demo/submit', headers: { cookie: first.cookie },
    payload: { message: 'Тест', altcha: first.payload, his: secondHis },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().his, firstHis);
});

test('another session and a replay cannot retrieve the stored HIS', async (t) => {
  const app = await setup(t);
  const alice = await issue(app, undefined, { ...emptyHis(), pointer: [[123, 456, 789]] });
  const bob = await issue(app);
  const mismatch = await submit(app, bob.cookie, alice.payload);
  assert.equal(mismatch.json().code, 'CAPTCHA_SESSION_MISMATCH');
  assert.equal(mismatch.json().his, undefined);
  assert.equal((await submit(app, alice.cookie, alice.payload)).statusCode, 200);
  const replay = await submit(app, alice.cookie, alice.payload);
  assert.equal(replay.json().code, 'CAPTCHA_ALREADY_USED');
  assert.equal(replay.json().his, undefined);
});
