import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { decodeJwt } from 'jose';
import { fixture, hisSnapshot, startRedis, testConfig } from './helpers/redis.js';
import { CanvasImageGenerator, imageAlphabet, type CaptchaImage, type ImageGenerator } from '../src/image.js';
import { configFromEnv, defaultImageSettings, validateConfig } from '../src/config.js';

let redis: Awaited<ReturnType<typeof startRedis>>;
before(async () => { redis = await startRedis(); });
after(async () => { await redis?.stop(); });
const context = { site_id: 'example', action: 'submit_form', policy: 'standard' };
const url = '/api/captcha/challenge?site_id=example';
function imageConfig(hisEnabled = false) {
  const c = testConfig(hisEnabled); c.image = { ...defaultImageSettings, enabled: true };
  c.policies.standard!.mode = 'pow+image'; return c;
}
async function isolated(run: (f: Awaited<ReturnType<typeof fixture>>, answers: CaptchaImage[]) => Promise<void>, config = imageConfig()) {
  const answers: CaptchaImage[] = [];
  const generator = new CanvasImageGenerator();
  const provider: ImageGenerator = { async generate(length) { const result = await generator.generate(length); answers.push(result); return result; } };
  const f = await fixture(redis.url, config, randomUUID(), 10000, provider);
  try { await run(f, answers); } finally { await f.close(); }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function issue(f: Fixture) {
  const r = await f.app.inject(f.config.hisEnabled ? { method: 'POST', url, payload: { his: hisSnapshot() } } : { method: 'GET', url });
  assert.equal(r.statusCode, 200, r.body); return r.json() as Challenge;
}
async function solve(challenge: Challenge) {
  const solution = await solveChallenge({ challenge, deriveKey }); assert.ok(solution);
  const { parameters, signature } = challenge;
  return Buffer.from(JSON.stringify({ challenge: { parameters, signature }, solution })).toString('base64');
}
const verify = (f: Fixture, payload: string, code?: string) => f.app.inject({ method: 'POST', url: '/api/captcha/verify', payload: { payload, ...(code === undefined ? {} : { code }) } });
const wrong = (answer: string) => (answer[0] === 'A' ? 'C' : 'A') + answer.slice(1);
async function state(f: Fixture, id: string) {
  const client = createClient({ url: redis.url }); await client.connect();
  try {
    const prefix = `captcha:{${f.namespace}}:`;
    return { image: await client.hGetAll(`${prefix}image:${id}`), pow: await client.get(`${prefix}pow-used:${id}`),
      permits: await client.keys(`${prefix}token:*`), record: await client.get(`${prefix}challenge:${id}`) };
  } finally { client.destroy(); }
}

test('real PNG generation: bounded raster/size, safe alphabet, random images and no plaintext answer in public/stored data', async () => isolated(async (f, answers) => {
  const challenge = await issue(f); const answer = answers.at(-1)!;
  assert.equal(answer.answer.length, 5); assert.ok([...answer.answer].every(c => imageAlphabet.includes(c)));
  const png = Buffer.from(challenge.codeChallenge!.image.split(',')[1]!, 'base64');
  assert.equal(png.readUInt32BE(16), 208); assert.equal(png.readUInt32BE(20), 88); assert.ok(png.length <= 32768);
  assert.equal(challenge.codeChallenge!.length, 5); assert.equal(JSON.stringify(challenge).includes(answer.answer), false);
  const stored = await state(f, String(challenge.parameters.data!.challenge_id));
  assert.equal(stored.image.state, 'pending'); assert.equal(stored.image.attempts, '0');
  assert.match(stored.image.digest!, /^[0-9a-f]{64}$/); assert.equal(JSON.stringify(stored).includes(answer.answer), false);
  const next = await issue(f); assert.notEqual(next.codeChallenge!.image, challenge.codeChallenge!.image);
  assert.notEqual(next.parameters.data!.image_id, challenge.parameters.data!.image_id);
}));

test('PoW + correct image returns signed full-verification token and one-time internal success', async () => isolated(async (f, answers) => {
  const challenge = await issue(f); const pow = await solve(challenge);
  const result = await verify(f, pow, ` ${answers.at(-1)!.answer.toLowerCase()} `);
  assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().verified, true);
  const token = result.json().payload as string; const claims = decodeJwt(token);
  assert.equal(claims.captcha_mode, 'pow+image'); assert.equal(claims.image_verified, true);
  assert.equal(claims.image_id, challenge.parameters.data!.image_id);
  const call = () => f.app.inject({ method: 'POST', url: '/internal/captcha/validate', headers: { authorization: `Bearer ${f.config.clients.business!.secret}` }, payload: { payload: token, ...context } });
  assert.equal((await call()).statusCode, 200); assert.equal((await call()).statusCode, 400);
  const replay = await verify(f, pow, answers.at(-1)!.answer);
  assert.equal(replay.json().verified, false); assert.equal(replay.json().payload, undefined);
}));

test('missing/malformed code and invalid PoW issue no token and do not prematurely consume the proof/image', async () => isolated(async (f, answers) => {
  const challenge = await issue(f); const pow = await solve(challenge); const id = String(challenge.parameters.data!.challenge_id);
  for (const code of [undefined, '', 'IO01L', 'A'.repeat(4)]) {
    const r = await verify(f, pow, code); assert.equal(r.statusCode, 200); assert.equal(r.json().verified, false); assert.equal(r.json().payload, undefined);
  }
  const invalid = JSON.parse(Buffer.from(pow, 'base64').toString()); invalid.solution.derivedKey = '0'.repeat(64);
  assert.equal((await verify(f, Buffer.from(JSON.stringify(invalid)).toString('base64'), answers.at(-1)!.answer)).json().reason, 'POW_INVALID');
  const snapshot = await state(f,id); assert.equal(snapshot.image.attempts, '0'); assert.equal(snapshot.pow,null); assert.equal(snapshot.permits.length,0);
  assert.equal((await verify(f,pow,answers.at(-1)!.answer)).json().verified,true);
}));

test('wrong image closes exactly that image, leaves PoW unconsumed, requires fresh challenge for next answer', async () => isolated(async (f, answers) => {
  const challenge = await issue(f); const pow = await solve(challenge); const answer = answers.at(-1)!.answer;
  const r = await verify(f, pow, wrong(answer)); assert.equal(r.statusCode,200); assert.deepEqual(r.json(),{verified:false,reason:'IMAGE_INCORRECT'});
  const id=String(challenge.parameters.data!.challenge_id); const snapshot=await state(f,id);
  assert.equal(snapshot.image.attempts,'1'); assert.equal(snapshot.image.state,'failed'); assert.equal(snapshot.pow,null); assert.equal(snapshot.permits.length,0);
  assert.equal((await verify(f,pow,answer)).json().reason,'IMAGE_ALREADY_ATTEMPTED');
  assert.equal((await state(f,id)).image.attempts,'1');
  const next = await issue(f); assert.notEqual(next.parameters.data!.challenge_id,id);
  assert.equal((await verify(f,await solve(next),answers.at(-1)!.answer)).json().verified,true);
}));

test('image attempt quota spans fresh challenges per IP; exhaustion does not consume pending image/PoW', async () => {
  const c=imageConfig();c.image!.rateLimit=2;
  await isolated(async (f,answers)=>{
    for(let i=0;i<2;i++){const ch=await issue(f);assert.equal((await verify(f,await solve(ch),wrong(answers.at(-1)!.answer))).json().reason,'IMAGE_INCORRECT');}
    const ch=await issue(f);const result=await verify(f,await solve(ch),answers.at(-1)!.answer);
    assert.equal(result.json().reason,'IMAGE_RATE_LIMITED');assert.equal(result.json().payload,undefined);
    const snapshot=await state(f,String(ch.parameters.data!.challenge_id));assert.equal(snapshot.image.attempts,'0');assert.equal(snapshot.pow,null);
  },c);
});

test('image TTL bounds signed challenge expiry and all image state expires', async()=>{
  const c=imageConfig();c.image!.ttl=2;
  await isolated(async(f,answers)=>{
    const ch=await issue(f); assert.ok(ch.parameters.expiresAt!<=Date.now()/1000+2);
    const pow=await solve(ch);await delay(2100);
    const r=await verify(f,pow,answers.at(-1)!.answer);assert.equal(r.json().verified,false);assert.equal(r.json().payload,undefined);
    const snapshot=await state(f,String(ch.parameters.data!.challenge_id));assert.deepEqual(snapshot.image,{});assert.equal(snapshot.pow,null);
  },c);
});

test('parallel correct requests across replicas issue one token and record one image attempt',async()=>isolated(async(f,answers)=>{
  const ch=await issue(f);const pow=await solve(ch);const answer=answers.at(-1)!.answer;
  const other=await fixture(redis.url,f.config,f.namespace);
  try {
    const results=await Promise.all(Array.from({length:16},(_,i)=>verify(i%2?f:other,pow,answer)));
    assert.equal(results.filter(r=>r.json().verified===true).length,1);
    const snapshot=await state(f,String(ch.parameters.data!.challenge_id));assert.equal(snapshot.image.attempts,'1');assert.equal(snapshot.image.state,'completed');assert.equal(snapshot.pow,'1');assert.equal(snapshot.permits.length,1);
  } finally {await other.close();}
}));

test('parallel wrong/correct submissions have at most one completion and cannot reopen failed image',async()=>isolated(async(f,answers)=>{
  const ch=await issue(f);const pow=await solve(ch);const answer=answers.at(-1)!.answer;
  const results=await Promise.all(Array.from({length:12},(_,i)=>verify(f,pow,i%2?answer:wrong(answer))));
  const wins=results.filter(r=>r.json().verified===true).length;assert.ok(wins<=1);
  const snapshot=await state(f,String(ch.parameters.data!.challenge_id));assert.equal(snapshot.image.attempts,'1');
  assert.equal(snapshot.permits.length,wins);assert.equal(snapshot.pow,wins?'1':null);
  assert.equal((await verify(f,pow,answer)).json().verified,false);
}));

test('image mode composes with native HIS challenge request',async()=>isolated(async(f,answers)=>{
  const handshake=await f.app.inject({url});assert.ok(handshake.json().his);
  const ch=await issue(f);const r=await verify(f,await solve(ch),answers.at(-1)!.answer);
  assert.equal(r.json().verified,true);assert.equal(decodeJwt(r.json().payload).his_received,true);
},imageConfig(true)));

test('image generation/storage failures remain fail-closed; image provider is unused in pow mode',async()=>{
  const provider:ImageGenerator={async generate(){throw new Error('Test-only generator failure');}};
  const image=await fixture(redis.url,imageConfig(),randomUUID(),10000,provider);
  const pow=await fixture(redis.url,testConfig(),randomUUID(),10000,provider);
  try {
    assert.equal((await image.app.inject({url})).statusCode,500);
    assert.equal((await pow.app.inject({url})).statusCode,200);
    await image.store.close();assert.equal((await image.app.inject({url})).statusCode,503);
  } finally {await image.close();await pow.close();}
});

test('isolated generator enforces deadline, concurrency, length and maximum PNG size',async()=>{
  await assert.rejects(()=>new CanvasImageGenerator(1).generate(5),{code:'IMAGE_GENERATION_TIMEOUT'});
  const generator=new CanvasImageGenerator();await assert.rejects(()=>generator.generate(100),{code:'IMAGE_GENERATION_FAILED'});
  const results=await Promise.allSettled([generator.generate(4),generator.generate(8),generator.generate(5)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='IMAGE_GENERATOR_BUSY').length,1);
});

test('configuration preserves pow defaults and rejects inapplicable per-image max attempts or unsafe settings',()=>{
  const c=imageConfig();const env={CHALLENGE_KEYS_JSON:JSON.stringify(c.challengeKeys),TOKEN_KEYS_JSON:JSON.stringify(c.tokenKeys),INTERNAL_CLIENTS_JSON:JSON.stringify(c.clients),SITES_JSON:JSON.stringify(c.sites)};
  assert.equal(configFromEnv(env).policies.standard!.mode,undefined);
  assert.equal(configFromEnv({...env,CAPTCHA_IMAGE_ENABLED:'true'}).policies.strict!.mode,'pow+image');
  assert.throws(()=>configFromEnv({...env,CAPTCHA_IMAGE_MAX_ATTEMPTS:'3'}));
  c.image!.length=9;assert.throws(()=>validateConfig(c));c.image!.length=5;c.image!.enabled=false;assert.throws(()=>validateConfig(c));
});
