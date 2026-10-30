# Проверка реализации

Дата: 30 октября 2026. Ветка: `altcha-native-backend`, исходная база: `main@903359650727295cbee6a0a7ecaa683870ebc3ed`.

## Выполнено

| Проверка | Результат |
| --- | --- |
| `npm run typecheck` | PASS: исходники, examples, тесты и scripts |
| `npm test` | PASS: 34 серверных теста на настоящем Redis 8.2.2 |
| `npm run build` | PASS: TypeScript → dist |
| Smoke собранного `dist/server.js` | PASS: отдельный процесс, `.env.native`, cost=5000 по умолчанию, реальный HTTP challenge/verify/internal consume и отказ повтора |
| Нативные браузерные сценарии | PASS: 8/8 на оригинальном Widget 3.5.0, Chromium 156; отдельно 5/5 Code retry-проб |

Окружение серверных проверок: Node.js 22.21.1, altcha-lib 2.8.0, jose 6.2.14, redis client 6.3.1. Docker daemon не работал, поэтому тестовый Redis 8.2.2 собран из официального release archive и запущен временно через `REDIS_SERVER_BINARY`. Compose-конфигурация предоставлена для локального запуска, её docker up в этой сессии не проверялся.

Playwright runner не смог запустить дочерний Chrome из-за ограничения macOS sandbox на Mach bootstrap. Браузерные сценарии выполнены через `npm run test:browser:interactive` в доступном встроенном Chromium. Он использует **тот же** `test/browser/harness.ts` и `runner.js`, которые открывает Playwright; виджет не замокан. Результат записан в `browser-results.json`. Нельзя трактовать это как успешный запуск команды `npm run test:browser` в данном sandbox.

## Серверные проверки

Проверены полный flow, корневой modern challenge и epoch seconds; server allowlist site/action/policy; default action; malformed/extra/duplicate inputs; изменение подписи, контекста, cost и expiry; неверные и некорректно закодированные решения; отдельная проверка правильного derived key с counter, который **не** удовлетворяет keyPrefix; JWT signature/issuer/expiry; отказ подписанного, но не выданного токена; внутренние auth/scopes; сохранение токена после неправильного ожидаемого контекста; CORS и per-site Origin; общий rate limit между репликами; fail-closed Redis; TTL; ротация и удаление ключей; изменение ревизии политики; HIS handshake/parse/missing/malformed/bounds; явный отказ graphics.

Гонки: 16 параллельных публичных verify одного решения через два app/Redis connection дают ровно один серверный токен; 16 параллельных validate через эти реплики дают ровно одно погашение. Тестируются настоящие Redis Lua-операции. In-memory имитация атомарности не используется.

## Браузерные проверки

| Сценарий | Что наблюдалось |
| --- | --- |
| native-pow-business | GET challenge → PoW в оригинальном browser worker → POST verify с единственным полем payload → serververification/verified получают JWT → скрытое поле формы содержит JWT → отдельный Business MS вызывает internal API по HTTP → повтор отвергнут |
| his-reset | Нативный GET signal → POST `{his}` с реальным collector schema → PoW/verify → JWT `his_received=true`; reset заново повторяет handshake и получает новый токен |
| his-disabled | При выключенном collector виджет переходит в error после HIS signal и не делает выдуманного POST/fallback |
| native-retry | Настоящий HTTP 404 на verification URL → error; reset + правильный verifyUrl → новый challenge и успешная проверка |

Harness наблюдает method/path/имена полей на сервере. Не подменяет `window.fetch` или `config.fetch`, не использует verifyFunction, не перехватывает и не переписывает ответы/запросы CAPTCHA. Проверяется неизменность global fetch. Сборочный JS берётся непосредственно из установленного `altcha@3.5.0`. Browser form передаёт в Business API только новый server payload и тестовое сообщение; сервисные секреты остаются в Node.

У тестовых политик ниже стоимость PoW (10/20) для скорости и воспроизводимости. Отдельная HTTP smoke-проверка собранного сервера использовала реальную default-политику с cost=5000. Нет утверждения о нагрузочной устойчивости на основании этих тестов.

Дополнительно выполнены **5/5** runtime-проб Code callback: HTTP 200 false, 400, 401, 422 и реальный обрыв TCP. Они выполнялись до выбора production lifecycle; артефакт — `code-retry-results.json`. Никакой server verification success в исследовательских fixtures не имитируется.

Image-тесты проверяют реальный PNG/размер/алфавит/случайность/отсутствие plaintext эталона в JSON и Redis, верный и неверный code, missing/malformed code, неподлинный PoW, отсутствие premature pow-used, terminal attempts=1, per-IP квоту между свежими заданиями, общий TTL, гонки через две реплики, полный token consume, HIS и fail-closed worker/store. Генератор тестируется на deadline и ограничение параллелизма. TTL-тесты используют 2 s, чтобы не зависеть от округления epoch seconds у границы секунды.

Браузерная матрица дополнена настоящим PNG → code → Business MS, неверным code → error → нативным checkbox → новым challenge/PoW/image → успехом, native Reload и image+HIS. Тестовый oracle локален к test harness и отсутствует в production API. Ни custom fetch, ни патч виджета не используются.

## Границы результата

Позитивные image-тесты используют собственный генератор сервиса на Canvas; отсутствие генератора в altcha-lib не подменяется утверждением о библиотечной поддержке. Аудио и доступность для незрячих пользователей не реализованы и явно ограничены.

HIS протестирован как транспорт и структура. Анализ поведения, automation probability, криптографическая подпись и HIS replay detection не реализованы и не заявляются. Наблюдения в тесте могут быть синтетическими; это иллюстрирует отсутствие доказательства человечности.

Не проверялись production ingress/mTLS, Redis HA/failover, browser/device/accessibility matrix, реальные бизнес-транзакции и нагрузка. Их границы описаны в `architecture.md`.

В повторном прогоне устранена зависимость тестового ожидания от requestAnimationFrame: offscreen iframe может приостанавливать его и задерживать отправку уже выданного короткоживущего токена. Runner ожидает обычный task/microtask flush; production frontend и виджет не менялись.
