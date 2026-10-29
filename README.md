# ALTCHA PoC backend

Самостоятельный Fastify backend исследовательского ALTCHA PoC. Перенесён из `altcha-poc/backend`; исходники frontend и его зависимости для установки, тестов, сборки и запуска не нужны.

## Запуск

Нужен Node.js 22.12+; версия окружения указана в `.nvmrc`.

```sh
cd /Users/viktoria/WebstormProjects/altcha-poc-backend
npm ci
npm run setup:env
npm run dev
```

Существующие зависимости и `.env` уже перенесены. `setup:env` не заменяет имеющийся файл. Новый `.env` создаётся из `.env.example` с правами `0600` и случайным секретом без вывода значения. Файл игнорируется Git. Если `.env` отсутствует, сервер использует случайный секрет в памяти.

По умолчанию API слушает `http://127.0.0.1:3001`. Проверка: `GET /api/health` → `{ "ok": true }`.

Frontend запускается отдельно: `cd ../altcha-poc && npm run dev`, доступен на `http://127.0.0.1:5173`. Его Vite proxy направляет `/api` на порт 3001. Смена структуры проектов не меняет URL API.

## Команды

```sh
npm run typecheck               # Исходники, серверные тесты и CLI scripts
npm test                        # 40 серверных тестов
npm run build                   # dist/
npm start                       # Запуск собранного dist/server.js
npm run demo:security           # Реальный HTTP PoW demo; нужен запущенный backend
npm run probe:server-signature  # Изолированное исследование server signatures
```

`demo:security` по умолчанию обращается напрямую к `http://127.0.0.1:3001`; другой адрес задаётся переменной `DEMO_ORIGIN`. В режиме image CLI показывает путь к PNG и просит ввести код вручную в интерактивном терминале.

## Структура

- `src/app.ts` — factory Fastify, маршруты, cookie, CORS, лимиты и обработка ошибок.
- `src/server.ts` — загрузка `.env`, запуск и остановка.
- `src/captcha.ts`, `image-captcha.ts`, `his.ts`, `session.ts` — исходный сценарий PoW + картинка/HIS/сессия.
- `src/ms-captcha.ts`, `ms-business.ts`, `ms-routes.ts` — экспериментальные mock CAPTCHA MS и Business MS.
- `test/` — только серверные тесты; нет импортов frontend.
- `scripts/` — настройка окружения и исследовательские CLI.

Два теста, использующие одновременно frontend и backend, сохранены в `../altcha-poc/integration`. Они запускаются из frontend-проекта через `npm run test:integration` и не входят в независимые проверки этого проекта. Браузерный `npm run test:ms:browser` запускается там же и обращается к этому backend по HTTP; настройка адреса — `CAPTCHA_API_ORIGIN`.

## API

| Endpoint | Назначение |
| --- | --- |
| `GET /api/health` | Готовность процесса |
| `GET /api/captcha/challenge` | HIS handshake исходного сценария |
| `POST /api/captcha/challenge` | Подписанный challenge с HIS и опциональной картинкой |
| `POST /api/captcha/verify` | Проверка PoW и введённых символов |
| `POST /api/demo/submit` | Проверка и однократное использование исходного результата |
| `POST /api/captcha/challenges` | Envelope проектируемого CAPTCHA MS |
| `POST /api/captcha/verifications` | Предварительная проверка и серверная запись |
| `POST /api/business/submit` | Экспериментальные режимы PoW / verification_id через X-Captcha-Payload |

Новые MS-сценарии доступны во frontend на `/captcha-ms`. Режимы A/B остаются гипотезами контракта, хранилища находятся в памяти, внутренний вызов Business MS → CAPTCHA MS моделируется внутри процесса. Состояние теряется при перезапуске; это исследовательский PoC.

## Окружение

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `HMAC_SECRET` | Случайный в памяти | Серверный секрет длиной от 32 символов |
| `HOST` | `127.0.0.1` | Адрес сервера |
| `PORT` | `3001` | Порт API |
| `CORS_ORIGINS` | `http://localhost:3000` | Точные origins через запятую; для Vite proxy CORS не требуется |
| `SESSION_TTL_SECONDS` | `3600` | Время жизни сессии |
| `CHALLENGE_TTL_SECONDS` | `120` | TTL исходного challenge |
| `POW_COST` | `1000` | PBKDF2 cost исходного сценария |
| `CAPTCHA_MODE` | `image` | `image` / `pow` для исходного сценария |
| `LOG_LEVEL` | `info` | Уровень логов |

Настройки MS fault injection передаются отдельным заголовком `X-Poc-Mock`. Они не являются production API. Контракт, результаты и ограничения экспериментов описаны в `../altcha-poc/docs/captcha-ms-poc.md`.
