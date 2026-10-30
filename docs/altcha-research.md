# Исследование ALTCHA: 30 октября 2026

## Версии и метод

Проверены npm metadata (`npm view`), README, лицензии, TypeScript-типы и исполняемый код установленных пакетов. В lockfile зафиксированы exact версии:

| Пакет | Проверенная версия | Лицензия | Роль |
| --- | --- | --- | --- |
| altcha-lib | **2.8.0**, npm latest на дату проверки | MIT | Серверная генерация и проверка modern PoW |
| altcha | **3.5.0**, требуемый Widget | MIT | Реальный custom element и bundled PoW workers |

Публичное название виджета — ALTCHA Widget; npm package называется `altcha`, не `altcha-widget`. Проверялась именно 3.5.0, не latest другой версии.

`altcha@3.5.0` npm gitHead: `f9217276fe9d6dc879b005d37f1d96155f4ab9e1`; `altcha-lib@2.8.0`: `80289d26fc7b927ba04256fa1fee7025bdf29f0d`. Сборки установлены из npm с integrity из lockfile. GitHub-ссылки с этими commit IDs связывают выводы с исходной версией, а не изменяемой main.

Источники: [metadata Widget 3.5.0](https://registry.npmjs.org/altcha/3.5.0), [metadata altcha-lib 2.8.0](https://registry.npmjs.org/altcha-lib/2.8.0), [README библиотеки](https://github.com/altcha-org/altcha-lib), [лицензия библиотеки](https://github.com/altcha-org/altcha-lib/blob/80289d26fc7b927ba04256fa1fee7025bdf29f0d/LICENSE.txt).

Совпадение форматов само по себе не использовано как доказательство: проведены серверные проверки на настоящем Redis и браузерные сценарии с оригинальным JS bundle `altcha@3.5.0`. Версии и результат — `browser-results.json`, методика — `verification.md`.

## Возможности altcha-lib

| Проверка | Результат |
| --- | --- |
| Modern PoW v2 | Да: основной export `altcha-lib`; v1 отдельно по `/v1` |
| PBKDF2/SHA-256 | Да: `altcha-lib/algorithms/pbkdf2`, Node crypto |
| createChallenge() | Да: nonce/salt, параметры, optional data/expiry, HMAC signature |
| verifySolution() | Да: TTL, подпись параметров, корректность derived key и keyPrefix |
| Собственная replay protection | Нет: это обязанность вызывающего backend/store |
| Создание одноразового бизнес-токена | Нет: отдельный контракт сервиса, реализован через jose + Redis |
| Тип CodeChallenge | Да, для UI interoperability; наличие типа не означает генератор |
| Генерация image/audio CAPTCHA | Нет |
| Проверка правильности введённого кода | Нет в verifySolution() |
| HIS collector/backend decoder/scorer | Нет таких exports |
| Sentinel server signatures | Есть вспомогательные verify-функции; это другой протокол, не генератор Sentinel и не HIS engine |

Исходники для воспроизведения проверки: `node_modules/altcha-lib/dist/esm/v2/index.js`, `types.d.ts`, `pow.js`, `algorithms/pbkdf2.js`. Публичные версии: [exports](https://github.com/altcha-org/altcha-lib/blob/80289d26fc7b927ba04256fa1fee7025bdf29f0d/src/v2/index.ts), [PoW](https://github.com/altcha-org/altcha-lib/blob/80289d26fc7b927ba04256fa1fee7025bdf29f0d/src/v2/pow.ts), [типы](https://github.com/altcha-org/altcha-lib/blob/80289d26fc7b927ba04256fa1fee7025bdf29f0d/src/v2/types.ts).

### Детали PoW

`createChallenge()` возвращает `{parameters,signature}`. `expiresAt` — секунды Unix time; nonce/salt/keyPrefix — hex. В v2 counter кодируется uint32 big-endian. HMAC защищает параметры, включая `data`. В детерминированном режиме сервер выбирает случайный counter и публикует только часть соответствующего derived key как keyPrefix.

`verifySolution()` самостоятельно не хранит список выданных/использованных challenge и не связывает его с бизнес-контекстом. Поэтому новый сервис проверяет сохранённый challenge, current policy/revision и отдельные Redis-состояния. Проверка использует повторное вычисление PBKDF2, а не доверие к присланному derivedKey.

Стандартный виджет строит base64 JSON `{challenge:{parameters,signature},solution}`. В browser worker он решает именно challenge нового сервиса, а не решение, сгенерированное тестовым серверным solver. Подробнее: [Widget.svelte 3.5.0](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte), функции `verify`, `requestServerVerification`, `verifyServer`.

## Отдельный вывод: графические задания

Бесплатная altcha-lib по-прежнему не предоставляет генерацию изображений или проверку code. Widget 3.5.0 нативно предоставляет UI ввода символов из `codeChallenge.image`, optional `audio` и `length`, отправку `{payload,code}` на verifyUrl и последовательность PoW → Code. Тип не содержит произвольного текста задания: используются строки локализации `enterCodeFromImage`/`verificationRequired`. Нет универсального tile/object-selection/puzzle протокола.

После отдельного разрешения разработать недостающий backend в этой ветке добавлен **собственный** генератор на `@napi-rs/canvas@1.1.0` (MIT), проверка HMAC эталона и атомарный lifecycle Redis. Это функциональность нашего сервиса, не altcha-lib или Sentinel. Подробности — `image-captcha.md`.

Нативный `CodeChallenge` имеет `{image:string,audio?:string,length?:number}`. Image/audio могут быть URL или data URL; наш сервис отдаёт только raster PNG data URI. Штатный текст задания берётся из локализации виджета. PoW payload не включает `codeChallenge`, поэтому image ID и mode связаны подписанными parameters.data и отдельной server-side записью.

Фактический отказ отличается по путям: 200 verified:false даёт error и возможность нового задания по нативному checkbox; thrown HTTP/network error в Code callback оставляет verifying. Подтверждённые строки, runtime-матрица и выбранная одноразовая image-попытка — `../ALTCHA_CODE_RETRY_BEHAVIOR.md`. Виджет и его транспорт не изменены.

Аудио UI есть в свободном виджете, но библиотечного TTS/генератора нет. В первой версии нашего сервиса аудио отсутствует; наличие штатного audio-поля не объявляется доступной альтернативой, пока ресурс не реализован. Для требований доступности можно заранее выбрать серверную PoW-политику для соответствующей операции либо отдельно спроектировать доступный канал. Автоматического downgrade image-политики со стороны клиента нет.

Первоисточники: [Code.svelte 3.5.0](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/components/Code.svelte), [типы виджета](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/types/index.ts#L230-L234), [Canvas](https://github.com/Brooooooklyn/canvas), [Sentinel Adaptive Captcha](https://altcha.org/docs/sentinel/features/adaptive-captcha/). Sentinel — отдельный продукт, для этой реализации не нужен.

## Отдельный вывод: Human Interaction Signature

**Нативный сбор и handshake доступны бесплатно в виджете. Анализ поведения, automation probability и защита от повторов HIS не предоставляются altcha-lib.** В этой реализации HIS — необязательные клиентские наблюдения с проверкой структуры; это не криптографическая подпись пользователя и не доказательство человечности.

### Collector версии 3.5.0

Collector создаётся при mount, если `humanInteractionSignature=true`; это default. Настройка через configuration до mount надёжнее, чем попытка включить collector configure-вызовом после mount: `configure()` меняет конфигурацию, но не пересоздаёт collector. Исходник: [his.ts 3.5.0](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/his.ts), `Collector`.

Наблюдаются focusin, keydown/pointerdown (признак типа взаимодействия рядом с focus), pointermove, scroll, touchmove. Сами символы клавиатуры и содержимое полей не собираются. Default buffers — до 60 образцов каждого канала, sampling interval 50 ms.

| Поле | Данные |
| --- | --- |
| focus | `[elapsedMs, tabIndex, elementTagCode, interactionFlag]` |
| pointer | `[clientX, clientY, eventTimeMs]`, координаты округлены |
| scroll | `[scrollY, elapsedMs]` |
| touch | `[clientX, clientY, eventTimeMs, force, radiusX, radiusY]` |
| maxTouchPoints | navigator.maxTouchPoints |
| time | Date.now(), миллисекунды epoch |

Tag codes: INPUT=1, TEXTAREA=2, SELECT=3, BUTTON=4, A=5, DETAILS=6, SUMMARY=7, IFRAME=8, VIDEO=9, AUDIO=10; остальные 0. Эти поля видны в `Collector.export()`. Библиотека backend их не декодирует: это обычный JSON.

### Нативный обмен

1. `fetchChallenge()` делает обычный GET configured challenge URL.
2. При `{"his":{"url":"…"}}` требует существующий collector.
3. Повторно вызывает `fetchChallenge(his.url, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({his:collector.export()})})`.
4. Получает обычный modern challenge и продолжает PoW.
5. Verification отправляет payload/code/optional fields/timeZone; snapshot HIS там штатно не добавляется.

При выключенном collector виджет завершает попытку ошибкой, а не фабрикует HIS. Backend не может включить уже отсутствующий collector одним handshake-ответом. Поэтому frontend, который раньше отключал HIS, должен включить его до mount; стандартный frontend с default настройками уже готов.

Оба запроса используют встроенный `config.fetch`. Реализация его не меняет: используется нативный fetch. Обязательные POST headers задаёт сам виджет; frontend не должен переопределять метод или сохранять query context. Handshake URL, формируемый сервисом, содержит весь эффективный site/action/policy, поскольку изначальный query не добавляется повторно магически.

`reset()` очищает текущий payload/PoW controller/таймер, но не создаёт новый HIS collector и не очищает его буферы. Новая verify-попытка заново делает GET и handshake POST с актуальным экспортом тех же ограниченных buffers. Поэтому повторный snapshot после reset не считается нарушением одноразовости. Для HIS намеренно нет самодельного replay detector.

### Польза и приватность без Sentinel

Сервис проверяет только схему, типы, размеры и числовые границы. Не проверяет подпись/целостность snapshot (её нет в collector export), человеческий источник событий или правдоподобность траекторий. HTTP-клиент может отправить синтетический допустимый JSON; браузерный тест использует тестовые события и демонстрирует этот предел.

Sentinel реализует отдельный detection layer для интерпретации HIS и использования в risk decisions; это не поведение нашей библиотеки. [HIS в Sentinel](https://altcha.org/docs/sentinel/features/human-interaction-signature/), [набор функций Sentinel](https://altcha.org/docs/sentinel/features/).

Реальная ценность текущего флага — подтверждённая совместимость нативного транспорта и возможность подключить согласованный анализатор в будущем. Дополнительной оценки риска от самого факта приёма JSON нет, поэтому по умолчанию HIS выключен. Не вводятся клиентский botScore, произвольные thresholds или требования к минимальному количеству движений.

Raw данные существуют только во время одного POST и сразу отбрасываются, не логируются и не попадают в Redis, JWT или Business MS. Сохраняется лишь факт `his_received` в challenge/token с коротким TTL. Ограничения: 32 KiB всего тела, 60 строк/канал, строгая ширина строки. Для отказа от самого сбора отключите collector на frontend до mount; backend flag управляет запросом/приёмом, а не существованием frontend collector.
