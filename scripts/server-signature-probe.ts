// Isolated compatibility study. This script is not imported by the application
// and is not an issuer endpoint. It uses a fresh in-memory secret on each run.
import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { verifyServerSignature, type ServerSignaturePayload } from 'altcha-lib'

const secret = randomBytes(32).toString('hex')
const now = Math.floor(Date.now() / 1000)
const base = { id: randomUUID(), verified: 'true', expire: String(now + 120), purpose: 'demo-submit' }

function sign(fields: Record<string, string>): ServerSignaturePayload {
  const verificationData = new URLSearchParams(fields).toString()
  // Matches altcha-lib 2.7.0: HMAC-SHA-256 over the raw SHA-256 digest bytes.
  const digest = createHash('sha256').update(verificationData, 'utf8').digest()
  return {
    algorithm: 'SHA-256',
    id: fields.id,
    signature: createHmac('sha256', secret).update(digest).digest('hex'),
    verificationData,
    verified: true,
  }
}

let count = 0

function passed(label: string): void {
  count++
  console.log(`OK ${count}. ${label}`)
}

const token = sign(base)
const check = (payload: ServerSignaturePayload) => verifyServerSignature({ payload, hmacSecret: secret })

const result = await check(token)
assert.equal(result.verified, true)
assert.equal(result.verificationData?.id, base.id)
assert.equal(result.verificationData?.purpose, 'demo-submit')
passed('Собственный issuer совместим с официальным verifyServerSignature')

const encoded = Buffer.from(JSON.stringify(token), 'utf8').toString('base64')
const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as ServerSignaturePayload
assert.equal((await check(decoded)).verified, true)
passed('Base64 JSON payload сохраняет совместимость формата widget')

const tampered = await check({ ...token, verificationData: `${token.verificationData}&purpose=other-action` })
assert.equal(tampered.verified, false)
assert.equal(tampered.invalidSignature, true)
passed('Изменение подписанных данных отвергается')

assert.equal((await verifyServerSignature({
  payload: token,
  hmacSecret: randomBytes(32).toString('hex'),
})).invalidSignature, true)
passed('Неверный HMAC secret отвергается')

const expired = await check(sign({ ...base, expire: String(now - 1) }))
assert.equal(expired.verified, false)
assert.equal(expired.expired, true)
passed('Корректно подписанный просроченный токен отвергается')

assert.equal((await check({ ...token, verified: false })).verified, false)
assert.equal((await check(sign({ ...base, verified: 'false' }))).verified, false)
passed('Оба признака verified должны быть true')

const differentOuterId = await check({ ...token, id: randomUUID() })
assert.equal(differentOuterId.verified, true)
assert.equal(differentOuterId.verificationData?.id, base.id)
passed('Внешний id не подписан: для replay нужен id из verificationData')

const withoutExpiry = sign({ id: base.id, verified: 'true', purpose: 'demo-submit' })
assert.equal((await check(withoutExpiry)).verified, true)
passed('Без expire библиотека принимает токен: приложение обязано требовать TTL')

assert.equal((await check(sign({ ...base, expire: 'not-a-timestamp' }))).verified, true)
passed('Нечисловой expire не заменяет проверку типа срока на уровне приложения')

assert.equal((await check(token)).verified, true)
assert.equal((await check(token)).verified, true)
passed('Повторная криптографическая проверка проходит: replay store нужен отдельно')

assert.equal((await check(sign({ ...base, purpose: 'another-form' }))).verified, true)
passed('Назначение токена должна проверять бизнес-логика')

await assert.rejects(check({ ...token, algorithm: 'MD5' }), /Unsupported algorithm/)
passed('Неподдерживаемый алгоритм отвергается')

const wrongDigestEncoding = createHmac('sha256', secret)
  .update(createHash('sha256').update(token.verificationData).digest('hex'))
  .digest('hex')
assert.equal((await check({ ...token, signature: wrongDigestEncoding })).invalidSignature, true)
passed('Подпись hex-строки digest не совместима: нужны сырые байты SHA-256')

console.log(`Все ${count} исследовательских проверок пройдены. Приложение и его маршруты не изменены.`)
