# Image CAPTCHA: реализация сервера

Это расширение `altcha-native-backend` от `7a8ee8d`, использующее существующие altcha-lib, site/action policies, HIS, key rings и Redis. Frontend/виджет не изменяются. `altcha-lib` проверяет PoW, наш сервис генерирует и проверяет image code.

## Включение

| Переменная | Default | Значение |
| --- | --- | --- |
| CAPTCHA_IMAGE_ENABLED | false | Разрешить image-policy; в default-наборе strict становится pow+image |
| CAPTCHA_IMAGE_LENGTH | 5 | 4–8 символов |
| CAPTCHA_IMAGE_TTL_SECONDS | 120 | 1–600 s; общий TTL challenge/image — минимум этого значения и policy.challengeTtl |
| CAPTCHA_IMAGE_RATE_LIMIT | 10 | 1–120 первых image-ответов одного IP / 60 s по всем свежим challenge |

`CAPTCHA_IMAGE_MAX_ATTEMPTS` исключён. Если он задан, процесс останавливается с объяснением: штатный UI не даёт три ввода одного изображения. У одного image attempts принимает только 0/1. Изменение лимита догадок не требует клиента, применяется во всех репликах через Redis.

Без `POLICIES_JSON`: `submit_form → standard → pow`, `sensitive → strict → pow+image` при включённом флаге. С пользовательским `POLICIES_JSON` задайте `mode` явно:

```json
{
  "standard":{"mode":"pow","cost":5000,"counterMin":200,"counterMax":400,"challengeTtl":120,"tokenTtl":60},
  "strict":{"mode":"pow+image","cost":10000,"counterMin":400,"counterMax":800,"challengeTtl":120,"tokenTtl":45}
}
```

Mode default — pow. Сервис не допускает image-policy при выключенной возможности. Сохраняются прежние PoW challenge/API/JWT; ревизия pow-политик не меняется только из-за добавления image feature. Для image в ревизию входят mode, длина, image TTL. Переход режима/параметров инвалидирует прежние challenge/tokens соответствующей политики.

## Генератор

`src/image-worker.mjs` использует `@napi-rs/canvas@1.1.0`, MIT, поддерживаемый Skia/Node-API backend. Конкретная версия закреплена lockfile. Шрифт Roboto Mono включён в `assets/fonts` с SIL OFL 1.1; регистрация идёт по пути относительно модуля, поэтому работает в src и dist и не зависит от системных fonts.

Источник шрифта: Google Fonts `ofl/robotomono/RobotoMono[wght].ttf`, Git blob `f21d1d716bce3cc756bc618d32be71ce6f733f81`; OFL blob `8e7df338d36eb52c49548ecc58afcb7eb3f73898`. Бинарник и лицензия проверены `git hash-object`. [Исходная директория](https://github.com/google/fonts/tree/main/ofl/robotomono).

Каждый символ выбирается `node:crypto.randomInt` из `ACDEHJKMNPQRTUVWXY3479`, без B/8, O/0, I/1/L, S/5, Z/2, G/6. Длина ограничена. Случайны положение/наклон/небольшой skew каждого glyph, размер/цвет, 90 точек и 3 умеренные кривые. Это визуальные препятствия, не заявление об устойчивости к современному OCR.

Raster: `(36 × length + 28) × 88`, максимум 316×88; PNG не больше 32768 bytes. Ответ передаётся только нарисованными пикселями, без текста/alt/title/metadata с эталоном. Публичный API возвращает `codeChallenge:{image:"data:image/png;base64,...",length}`; внешний image endpoint/storage не нужен. Полный response может быть около 45 KiB, но PoW submission не содержит PNG и остаётся в прежнем лимите тела 32 KiB.

`CanvasImageGenerator` допускает максимум два изолированных worker одновременно на экземпляр сервиса, без очереди. Deadline — 2000 ms, после него worker завершается и запрос получает 503. Фиксированы размер холста, число операций и PNG size; генератор не декодирует клиентские картинки/URL. JS heap worker ограничен 64 MiB; native memory определяется ограниченным холстом/Skia и не является общей OS memory quota. При сбое/отсутствии шрифта/ошибке кодека/занятых слотах выдачи challenge нет. Шрифт и worker должны поставляться вместе с dist; `npm run build` копирует mjs через allowJs.

## Ответ и жизненный цикл

Image имеет случайный UUID, отдельный от challenge UUID. Image ID и `captcha_mode` подписаны внутри modern parameters.data. В Redis ключ `image:<challenge-id>` содержит image ID, HMAC-SHA-256 эталона, state pending/failed/completed и attempts. HMAC использует ключ подписанного challenge kid с domain separation `altcha-image-v1`, image ID и нормализованный ответ. Это защищает малый словарь от offline-перебора при чтении одного Redis dump без ключей. Эталон plaintext не хранится в Redis/логах/JWT; генератор передаёт его только в памяти текущей выдачи для HMAC.

Challenge и image-state создаются одним Lua-вызовом с общим expiresAt. Сохраняемый PoW challenge не включает UI codeChallenge — так же, как payload нативного виджета. Сервер не доверяет присланному UI; проверяет сохранённую запись и подписанный image ID. Изображение может быть подменено клиентом у самого себя, но это не меняет ожидаемый сервером ответ или политику.

На verify сначала проверяются контекст, политика, подпись, TTL и решение PoW. Missing/empty/invalid-format code не расходует попытку. Допустимый code нормализуется trim + ASCII uppercase и HMAC-ится. Lua проверяет существование и pending-state, увеличивает общий per-IP image counter; при превышении квоты image остаётся pending. Первое сравнение ответа устанавливает attempts=1: mismatch → failed, match → completed + pow-used + token permit. Все записи результата одной проверки выполняются атомарно; параллельные запросы не получают двух токенов. Неверный ответ не создаёт pow-used, но намеренно закрывает именно изображение, которое UI уже не предлагает редактировать.

Ошибки возвращаются как 200 `{verified:false,reason}` без token payload. После них пользователь запускает новое задание штатным checkbox. Перезапись ответа для старого image запрещена. JWT с image_verified подписывается в памяти до Lua, но не считается выданным, не передаётся клиенту и не имеет Redis permit до полного успеха. Внутренний API требует image claims, текущую ревизию и одноразовый permit.

## Безопасность, доступность и ограничения

- Shared rate limit/one-attempt/PoW/TTL защищают от простого онлайн-перебора; не идентифицируют пользователя и не гарантируют невозможность OCR/распределённой атаки. `trustProxy=false` и ограничения NAT/trusted ingress сохранены.
- Исчерпание worker/store/таймаут — fail-closed; автоматического downgrade на pow нет. Ошибки 503/429/transport могут оставить Code callback виджета 3.5.0 в verifying до expiry/reset. Это подтверждённое ограничение, frontend workaround не вводился.
- Аудио UI виджета подтверждён, но TTS/аудиогенератора в altcha-lib нет. Первая версия сервиса не выдаёт audio; image mode недоступен пользователям, которым требуется незрительная альтернатива. Для таких операций сервер может заранее выбрать pow либо отдельно разработать доступный канал. Нельзя объявлять эту image CAPTCHA полностью WCAG-доступной.
- Произвольный текст задания в CodeChallenge отсутствует: виджет использует встроенную локализацию. Нет пазлов/объектных сеток.
- HIS остаётся структурными наблюдениями без behavioral scoring. Сочетание image+HIS работает штатным GET/POST handshake.
- Тестовые oracle/fixtures находятся только в test, не в production маршрутах. В frontend нет собственного хранилища challenge, транспортных адаптеров или ручного verification request.
