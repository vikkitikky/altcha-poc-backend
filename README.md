# CAPTCHA MS: нативный ALTCHA Widget 3.5.0

Ветка `altcha-native-backend` — отдельная реализация backend с modern PoW v2, публичной server verification и однократным серверным подтверждением для Business MS. Исходный PoC сохранён в `main` на коммите `9033596`.

Виджет получает challenge по штатному URL, решает PoW в worker, самостоятельно отправляет исходный payload на `verifyUrl` и помещает возвращённый JWT в скрытое поле `altcha`. Frontend не адаптирует транспорт CAPTCHA и не хранит challenge ID или политику.

## Локальный запуск

Нужны Node.js 22.12+, npm и Redis. Compose запускает только локальный Redis; можно использовать собственный Redis по `REDIS_URL`.

```sh
git switch altcha-native-backend
npm ci
npm run setup:env
docker compose up -d redis
npm run dev
```

`setup:env` создаёт `.env.native` с правами `0600` и тремя независимыми случайными секретами. Он не заменяет существующий `.env.native` и не изменяет `.env` исходного backend. Сервер новой ветки читает только `.env.native` и переменные окружения; при отсутствии необходимых ключей запуск прекращается.

CAPTCHA MS: `http://127.0.0.1:3001`, readiness: `GET /api/health` (проверяет также Redis).

Для полного локального сценария запустите ещё в двух терминалах:

```sh
npm run demo:business   # Business MS на 127.0.0.1:3002
npm run demo:frontend   # Страница с настоящим виджетом на 127.0.0.1:3000
```

Откройте `http://127.0.0.1:3000`, пройдите проверку и отправьте форму. Business MS вызывает `/internal/captcha/validate` по HTTP перед демонстрационной операцией. Повторная отправка того же подтверждения отклоняется. Это пример бизнес-интеграции, без собственной бизнес-БД и пользовательской авторизации.

## HIS

По умолчанию `HIS_ENABLED=false`. Для нативного handshake установите `HIS_ENABLED=true` в `.env.native` и перезапустите CAPTCHA MS. В ALTCHA 3.5.0 collector включён по умолчанию. Если frontend отключал его, включите `humanInteractionSignature: true` до монтирования виджета.

Сервер принимает и проверяет структуру снимка; исходные наблюдения сразу отбрасывает. Поведенческого анализа и доказательства присутствия человека это не даёт. Графические задания не реализованы: `altcha-lib` не содержит их генератора и проверки ответов. Подробности и первоисточники — в `docs/altcha-research.md`.

## Проверки

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
```

Серверные тесты и браузерный harness запускают собственные временные Redis-процессы с уникальными namespace, не используют и не очищают ваш Redis. Установите `redis-server` в PATH либо укажите путь через `REDIS_SERVER_BINARY`.

На macOS браузерные тесты по умолчанию используют установленный Google Chrome. В другом окружении выполните `npx playwright install chromium`. Другой исполняемый файл задаётся через `CHROME_EXECUTABLE`.

Если среда запрещает запуск дочернего браузера, используйте тот же набор тестов в уже доступном браузере:

```sh
npm run test:browser:interactive
```

Откройте напечатанный локальный URL `/suite`. Страница автоматически запускает четыре сценария на реальном `altcha@3.5.0`; терминал сообщает результат и завершает временные сервисы. Этот запуск пишет обезличенный отчёт `docs/browser-results.json`. `npm run check` объединяет typecheck, серверные тесты, Playwright и сборку.

## Документация и сравнение

- `docs/api.md` — публичный и внутренний API, примеры frontend и Business MS.
- `docs/architecture.md` — схема взаимодействия, политики, Redis, ключи, ограничения и эксплуатация.
- `docs/altcha-research.md` — версии, лицензия, анализ библиотеки, графических заданий и HIS.
- `docs/verification.md` — результаты и границы выполненных проверок.

```sh
git log --oneline main..altcha-native-backend
git diff --stat main..altcha-native-backend
git diff main..altcha-native-backend -- src package.json docs README.md
```

`main` не изменялась, merge/rebase и push не выполнялись. При переключении между вариантами выполните `npm ci`, чтобы локальные зависимости соответствовали lockfile выбранной ветки. Возвращать старый код из копий не требуется.
