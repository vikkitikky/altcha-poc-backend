import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { buildApp } from '../src/app.js';
import { MockCaptchaMs } from '../src/ms-captcha.js';

const context = { site_id: 'example', policy: 'default', action: 'submit' };
async function setup(t: TestContext) {
  const app = await buildApp({ hmacSecret: 'm'.repeat(64) });
  t.after(() => app.close());
  const issued = await app.inject({ method: 'POST', url: '/api/captcha/challenges', payload: context, headers: { 'x-poc-mock': '{"cost":10}' } });
  assert.equal(issued.statusCode, 200);
  const raw = issued.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0]!;
  const envelope = issued.json<{ challenge_id: string; challenge: Challenge }>();
  assert.equal('challenge' in envelope.challenge, false);
  const solution = await solveChallenge({ challenge: envelope.challenge, deriveKey });
  assert.ok(solution);
  const payload = Buffer.from(JSON.stringify({ challenge: envelope.challenge, solution })).toString('base64');
  const verify = (candidate = payload, changed = context, fault = {}) => app.inject({ method: 'POST', url: '/api/captcha/verifications',
    payload: { ...changed, payload: candidate }, headers: { cookie, 'x-poc-mock': JSON.stringify(fault) } });
  const submit = (mode: string, candidate: string, changed = context, fault = {}) => app.inject({ method: 'POST', url: '/api/business/submit',
    payload: { ...changed, mode, name: 'Test', message: 'Hello' }, headers: { cookie, 'x-captcha-payload': candidate, 'x-poc-mock': JSON.stringify(fault) } });
  return { app, cookie, payload, verify, submit, envelope };
}

for (const mode of ['pow', 'record'] as const) {
  test(`MS ${mode}: real PoW, preliminary record, business success, replay and cross-mode reuse`, async (t) => {
    const f = await setup(t);
    const verified = await f.verify();
    assert.equal(verified.statusCode, 200);
    const record = verified.json();
    assert.equal(record.verified, true);
    assert.match(record.verification_id, /^[a-f0-9-]{36}$/);
    assert.equal('payload' in record, false);
    const same = await f.verify();
    assert.equal(same.json().verification_id, record.verification_id);
    const candidate = mode === 'pow' ? f.payload : record.verification_id;
    const first = await f.submit(mode, candidate);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().internal_call.transport, 'in-process');
    assert.equal((await f.submit(mode, candidate)).json().code, 'ALREADY_USED');
    assert.equal((await f.submit(mode === 'pow' ? 'record' : 'pow', mode === 'pow' ? record.verification_id : f.payload)).json().code, 'ALREADY_USED');
  });
}

test('MS validates actual solution/signature, context, unknown record, mode and session', async (t) => {
  const f = await setup(t);
  const decoded = JSON.parse(Buffer.from(f.payload, 'base64').toString());
  decoded.solution.derivedKey = '0'.repeat(64);
  assert.equal((await f.verify(Buffer.from(JSON.stringify(decoded)).toString('base64'))).json().error, 'SOLUTION_INVALID');
  decoded.challenge.signature = '0'.repeat(64);
  assert.equal((await f.verify(Buffer.from(JSON.stringify(decoded)).toString('base64'))).json().error, 'CHALLENGE_INVALID');
  assert.equal((await f.verify(f.payload, { ...context, action: 'other' })).json().error, 'CONTEXT_MISMATCH');
  assert.equal((await f.submit('record', 'arbitrary-id')).json().code, 'VERIFICATION_UNKNOWN');
  assert.equal((await f.submit('token', 'arbitrary-id')).statusCode, 400);
  const record = (await f.verify()).json();
  assert.equal((await f.submit('record', record.verification_id, { ...context, policy: 'other' })).json().code, 'CONTEXT_MISMATCH');
  const mismatch = await f.app.inject({ method: 'POST', url: '/api/captcha/verifications', payload: { ...context, payload: f.payload } });
  assert.equal(mismatch.json().error, 'SESSION_MISMATCH');
  for (const payload of ['', 'garbage', 'bnVsbA==', 'e30=', 'W10=']) assert.equal((await f.verify(payload)).statusCode, 400);
  assert.equal((await f.verify()).statusCode, 200);
});

test('MS expiration enforced for both evidence modes; simultaneous consumption admits exactly one', async () => {
  let now = Date.now();
  const store = new MockCaptchaMs('s'.repeat(64), () => now);
  const envelope = await store.issue(context, 'session', 120, 10);
  const solution = await solveChallenge({ challenge: envelope.challenge, deriveKey });
  assert.ok(solution);
  const payload = Buffer.from(JSON.stringify({ challenge: envelope.challenge, solution })).toString('base64');
  const verification = await store.preverify(payload, context, 'session');
  const raced = await Promise.allSettled([
    store.authorize('pow', payload, context, 'session'), store.authorize('record', verification.verification_id, context, 'session'),
  ]);
  assert.equal(raced.filter((r) => r.status === 'fulfilled').length, 1);
  now += 121_000;
  await assert.rejects(store.authorize('pow', payload, context, 'session'), /EXPIRED/);
  await assert.rejects(store.authorize('record', verification.verification_id, context, 'session'), /EXPIRED/);
});

test('MS fault injection preserves 400/500/false200 and delay; business can reject successful CAPTCHA', async (t) => {
  const f = await setup(t);
  for (const code of ['400', '500', 'false200']) {
    const response = await f.verify(f.payload, context, { verificationFault: code });
    assert.equal(response.statusCode, code === 'false200' ? 200 : Number(code));
    assert.equal(response.json().verified, false);
  }
  const started = performance.now();
  assert.equal((await f.verify(f.payload, context, { delay: 30 })).statusCode, 200);
  assert.ok(performance.now() - started >= 25);
  const business = await f.submit('pow', f.payload, context, { businessDeny: true });
  assert.equal(business.statusCode, 422);
  assert.equal(business.json().captcha.allowed, true);
  assert.equal(business.json().success, false);
  assert.equal((await f.submit('pow', f.payload)).json().code, 'ALREADY_USED');
});
