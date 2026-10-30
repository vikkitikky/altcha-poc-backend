import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

let contents = await readFile(new URL('../.env.native.example', import.meta.url), 'utf8');
for (const placeholder of ['replace-challenge-secret', 'replace-token-secret', 'replace-service-secret']) {
  contents = contents.replace(placeholder, randomBytes(32).toString('hex'));
}
try {
  await writeFile(new URL('../.env.native', import.meta.url), contents, { flag: 'wx', mode: 0o600 });
  console.log('Создан .env.native с независимыми случайными ключами. Секреты не выводятся.');
} catch (error) {
  if (error?.code === 'EEXIST') console.log('.env.native уже существует: настройки сохранены.');
  else throw error;
}
