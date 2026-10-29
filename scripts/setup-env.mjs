import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const example = new URL('../.env.example', import.meta.url);
const target = new URL('../.env', import.meta.url);
const contents = (await readFile(example, 'utf8')).replace(
  'replace-with-a-random-secret-of-at-least-32-characters',
  randomBytes(32).toString('hex'),
);
try {
  await writeFile(target, contents, { flag: 'wx', mode: 0o600 });
  console.log('Создан .env со случайным HMAC_SECRET. Ключ не выводится.');
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
    console.log('.env уже существует: настройки сохранены.');
  } else { throw error; }
}
