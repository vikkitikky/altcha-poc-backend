import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { fixture, hisSnapshot, startRedis, testConfig } from './helpers/redis.js';
import { RedisStore } from '../src/store.js';
import { validateConfig } from '../src/config.js';
import { policyRevision } from '../src/service.js';
import { parseHis } from '../src/his.js';

let redis: Awaited<ReturnType<typeof startRedis>>;
before(async () => { redis = await startRedis(); });
after(async () => { await redis?.stop(); });
const context = { site_id: 'example', action: 'submit_form', policy: 'standard' };
const challengeUrl = '/api/captcha/challenge?site_id=example&action=submit_form';
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function isolated(run: (f: Fixture) => Promise<void>, config = testConfig()) {
  const f = await fixture(redis.url, config);
  try { await run(f); } finally { await f.close(); }
}
async function issue(f: Fixture, url = challengeUrl): Promise<Challenge> {
  const result = await f.app.inject({ method: 'GET', url });
  assert.equal(result.statusCode, 200, result.body);
  return result.json() as Challenge;
}
async function solve(challenge: Challenge) {
  const solution = await solveChallenge({ challenge, deriveKey });
  assert.ok(solution);
  return Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
}
const verify = (f: Fixture, payload: string) => f.app.inject({ method: 'POST', url: '/api/captcha/verify', payload: { payload } });
const validate = (f: Fixture, payload: string, expected = context, auth = `Bearer ${f.config.clients.business!.secret}`) =>
  f.app.inject({ method: 'POST', url: '/internal/captcha/validate', headers: { authorization: auth }, payload: { payload, ...expected } });
async function token(f: Fixture, url = challengeUrl): Promise<string> {
  const result = await verify(f, await solve(await issue(f, url)));
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().verified, true);
  return result.json().payload as string;
}

test('root modern challenge → PBKDF2 solution → signed token → authenticated single-use validation', async () => isolated(async (f) => {
  const challenge = await issue(f);
  assert.deepEqual(Object.keys(challenge).sort(), ['parameters', 'signature']);
  assert.equal(challenge.parameters.algorithm, 'PBKDF2/SHA-256');
  assert.ok(challenge.parameters.expiresAt! > Date.now() / 1000);
  assert.ok(challenge.parameters.expiresAt! < Date.now() / 1000 + 121);
  const pow = await solve(challenge);
  const result = await verify(f, pow);
  assert.equal(result.statusCode, 200, result.body);
  const payload = result.json().payload as string;
  assert.notEqual(payload, pow);
  const claims = decodeJwt(payload);
  assert.equal(claims.site_id, 'example'); assert.equal(claims.action, 'submit_form'); assert.equal(claims.policy, 'standard');
  assert.equal(claims.exp! - claims.iat!, 60); assert.ok(claims.jti);
  assert.equal((await validate(f, payload)).json().valid, true);
  assert.equal((await validate(f, payload)).statusCode, 400);
  assert.equal((await verify(f, pow)).json().error, 'POW_REPLAYED');
}));

test('site/action/policy allowlist and optional default action; query extras and duplicates rejected', async () => isolated(async (f) => {
  assert.equal((await issue(f, '/api/captcha/challenge?site_id=example')).parameters.data!.action, 'submit_form');
  for (const query of ['', '?site_id=unknown', '?site_id=__proto__', '?site_id=example&action=unknown',
    '?site_id=example&action=constructor', '?site_id=example&action=sensitive&policy=standard',
    '?site_id=example&action=submit_form&foo=1', '?site_id=example&site_id=other']) {
    assert.equal((await f.app.inject({ url: `/api/captcha/challenge${query}` })).statusCode, 400, query);
  }
  const strict = await issue(f, '/api/captcha/challenge?site_id=example&action=sensitive');
  assert.equal(strict.parameters.cost, 20); assert.equal(strict.parameters.data!.policy, 'strict');
}));

test('tampered challenge signature, context, cost and expiry are rejected without using PoW', async () => isolated(async (f) => {
  const challenge = await issue(f);
  const original = JSON.parse(Buffer.from(await solve(challenge), 'base64').toString());
  for (const change of [
    (v: typeof original) => { v.challenge.signature = '0'.repeat(64); },
    (v: typeof original) => { v.challenge.parameters.data.site_id = 'other'; },
    (v: typeof original) => { v.challenge.parameters.data.action = 'sensitive'; },
    (v: typeof original) => { v.challenge.parameters.cost = 100000000; },
    (v: typeof original) => { v.challenge.parameters.expiresAt += 3600; },
  ]) {
    const value = structuredClone(original); change(value);
    assert.equal((await verify(f, Buffer.from(JSON.stringify(value)).toString('base64'))).json().error, 'CHALLENGE_TAMPERED');
  }
  assert.equal((await verify(f, Buffer.from(JSON.stringify(original)).toString('base64'))).statusCode, 200);
}));

test('invalid base64, v1, malformed solutions and incorrect PoW fail; no fake verification', async () => isolated(async (f) => {
  for (const value of ['!', 'e30=', Buffer.from(JSON.stringify({ algorithm: 'SHA-256', number: 1 })).toString('base64')]) {
    assert.equal((await verify(f, value)).statusCode, 400);
  }
  const original = JSON.parse(Buffer.from(await solve(await issue(f)), 'base64').toString());
  for (const counter of [-1, '1', 1.5, 4294967296]) {
    const value = structuredClone(original); value.solution.counter = counter;
    assert.equal((await verify(f, Buffer.from(JSON.stringify(value)).toString('base64'))).json().error, 'PAYLOAD_INVALID');
  }
  original.solution.derivedKey = '0'.repeat(64);
  assert.equal((await verify(f, Buffer.from(JSON.stringify(original)).toString('base64'))).json().error, 'POW_INVALID');
}));

test('concurrent public verification and internal consumption across replicas have one winner', async () => isolated(async (f) => {
  const replica = await fixture(redis.url, f.config, f.namespace);
  try {
    const pow = await solve(await issue(f));
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => verify(i % 2 ? f : replica, pow)));
    const winners = results.filter((r) => r.statusCode === 200);
    assert.equal(winners.length, 1);
    const payload = winners[0]!.json().payload as string;
    const used = await Promise.all(Array.from({ length: 16 }, (_, i) => validate(i % 2 ? f : replica, payload)));
    assert.equal(used.filter((r) => r.statusCode === 200).length, 1);
  } finally { await replica.close(); }
}));

test('service auth, site scope and context are checked before consuming token', async () => isolated(async (f) => {
  const payload = await token(f);
  assert.equal((await validate(f, payload, context, 'Bearer wrong')).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/internal/captcha/validate', payload: { payload, ...context } })).statusCode, 401);
  assert.equal((await validate(f, payload, { ...context, site_id: 'other' })).statusCode, 403);
  assert.equal((await validate(f, payload, { ...context, action: 'sensitive', policy: 'strict' })).json().error, 'CONTEXT_MISMATCH');
  assert.equal((await validate(f, payload)).statusCode, 200);
}));

test('token tampering, expired/wrong-issuer/unsigned tokens rejected; original remains usable', async () => isolated(async (f) => {
  const payload = await token(f);
  const chunks = payload.split('.'); chunks[1] = Buffer.from(JSON.stringify({ ...decodeJwt(payload), action: 'sensitive' })).toString('base64url');
  assert.equal((await validate(f, chunks.join('.'))).json().error, 'TOKEN_INVALID');
  const now = Math.floor(Date.now() / 1000);
  for (const [iss, exp] of [['wrong', now + 60], ['captcha-ms', now - 1]] as const) {
    const invalid = await new SignJWT({ ...context, policy_revision: policyRevision(f.config, context), v: 1, his_received: false }).setProtectedHeader({ alg: 'HS256', kid: 't1', typ: 'JWT' })
      .setIssuer(iss).setAudience('business-ms').setJti(randomUUID()).setIssuedAt(now - 10).setExpirationTime(exp)
      .sign(new TextEncoder().encode(f.config.tokenKeys.keys.t1!));
    assert.equal((await validate(f, invalid)).json().error, 'TOKEN_INVALID');
  }
  assert.equal((await validate(f, `${Buffer.from('{"alg":"none"}').toString('base64url')}.${chunks[1]}.`)).statusCode, 400);
  assert.equal((await validate(f, payload)).statusCode, 200);
}));

test('even a correctly signed but unissued token has no Redis permit', async () => isolated(async (f) => {
  const now = Math.floor(Date.now() / 1000);
  const unissued = await new SignJWT({ ...context, policy_revision: policyRevision(f.config, context), v: 1, his_received: false })
    .setProtectedHeader({ alg: 'HS256', kid: 't1', typ: 'JWT' }).setIssuer('captcha-ms').setAudience('business-ms')
    .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + 60).sign(new TextEncoder().encode(f.config.tokenKeys.keys.t1!));
  assert.equal((await validate(f, unissued)).json().error, 'TOKEN_NOT_USABLE');
}));

test('challenge and verification-token TTL enforced by Redis and JWT', async () => {
  const config = testConfig(); config.policies.standard!.challengeTtl = 2; config.policies.standard!.tokenTtl = 2;
  await isolated(async (f) => {
    const pow = await solve(await issue(f));
    const payload = await token(f);
    await delay(2100);
    assert.equal((await verify(f, pow)).json().error, 'CHALLENGE_NOT_USABLE');
    assert.equal((await validate(f, payload)).json().error, 'TOKEN_INVALID');
  }, config);
});

test('key rotation keeps old challenges/tokens usable while new issuance uses active kids', async () => isolated(async (f) => {
  const pow = await solve(await issue(f)); const oldToken = await token(f);
  const rotated = structuredClone(f.config);
  rotated.challengeKeys = { active: 'c2', keys: { ...rotated.challengeKeys.keys, c2: 'new-challenge-secret'.repeat(3) } };
  rotated.tokenKeys = { active: 't2', keys: { ...rotated.tokenKeys.keys, t2: 'new-token-secret'.repeat(3) } };
  const next = await fixture(redis.url, rotated, f.namespace);
  try {
    assert.equal((await validate(next, oldToken)).statusCode, 200);
    const verified = await verify(next, pow); assert.equal(verified.statusCode, 200, verified.body);
    assert.equal(decodeProtectedHeader(verified.json().payload).kid, 't2');
    assert.equal((await issue(next)).parameters.data!.kid, 'c2');
  } finally { await next.close(); }
}));

test('retired challenge and token keys fail closed', async () => isolated(async (f) => {
  const pow = await solve(await issue(f)); const payload = await token(f);
  const config = structuredClone(f.config);
  config.challengeKeys = { active: 'c2', keys: { c2: 'new-challenge-key'.repeat(3) } };
  config.tokenKeys = { active: 't2', keys: { t2: 'new-token-key'.repeat(3) } };
  const next = await fixture(redis.url, config, f.namespace);
  try {
    assert.equal((await verify(next, pow)).json().error, 'KEY_RETIRED');
    assert.equal((await validate(next, payload)).json().error, 'TOKEN_INVALID');
  } finally { await next.close(); }
}));

test('HIS disabled: GET issues challenge and unsolicited POST is rejected', async () => isolated(async (f) => {
  assert.equal((await issue(f)).parameters.data!.his_received, false);
  const response = await f.app.inject({ method: 'POST', url: challengeUrl, payload: { his: hisSnapshot() } });
  assert.equal(response.json().error, 'HIS_DISABLED');
}));

test('HIS native GET handshake preserves effective context, POST accepts snapshot and PoW continues', async () => isolated(async (f) => {
  const handshake = await f.app.inject({ url: challengeUrl });
  assert.deepEqual(handshake.json(), { his: { url: '/api/captcha/challenge?site_id=example&action=submit_form&policy=standard' } });
  const url = handshake.json().his.url as string;
  for (const payload of [{}, { his: null }, { his: {} }, { his: { ...hisSnapshot(), botScore: 0.1 } },
    { his: { ...hisSnapshot(), pointer: Array(61).fill([1, 2, 3]) } }]) {
    assert.equal((await f.app.inject({ method: 'POST', url, payload })).statusCode, 400);
  }
  const response = await f.app.inject({ method: 'POST', url, payload: { his: hisSnapshot() } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().parameters.data.his_received, true);
  const verified = await verify(f, await solve(response.json()));
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(decodeJwt(verified.json().payload).his_received, true);
  assert.equal((await validate(f, verified.json().payload)).statusCode, 200);
}, testConfig(true)));

test('HIS parser enforces native row widths, numeric types and bounds', () => {
  assert.deepEqual(parseHis(hisSnapshot()).pointer, [[10, 20, 50]]);
  for (const his of [{ ...hisSnapshot(), pointer: [[1, 2]] }, { ...hisSnapshot(), time: 'now' },
    { ...hisSnapshot(), touch: [[1, 2, 3, 2, 4, 5]] }, { ...hisSnapshot(), focus: [[0, 0, 11, 1]] }]) assert.throws(() => parseHis(his));
});

test('CORS preflight and per-site Origin checks; failed origin cannot consume proof', async () => isolated(async (f) => {
  const preflight = await f.app.inject({ method: 'OPTIONS', url: challengeUrl, headers: { origin: 'http://localhost:3000',
    'access-control-request-method': 'GET', 'access-control-request-headers': 'content-type' } });
  assert.equal(preflight.statusCode, 204); assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:3000');
  assert.equal((await f.app.inject({ url: challengeUrl, headers: { origin: 'http://evil.test' } })).statusCode, 403);
  assert.equal((await f.app.inject({ url: challengeUrl, headers: { origin: 'http://other.test' } })).statusCode, 403);
  const pow = await solve(await issue(f));
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/captcha/verify', headers: { origin: 'http://other.test' }, payload: { payload: pow } })).statusCode, 403);
  assert.equal((await verify(f, pow)).statusCode, 200);
}));

test('shared Redis rate limit survives replica change and does not trust X-Forwarded-For', async () => {
  const first = await fixture(redis.url, testConfig(), randomUUID(), 2);
  const second = await fixture(redis.url, first.config, first.namespace, 2);
  try {
    await issue(first); await issue(second);
    const result = await second.app.inject({ url: challengeUrl, headers: { 'x-forwarded-for': '1.2.3.4' } });
    assert.equal(result.statusCode, 429); assert.equal(result.headers['retry-after'], '60');
  } finally { await first.close(); await second.close(); }
});

test('Redis unavailable: challenge, verify, consume and readiness fail closed', async () => isolated(async (f) => {
  const pow = await solve(await issue(f)); const payload = await token(f);
  await f.store.close();
  for (const response of [await f.app.inject({ url: challengeUrl }), await verify(f, pow), await validate(f, payload), await f.app.inject({ url: '/api/health' })]) {
    assert.equal(response.statusCode, 503); assert.equal(response.json().error, 'STORAGE_UNAVAILABLE');
  }
}));

test('Redis permits survive app restart; consumed tokens remain consumed', async () => isolated(async (f) => {
  const payload = await token(f);
  const second = await fixture(redis.url, f.config, f.namespace);
  try {
    assert.equal((await validate(second, payload)).statusCode, 200);
    assert.equal((await validate(f, payload)).json().error, 'TOKEN_NOT_USABLE');
  } finally { await second.close(); }
}));

test('body size, extra verification fields and unexpected code in pow mode are explicit errors', async () => isolated(async (f) => {
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/captcha/verify', payload: { payload: 'x'.repeat(40000) } })).statusCode, 413);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/captcha/verify', payload: { payload: 'x', his: hisSnapshot() } })).statusCode, 400);
  const pow = await solve(await issue(f));
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/captcha/verify', payload: { payload: pow, code: '1234' } })).json().error, 'CODE_UNEXPECTED');
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/captcha/verify', payload: { payload: pow, fields: { message: 'native optional field' }, timeZone: 'Europe/Moscow' } })).statusCode, 200);
}));

test('configuration rejects graphics, shared signing keys, missing active key and unsafe bounds', async () => {
  for (const mutate of [
    (c: ReturnType<typeof testConfig>) => { c.policies.standard!.graphics = true; },
    (c: ReturnType<typeof testConfig>) => { c.tokenKeys.keys.t1 = c.challengeKeys.keys.c1!; },
    (c: ReturnType<typeof testConfig>) => { c.tokenKeys.active = 'missing'; },
    (c: ReturnType<typeof testConfig>) => { c.policies.standard!.cost = 0; },
    (c: ReturnType<typeof testConfig>) => { c.sites.example!.origins = ['*']; },
  ]) { const config = testConfig(); mutate(config); assert.throws(() => validateConfig(config)); }
  await assert.rejects(() => RedisStore.connect('redis://127.0.0.1:1'), { code: 'STORAGE_UNAVAILABLE' });
});

test('policy revision prevents accepting stale challenges and tokens after same-name policy changes', async () => isolated(async (f) => {
  const pow = await solve(await issue(f)); const payload = await token(f);
  const config = structuredClone(f.config); config.policies.standard!.tokenTtl = 30;
  const updated = await fixture(redis.url, config, f.namespace);
  try {
    assert.equal((await verify(updated, pow)).json().error, 'POLICY_MISMATCH');
    assert.equal((await validate(updated, payload)).json().error, 'POLICY_MISMATCH');
  } finally { await updated.close(); }
}));

test('a correctly derived key for an unsolved counter must not bypass the signed keyPrefix', async () => isolated(async (f) => {
  const challenge = await issue(f);
  const password = Buffer.alloc(20);
  Buffer.from(challenge.parameters.nonce, 'hex').copy(password);
  password.writeUInt32BE(0, 16);
  const { derivedKey } = await deriveKey(challenge.parameters, Buffer.from(challenge.parameters.salt, 'hex'), password);
  const hex = Buffer.from(derivedKey).toString('hex');
  assert.equal(hex.startsWith(challenge.parameters.keyPrefix), false);
  const payload = Buffer.from(JSON.stringify({ challenge, solution: { counter: 0, derivedKey: hex } })).toString('base64');
  assert.equal((await verify(f, payload)).json().error, 'POW_INVALID');
}));
