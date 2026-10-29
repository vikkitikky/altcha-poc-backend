import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { buildApp } from './app.js';

// Resolve from this module so dev and the compiled server load the same project-root .env.
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

function positiveInteger(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

const configuredSecret = process.env.HMAC_SECRET;
const captchaMode = process.env.CAPTCHA_MODE ?? 'image';
if (captchaMode !== 'image' && captchaMode !== 'pow') throw new Error('CAPTCHA_MODE must be image or pow');
if (configuredSecret?.startsWith('replace-with-')) throw new Error('Generate a real HMAC_SECRET in .env');
const app = await buildApp({
  // An unconfigured local run still works; all challenges disappear on restart anyway.
  hmacSecret: configuredSecret ?? randomBytes(32).toString('hex'),
  sessionTtlSeconds: positiveInteger('SESSION_TTL_SECONDS', 3600, 86400),
  challengeTtlSeconds: positiveInteger('CHALLENGE_TTL_SECONDS', 120, 3600),
  powCost: positiveInteger('POW_COST', 1000, 100_000),
  imageCaptcha: captchaMode === 'image',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});
if (!configuredSecret) app.log.info('HMAC secret сгенерирован в памяти на время этого запуска');

try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: positiveInteger('PORT', 3001, 65535) });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => { process.exitCode = 0; }); });
}
