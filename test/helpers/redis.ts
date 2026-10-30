import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { RedisStore } from '../../src/store.js';
import { buildApp } from '../../src/app.js';
import { type CaptchaConfig } from '../../src/config.js';

export function testConfig(hisEnabled = false): CaptchaConfig {
  return {
    challengeKeys: { active: 'c1', keys: { c1: 'challenge-test-secret-'.repeat(3) } },
    tokenKeys: { active: 't1', keys: { t1: 'token-test-secret-'.repeat(3) } },
    clients: { business: { secret: 'service-test-secret-'.repeat(3), sites: ['example'] } },
    sites: {
      example: { defaultAction: 'submit_form', actions: { submit_form: 'standard', sensitive: 'strict' }, origins: ['http://localhost:3000'] },
      other: { defaultAction: 'submit_form', actions: { submit_form: 'standard' }, origins: ['http://other.test'] },
    },
    policies: {
      standard: { cost: 10, counterMin: 1, counterMax: 3, challengeTtl: 120, tokenTtl: 60 },
      strict: { cost: 20, counterMin: 4, counterMax: 6, challengeTtl: 120, tokenTtl: 45 },
    },
    hisEnabled,
  };
}
export const hisSnapshot = () => ({ focus: [[0, 0, 1, 1]], maxTouchPoints: 0, pointer: [[10, 20, 50]], scroll: [], time: Date.now(), touch: [] });
export async function startRedis() {
  // Use only isolated ephemeral instances. Tests never flush or modify an external Redis.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const directory = await mkdtemp(join(tmpdir(), 'altcha-native-redis-'));
  const process = spawn(globalThis.process.env.REDIS_SERVER_BINARY ?? 'redis-server', [
    '--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no', '--dir', directory,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  process.stdout.on('data', (data: Buffer) => { output = (output + data).slice(-4000); });
  process.stderr.on('data', (data: Buffer) => { output = (output + data).slice(-4000); });
  let launchError: Error | undefined;
  process.on('error', (error) => { launchError = error; });
  const url = `redis://127.0.0.1:${port}`;
  async function stop() {
    if (process.exitCode === null && process.signalCode === null && process.pid) {
      const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
      process.kill('SIGTERM'); await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launchError) throw new Error('Install redis-server or set REDIS_SERVER_BINARY to its executable', { cause: launchError });
      if (process.exitCode !== null) throw new Error(`Redis exited: ${output}`);
      if (output.includes('Ready to accept connections')) return { url, stop };
      await delay(50);
    }
    throw new Error(`Redis startup timeout: ${output}`);
  } catch (error) { await stop(); throw error; }
}
export async function fixture(url: string, config = testConfig(), namespace = randomUUID(), rateLimit = 10000) {
  const store = await RedisStore.connect(url, namespace);
  const app = await buildApp({ config, store, rateLimit });
  return { app, store, config, namespace, close: async () => { await app.close(); await store.close(); } };
}
