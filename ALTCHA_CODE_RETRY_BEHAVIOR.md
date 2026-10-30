# ALTCHA 3.5.0: неверный code и повторные попытки

Проверено 30 октября 2026 **до выбора серверного жизненного цикла**: исполняемый npm bundle `altcha@3.5.0`, исходники commit `f9217276fe9d6dc879b005d37f1d96155f4ab9e1`, пять сценариев в настоящем Chromium 156. Данные воспроизведения — `docs/code-retry-results.json`.

## Последовательность и источники

1. `verify()` вызывает reset в `verifying`, получает challenge и решает новый PoW: [Widget.svelte:1250–1269](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte#L1250-L1269), [генерация payload и состояние code:1363–1384](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte#L1363-L1384).
2. Встроенный `Code` отправляет текст ввода в callback, не перехватывает Promise: [Code.svelte:94–98](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/components/Code.svelte#L94-L98). Callback — `verifyServer(code)`; reload — новый `verify()`: [Widget.svelte:1504–1532](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte#L1504-L1532).
3. `verifyServer` сразу устанавливает `verifying`. Нативный POST содержит **исходный PoW payload**, `code`, а при включении штатных опций также `fields`/`timeZone`: [requestServerVerification:979–1017](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte#L979-L1017), [verifyServer:1118–1158](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte#L1118-L1158).
4. Code UI отображается только при `state=code`; при отправке сразу уничтожается компонент с локальным введённым значением. `codeChallenge` и PoW payload остаются в состоянии виджета, но интерфейса для повторного редактирования того же кода уже нет. `challenge` содержится в закодированном payload; отдельный долговечный frontend challenge-store не нужен.
5. Для HTTP 200 `{verified:false,reason}` вызывается `setState(error,reason)`. Для HTTP >=400 `validateResponse()` бросает исключение. В кодовом пути `verifyServer()` **нет try/catch**, а вызов из Code не await-ится внутри общего `verify()` catch: [validateResponse:1093–1111](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte#L1093-L1111). Сетевой отказ ведёт туда же через rejected fetch.

## Runtime-результат

| Ответ/сбой | Состояния при отправке Code | UI после отказа | Восстановление |
| --- | --- | --- | --- |
| 200 `{verified:false}` | code → verifying → **error** | Code закрыт, отображается ошибка | Нативный клик по checkbox вызывает новый verify → GET challenge → новый PoW → новый Code |
| HTTP 400 | code → verifying | Code закрыт; остаётся **verifying**, unhandled rejection | Checkbox не начинает verify в verifying |
| HTTP 401 | То же | То же | То же |
| HTTP 422 | То же | То же | То же |
| Обрыв TCP/сетевая ошибка | То же | То же | То же; в Chromium наблюдались 3 транспортные отправки одного POST при обрыве |

Для всех пяти случаев: автоматического reset и автоматического GET нового challenge после отказа **нет**; сохранён исходный PoW payload; `verified` и `serververification` не генерируются. Генерируются `statechange`; для нормального отказа последним является `error`, для исключения — `verifying`. Отдельное событие `error` в этой ветке не dispatch-ится. Обработчик `unhandledrejection` существует только в тестовом runner для наблюдения, в приложение не добавляется.

При 200 false последующий **пользовательский** клик по штатному checkbox вызывает `verify()` только вне состояния verifying: [onCheckboxChange:776–794](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte#L776-L794). Новый verify очищает payload и начинает PoW заново; новая Code-компонента имеет пустой input. Это подтверждено без custom fetch/verifyFunction/внешнего reset.

`reset()` сам по себе не загружает challenge, только очищает payload/controller/timer и меняет state: [1194–1214](https://github.com/altcha-org/altcha/blob/f9217276fe9d6dc879b005d37f1d96155f4ab9e1/src/Widget.svelte#L1194-L1214). При истечении подписанного expiresAt виджет переходит в expired; после этого возможна новая обычная попытка. Page/form reset, повторная загрузка страницы и публичный widget.reset() также существуют, но frontend-обход для ошибок сети здесь не добавлен.

## Выбранная стратегия

**Новый challenge по нативному действию пользователя после HTTP 200 false** — вариант B с явным уточнением: переход не автоматический. Вариант A (несколько вводов одного изображения без нового PoW) штатный UI не предоставляет. Для HTTP/network исключений действует ограничение C до expiry/reset/перезагрузки. Серверным ответом нельзя приказать этому виджету автоматически reset или открыть старый Code.

Для production `pow+image` ожидаемые отказы после разбора PoW payload возвращают 200 `{verified:false,reason:CODE}` без payload. На одно изображение допускается **один структурно корректный ответ с подлинным PoW**. Неправильный ответ атомарно делает изображение `failed`, attempts=1, но не создаёт `pow-used` или token permit. Правильный ответ на уже закрытое изображение отвергается; следующий шанс — новое изображение и PoW через штатный checkbox/reload. Так не создаётся ложного обещания повторного ввода того же изображения.

Отсутствующий/пустой/некорректного формата code и неправильный PoW не считаются догадкой, не закрывают изображение и не выдают токен. Только корректный PoW + допустимый по алфавиту/длине ответ попадают в Lua-сравнение. При успехе **один** Lua-вызов помечает image completed, attempts=1, погашает PoW и создаёт единственный token permit. Гонки между верными и неверными ответами имеют одного победителя состояния; после первой догадки изображение не переоткрывается.

`CAPTCHA_IMAGE_MAX_ATTEMPTS=3` исключён: он ошибочно обещал бы три ввода одного изображения. Настройка с таким именем отклоняется при старте с объяснением. Вместо неё `CAPTCHA_IMAGE_RATE_LIMIT=10` — максимум догадок по **всем свежим image challenge одного IP за 60 секунд**, общий через Redis для реплик. Неправильные и правильные первые ответы учитываются одинаково. Дополнительно остаётся общий HTTP rate limit. Это не идентификация пользователя; NAT/proxy и смена IP — ограничения выбранной области действия.

## Воспроизведение и ограничения

- `npm run test:retry:interactive` — пять изолированных HTTP fixtures с настоящим виджетом и настоящим обрывом TCP. Изображение в этом исследовательском fixture контролируемое; это не production генератор или verification mock, выдающий фиктивный успех.
- `npm run test:browser:interactive` — восемь сценариев, включая настоящий PNG генератор, неверный code → error → нативный checkbox → новый challenge → правильный ответ, reload и image+HIS.
- `npm run test:browser` — те же harness через Playwright; `test/browser/code-retry.test.ts` и `native.test.ts`.

Тестовый oracle для правильного ответа зарегистрирован **только** в `test/browser/harness.ts`; его нет в `src`, собранном сервере или примерах frontend. Никаких ответов/секретов из production API тестам не раскрывается.

503 хранилища/генерации, глобальный HTTP 429, schema rejection до разбора payload и реальная потеря сети сохраняют описанное ограничение виджета: сервер не может гарантировать восстановление в Code-пути. Fail-closed важнее выдачи результата при неизвестном состоянии; frontend-адаптер для такого восстановления не вводился.
