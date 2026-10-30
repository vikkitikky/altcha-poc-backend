# API CAPTCHA MS

Все ответы JSON, `Cache-Control: no-store`. Тело запроса ограничено 32 KiB. Неизвестные поля не удаляются молча, а отклоняются. Идентификаторы: 1–100 символов из `A-Za-z0-9_.:-`.

## GET /api/captcha/challenge

Query: обязательный `site_id`, необязательные `action`, `policy`. Отсутствующий action берётся из `defaultAction` зарегистрированного сайта. Эффективная политика выбирается исключительно серверным отображением site → action → policy. Переданный policy разрешён только при точном совпадении с эффективным.

```http
GET /api/captcha/challenge?site_id=example&action=submit_form
```

При `HIS_ENABLED=false` и PoW-политике ответ 200 — непосредственно результат `altcha-lib.createChallenge()`:

```json
{
  "parameters": {
    "algorithm": "PBKDF2/SHA-256",
    "cost": 5000,
    "keyLength": 32,
    "keyPrefix": "<hex, 16 bytes>",
    "nonce": "<hex, 16 bytes>",
    "salt": "<hex, 16 bytes>",
    "expiresAt": 1793350300,
    "data": {
      "challenge_id": "<uuid-v4>",
      "kid": "c1",
      "site_id": "example",
      "action": "submit_form",
      "policy": "standard",
      "policy_revision": "<sha256-hex>",
      "his_received": false
    }
  },
  "signature": "<HMAC-SHA-256 hex>"
}
```

Значения выше схематические. `expiresAt` — Unix time в **секундах**, nonce/salt — hex. Полная структура параметров и контекст защищены подписью библиотеки. Challenge ID нужен серверу и возвращается виджетом внутри оригинального payload автоматически.

При `HIS_ENABLED=true` этот же GET возвращает нативный сигнал 200:

```json
{"his":{"url":"/api/captcha/challenge?site_id=example&action=submit_form&policy=standard"}}
```

При политике `mode: "pow+image"` добавляется штатное поле в корень ответа:

```json
{
  "parameters": { "...": "modern PoW parameters", "data": { "captcha_mode": "pow+image", "image_id": "<uuid>", "...": "signed context" } },
  "signature": "<signature>",
  "codeChallenge": { "image": "data:image/png;base64,...", "length": 5 }
}
```

`image_id` и режим защищены подписью. `codeChallenge` служит UI; ожидаемый ответ в нём отсутствует. Виджет возвращает только параметры/подпись в PoW payload, поэтому сервер хранит исходный challenge без `codeChallenge`. Общий `expiresAt` ограничен минимумом PoW TTL и image TTL.

## POST /api/captcha/challenge

Включён только при `HIS_ENABLED=true`. Query такой же, как у GET; URL сигнала уже содержит эффективный контекст. Виджет самостоятельно повторяет запрос методом POST:

```json
{
  "his": {
    "focus": [[0, 0, 1, 1]],
    "maxTouchPoints": 0,
    "pointer": [[100, 200, 50]],
    "scroll": [],
    "time": 1793350000000,
    "touch": []
  }
}
```

После проверки структуры возвращается обычный корневой modern challenge с `his_received=true` в подписанных данных. Пустые массивы допустимы: доступность интерфейса и отсутствие взаимодействий не подменяются произвольным botScore. Отсутствующий/некорректный HIS отклоняется, бесконечный handshake не создаётся. При выключенном HIS POST возвращает `HIS_DISABLED`.

## POST /api/captcha/verify

Публичный нативный запрос виджета:

```json
{"payload":"<standard-base64 JSON {challenge:{parameters,signature},solution}>"}
```

Поддерживается только modern v2. Payload ограничен 16384 символами. Сервер сверяет challenge с выданной Redis-записью, проверяет текущую политику и её ревизию, Origin сайта, TTL, активный/сохранённый ключ и `verifySolution()` библиотеки. Только корректное решение может атомарно получить новое подтверждение; конкурентные повторы дают одного победителя.

Успех 200:

```json
{"verified":true,"payload":"<HS256 compact JWT>"}
```

Это **новый** серверный payload. Виджет автоматически использует его в событиях `serververification`, `verified` и в скрытом поле `altcha`.

Штатные опции виджета могут добавить `fields` (до 20 строк, до 2000 символов каждая) и `timeZone` (до 100 символов). Backend принимает их, но не анализирует и не хранит; включать их для этой реализации не требуется. В режиме `pow` лишний `code` отвергается с `CODE_UNEXPECTED`. В режиме `pow+image` `code` обязателен; пробелы по краям удаляются, ASCII-буквы приводятся к верхнему регистру. HIS не является полем verification request в штатном пути 3.5.0.

При штатном image-задании виджет сам отправляет:

```json
{"payload":"<original PoW base64>","code":"<user answer>"}
```

Подлинность PoW проверяется до применения image-попытки. Только после проверки ответа Lua завершает image, погашает PoW и регистрирует JWT. Токен включает `captcha_mode=pow+image`, `image_id`, `image_verified=true`; внутренний API требует эти claims для image-политики.

Ожидаемые image-отказы возвращают **HTTP 200** без token payload:

```json
{"verified":false,"reason":"IMAGE_INCORRECT"}
```

Причины: `IMAGE_CODE_REQUIRED`, `IMAGE_CODE_INVALID`, `IMAGE_INCORRECT`, `IMAGE_ALREADY_ATTEMPTED`, `IMAGE_NOT_USABLE`, `IMAGE_RATE_LIMITED`, а также ошибки PoW/контекста/TTL после разбора image payload. Это обеспечивает штатное состояние error вместо зависания Code-пути на thrown HTTP error. Неверный допустимый code закрывает изображение после одной попытки; PoW-used и token permit не создаются. Missing/malformed code и неверный PoW не закрывают изображение. Следующая UI-попытка — клик по checkbox, новое изображение и PoW.

Неисправность Redis остаётся HTTP 503, общая HTTP-квота — 429, ошибки схемы/разбора — 400. Ограничение их восстановления в Widget 3.5.0 описано в `../ALTCHA_CODE_RETRY_BEHAVIOR.md`; обход frontend не требуется и не добавлен.

## POST /internal/captcha/validate

Доступен доверенным backend через TLS/private ingress и сервисный Bearer secret:

```http
Authorization: Bearer <service-secret>
Content-Type: application/json
```

```json
{
  "payload": "<server JWT>",
  "site_id": "example",
  "action": "submit_form",
  "policy": "standard"
}
```

Business MS определяет ожидаемый контекст из своей операции, не копирует его из frontend или из непроверенных claims. Ключ сервисного клиента ограничен списком `sites`.

Проверяются HS256, `kid`, `typ=JWT`, issuer `captcha-ms`, audience `business-ms`, UUID `jti`, обязательные claims, TTL, контекст, действующая ревизия политики и HIS-требование. После этого Redis атомарно удаляет разрешение на использование токена, сравнив SHA-256 его полного значения.

Успех 200:

```json
{"valid":true,"site_id":"example","action":"submit_form","policy":"standard"}
```

Подпись JWT сама по себе недостаточна: отсутствующее Redis-разрешение отклоняется. Неверный ожидаемый контекст или сервисный scope не погашают токен. Результат внутреннего API нельзя кэшировать для повторной операции.

## Ошибки

Для HTTP-ошибок формат: `{"verified":false,"error":"CODE"}`. Ожидаемые отказы image-проверки используют описанный выше HTTP 200 soft failure. HTTP >=400 в Code callback может оставить виджет в verifying; это отличается от обычного PoW verify, который выполняется внутри catch внешнего verify().

| HTTP | Примеры кодов |
| --- | --- |
| 400 | `REQUEST_INVALID`, `SITE_INVALID`, `ACTION_INVALID`, `POLICY_MISMATCH` |
| 400 | `PAYLOAD_INVALID`, `CHALLENGE_TAMPERED`, `CHALLENGE_NOT_USABLE`, `CHALLENGE_EXPIRED`, `POW_INVALID`, `POW_REPLAYED`, `KEY_RETIRED` |
| 400 | `TOKEN_INVALID`, `TOKEN_NOT_USABLE`, `CONTEXT_MISMATCH` |
| 400 | `HIS_MISSING`, `HIS_INVALID`, `HIS_DISABLED`, `CODE_UNEXPECTED` |
| 401 | `SERVICE_UNAUTHORIZED` |
| 403 | `ORIGIN_FORBIDDEN`, `SERVICE_SCOPE_FORBIDDEN` |
| 413 | `REQUEST_INVALID` — размер тела больше 32 KiB |
| 429 | `RATE_LIMITED`, `Retry-After: 60` |
| 503 | `STORAGE_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` без деталей/секретов |

Просроченный challenge обычно уже отсутствует в Redis и даёт `CHALLENGE_NOT_USABLE`; `CHALLENGE_EXPIRED` покрывает истечение между чтением записи и атомарной операцией. Повторный и отсутствующий token permit имеют один код `TOKEN_NOT_USABLE`.

## Frontend

```ts
import 'altcha'; // npm package altcha@3.5.0

// После load элемента:
widget.configure({
  challenge: '/api/captcha/challenge?site_id=example&action=submit_form',
  verifyUrl: '/api/captcha/verify',
});
```

При cross-origin размещении укажите полные HTTP(S) URL и зарегистрируйте точный origin сайта на сервере. Cookie/credentials не нужны. Для HIS collector должен быть включён при монтировании; `configuration='{"humanInteractionSignature":true}'` — штатный способ настроить это заранее. В 3.5.0 значение по умолчанию уже `true`.

Frontend отправляет скрытое поле формы `altcha` в Business API как обычное поле `payload`. Не нужны fetch CAPTCHA вручную, custom fetch, verifyFunction, envelope-преобразования или хранение политики/challenge ID. Полный пример находится в `examples/index.html`.

## Business MS

```ts
const response = await fetch(`${captchaOrigin}/internal/captcha/validate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceSecret}` },
  body: JSON.stringify({ payload: frontendPayload, site_id: 'example', action: 'submit_form', policy: 'standard' }),
  signal: AbortSignal.timeout(3000),
});
if (!response.ok || (await response.json()).valid !== true) {
  throw new Error('CAPTCHA rejected');
}
// Здесь отдельно выполняются бизнес-авторизация и операция.
```

Запускаемый пример: `examples/business.ts`. Секрет никогда не передаётся frontend. Потерянный ответ validate не даёт права повторно выполнить операцию; для повторов бизнес-запросов нужна собственная идемпотентность Business MS.
