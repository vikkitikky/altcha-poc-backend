import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { buildApp } from './app.js';
import { configFromEnv } from './config.js';
import { RedisStore } from './store.js';

// Separate file: the base implementation's existing .env remains untouched.
loadEnv({ path: fileURLToPath(new URL('../.env.native', import.meta.url)), quiet: true });
const config = configFromEnv(process.env);
const port = Number(process.env.PORT ?? 3001);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const store = await RedisStore.connect(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', process.env.REDIS_NAMESPACE);
const app = await buildApp({ config, store, logger: { level: process.env.LOG_LEVEL ?? 'info' } });
app.addHook('onClose', () => store.close());
try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port });
} catch {
  app.log.error({ event: 'startup_failed' }, 'Unable to listen');
  await app.close(); process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
