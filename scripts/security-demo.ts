import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { solveChallenge, type Challenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'

const origin = process.env.DEMO_ORIGIN ?? 'http://127.0.0.1:3001'
let imageDirectory: string | undefined

// Separate explicit cookie jars. Node fetch does not persist cookies automatically.
class Client {
  private cookie = ''

  async request(path: string, body?: Record<string, unknown>) {
    const response = await fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith('altcha_poc_sid='))
    if (cookie) this.cookie = cookie.split(';')[0] ?? ''
    return response
  }
}

async function expect(label: string, response: Response, status: number, code?: string) {
  const body = await response.json() as { success?: boolean; code?: string }
  assert.equal(response.status, status, `${label}: ${JSON.stringify(body)}`)
  if (code) assert.equal(body.code, code)
  else assert.equal(body.success, true)
  console.log(`${label}: HTTP ${response.status} · ${body.code ?? 'success'}`)
}

try {
  const alice = new Client()
  const bob = new Client()
  const challengeResponse = await alice.request('/api/captcha/challenge')
  assert.equal(challengeResponse.status, 200)
  const bootstrap = await challengeResponse.json() as { his?: { url?: string } }
  assert.equal(bootstrap.his?.url, '/api/captcha/challenge')
  // A terminal has no browser interaction collector. Send a truthful empty snapshot.
  const issuedResponse = await alice.request('/api/captcha/challenge', {
    his: { focus: [], maxTouchPoints: 0, pointer: [], scroll: [], time: Date.now(), touch: [] },
  })
  assert.equal(issuedResponse.status, 200)
  const challenge = await issuedResponse.json() as Challenge
  console.log('CLI: отправлен пустой HIS — браузерные взаимодействия в терминале не собираются.')
  const started = performance.now()
  const solution = await solveChallenge({ challenge, deriveKey })
  assert.ok(solution)
  console.log(`Реальный PoW решён HTTP-клиентом за ${(performance.now() - started).toFixed(1)} мс. Это не доказывает присутствие человека.`)
  const payload = Buffer.from(JSON.stringify({
    challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution,
  })).toString('base64')
  const body = { message: 'HTTP security demo', altcha: payload }
  // Try the wrong session before consuming the challenge in its legitimate session.
  await expect('E · Другая сессия', await bob.request('/api/demo/submit', body), 403, 'CAPTCHA_SESSION_MISMATCH')
  if (challenge.codeChallenge) {
    await expect('Защита от пропуска картинки', await alice.request('/api/demo/submit', body), 403, 'CAPTCHA_CODE_REQUIRED')
    const prefix = 'data:image/png;base64,'
    assert.ok(challenge.codeChallenge.image.startsWith(prefix))
    imageDirectory = await mkdtemp(join(tmpdir(), 'altcha-code-'))
    const imagePath = join(imageDirectory, 'captcha.png')
    await writeFile(imagePath, Buffer.from(challenge.codeChallenge.image.slice(prefix.length), 'base64'), { mode: 0o600 })
    console.log(`Откройте картинку: ${imagePath}`)
    if (!process.stdin.isTTY) throw new Error('В режиме image запустите demo:security в интерактивном терминале для ввода символов')
    const terminal = createInterface({ input: process.stdin, output: process.stdout })
    let code: string
    try {
      code = await terminal.question('Введите 6 символов с картинки: ')
    } finally {
      terminal.close()
    }
    const response = await alice.request('/api/captcha/verify', { payload, code })
    const verification = await response.json() as { verified?: boolean; message?: string }
    assert.equal(response.status, 200, verification.message ?? 'Ошибка проверки символов')
    assert.equal(verification.verified, true)
    console.log('Символы подтверждены сервером.')
  }
  await expect('A · Нормальная проверка', await alice.request('/api/demo/submit', body), 200)
  await expect('B · Повторное использование', await alice.request('/api/demo/submit', body), 409, 'CAPTCHA_ALREADY_USED')
  await expect('C · Без CAPTCHA', await alice.request('/api/demo/submit', { message: 'Без payload' }), 400, 'CAPTCHA_MISSING')
  const changed = { parameters: structuredClone(challenge.parameters), signature: challenge.signature }
  changed.signature = (changed.signature?.startsWith('0') ? '1' : '0') + changed.signature?.slice(1)
  await expect('D · Подмена подписи', await alice.request('/api/demo/submit', {
    ...body, altcha: Buffer.from(JSON.stringify({ challenge: changed, solution })).toString('base64'),
  }), 400, 'CAPTCHA_INVALID')
  console.log('Все сценарии A–E пройдены. Cookie и session ID не выводятся.')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Security demo failed')
  console.error('Сначала запустите npm run dev. Для другого адреса задайте DEMO_ORIGIN.')
  process.exitCode = 1
} finally {
  if (imageDirectory) await rm(imageDirectory, { recursive: true, force: true })
}
