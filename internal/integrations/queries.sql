-- Запросы модуля integrations. Схема — migrations/0029_integrations + 0037
-- (подключение принадлежит человеку). Генерация: `make sqlc`.

-- name: UpsertIntegrationAccount :one
-- Подключение аккаунта. Арбитр ON CONFLICT — ВНЕШНИЙ аккаунт, а не провайдер:
-- аккаунтов Google у человека сколько угодно, но повторный заход тем же
-- аккаунтом (переподключение после отзыва доступа или ротации ключа) обязан
-- обновить строку, а не завести вторую с тем же Диском.
--
-- Мина: RETURNING id отдаёт id ПЕРЕЖИВШЕЙ строки, а не сгенерированный вызовом.
-- При обновлении они разные, и взять свой значило бы вернуть экрану аккаунт,
-- которого в базе нет.
INSERT INTO integration_accounts (
    id, user_id, provider, external_account_id, external_email, refresh_token, scopes
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (user_id, provider, external_account_id) DO UPDATE SET
    external_email = EXCLUDED.external_email,
    refresh_token  = EXCLUDED.refresh_token,
    scopes         = EXCLUDED.scopes,
    connected_at   = now(),
    -- Переподключение и есть лечение отозванного согласия: свежий refresh-токен
    -- получен, значит пометка мёртвого подключения (0061) снимается тем же
    -- оператором. Отдельным запросом её гасить нельзя — между ними подключение
    -- выглядело бы рабочим и мёртвым одновременно.
    access_lost_at = NULL
RETURNING id;

-- name: ListIntegrationAccountsByUser :many
-- Аккаунты человека — то, из чего он выбирает в окне связки. refresh_token едет
-- шифротекстом и наружу модуля не выходит: расшифровывает его только сервис, и
-- только чтобы сходить к провайдеру.
--
-- Порядок по connected_at: подключённый первым стоит первым и не прыгает при
-- перерисовке, а свежеподключённый оказывается внизу — там, где его ищут.
SELECT id, user_id, provider, external_account_id, external_email, refresh_token, scopes, connected_at, access_lost_at
FROM integration_accounts
WHERE user_id = $1 AND provider = $2
ORDER BY connected_at, id;

-- name: UpdateIntegrationAccountToken :exec
-- Провайдер прислал новый refresh взамен использованного. Меняется ТОЛЬКО
-- токен: connected_at и user_id остаются прежними — ротация на стороне
-- провайдера не является новым подключением и не должна выглядеть им на экране.
UPDATE integration_accounts SET refresh_token = $2 WHERE id = $1;

-- name: DeleteIntegrationAccount :one
-- Отключение ОДНОГО аккаунта. RETURNING отдаёт токен на отзыв у провайдера:
-- прочитать его отдельным запросом ДО удаления значит открыть окно, в котором
-- строка уже прочитана, но ещё жива. Связки этого аккаунта уносит каскад.
--
-- user_id в условии не украшение: id аккаунта приезжает из адреса и правом
-- доступа не является (инвариант 1). Чужой аккаунт отсюда не отключить.
DELETE FROM integration_accounts
WHERE id = $1 AND user_id = $2
RETURNING refresh_token;

-- name: MarkIntegrationAccountAccessLost :exec
-- Провайдер отказал в обновлении токена: согласия на этот аккаунт больше нет
-- (0061). Помечается ПОДКЛЮЧЕНИЕ, а не связка, которая об этом узнала: не
-- работает ни одна связка этого аккаунта, во всех формах и пространствах.
--
-- Условие access_lost_at IS NULL держит ПЕРВЫЙ момент отказа: у аккаунта с
-- десятком форм каждая доставка приносила бы свежий now(), и «когда именно
-- перестало работать» стало бы «когда мы в последний раз попробовали».
UPDATE integration_accounts SET access_lost_at = $2 WHERE id = $1 AND access_lost_at IS NULL;

-- name: ClearIntegrationAccountAccessLost :exec
-- Токен снова работает: провайдер отдал access по нашему refresh. Пометка
-- гаснет здесь, а не только при переподключении, — согласие могли вернуть в
-- самом Google, и тогда чинить человеку нечего.
UPDATE integration_accounts SET access_lost_at = NULL WHERE id = $1;

-- name: InsertFormIntegration :exec
-- Привязка формы к созданной таблице. Уникальный индекс по form_id держит рамку
-- «одна таблица на форму»: повторная привязка — это сначала отвязка.
INSERT INTO form_integrations (
    id, form_id, account_id, name, spreadsheet_id, spreadsheet_url, sheet_id, sheet_title, columns, status
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);

-- name: ListFormIntegrations :many
-- Связки формы — их сколько угодно (интеграция это правило доставки, а не
-- состояние формы). Порядок по id: UUIDv7 монотонен по времени, значит в списке
-- они идут в порядке подключения и не прыгают при перерисовке.
--
-- workspace_id приезжает джойном из ФОРМЫ, а не из аккаунта: с 0037 аккаунт
-- принадлежит человеку и пространства не знает вовсе. Право спрашивается по
-- пространству формы, а user_id аккаунта едет рядом — по нему сторож доставки
-- проверяет, что владелец аккаунта всё ещё участник этого пространства.
SELECT fi.id, fi.form_id, fi.account_id, fi.name, fi.spreadsheet_id, fi.spreadsheet_url,
       fi.sheet_id, fi.sheet_title, fi.columns, fi.enabled, fi.status,
       fi.last_error, fi.last_delivered_at, f.workspace_id, ia.user_id, ia.external_email,
       (SELECT count(*) FROM sheet_queue q WHERE q.link_id = fi.id) AS queued
FROM form_integrations fi
JOIN integration_accounts ia ON ia.id = fi.account_id
JOIN forms f ON f.id = fi.form_id
WHERE fi.form_id = $1
ORDER BY fi.id;

-- name: DeleteFormIntegration :execrows
-- Удаление ОДНОЙ связки. form_id в условии не украшение: id связки приезжает из
-- адреса, и связка обязана принадлежать той форме, к которой спрашивают доступ
-- (инвариант 1: id из URL правом доступа не является).
--
-- Сама таблица в Диске автора остаётся: продукт не трогает чужие файлы и уж тем
-- более не удаляет их за человека.
DELETE FROM form_integrations WHERE id = $1 AND form_id = $2;

-- name: UpdateFormIntegrationTarget :execrows
-- Связка переезжает в другой лист (правка на том же экране, что и подключение).
-- Строки, уже доставленные в прежний лист, остаются там: продукт не убирает за
-- человеком в его же таблице.
--
-- account_id переезжает ВМЕСТЕ с целью и отдельно не меняется: под scope
-- drive.file таблица видна только тому аккаунту, который её создал (или которому
-- её выдали через окно выбора), поэтому «сменить аккаунт, оставив лист» — это
-- запись чужим токеном в файл, которого он не видит, то есть 404 и красная
-- связка. Одно поле без другого здесь означает сломанную интеграцию.
UPDATE form_integrations
SET account_id = $3, spreadsheet_id = $4, spreadsheet_url = $5, sheet_id = $6,
    sheet_title = $7, columns = $8, status = 'live', last_error = NULL,
    failing_since = NULL, consecutive_failures = 0, next_attempt_at = now()
WHERE id = $1 AND form_id = $2;

-- name: UpdateFormIntegrationSettings :execrows
-- Правка связки: подпись и тумблер. Тем же запросом, что и проверка
-- принадлежности форме.
UPDATE form_integrations SET name = $3, enabled = $4 WHERE id = $1 AND form_id = $2;

-- name: GetFormIntegrationByID :one
-- Привязка по своему id — путь фоновой доставки: событие несёт id привязки, а не
-- формы, поэтому отвязка и повторная привязка не заставят старое событие писать
-- в новую таблицу.
SELECT fi.id, fi.form_id, fi.account_id, fi.name, fi.spreadsheet_id, fi.spreadsheet_url,
       fi.sheet_id, fi.sheet_title, fi.columns, fi.enabled, fi.status,
       fi.last_error, fi.last_delivered_at, f.workspace_id, ia.user_id, ia.external_email,
       (SELECT count(*) FROM sheet_queue q WHERE q.link_id = fi.id) AS queued
FROM form_integrations fi
JOIN integration_accounts ia ON ia.id = fi.account_id
JOIN forms f ON f.id = fi.form_id
WHERE fi.id = $1;

-- name: GetIntegrationAccountByID :one
-- Аккаунт по своему id — путь доставки (связка несёт account_id) и путь проверки
-- «аккаунт мой» перед выдачей токена или списка файлов.
SELECT id, user_id, provider, external_account_id, external_email, refresh_token, scopes, connected_at, access_lost_at
FROM integration_accounts
WHERE id = $1;

-- name: UpdateFormIntegrationColumns :exec
-- Колонки листа изменились (в форме появился новый вопрос). Только добавление:
-- удалённый вопрос свою колонку не теряет, иначе данные прошлых версий уехали бы
-- под чужие заголовки.
UPDATE form_integrations SET columns = $2 WHERE id = $1;

-- name: MarkFormIntegrationDelivered :exec
-- Успех: гасим неудачи и время следующей попытки — очередь этой связки поедет
-- дальше тем же тиком.
--
-- Статус не трогается вовсе: доставщик сломанную связку не берёт (DueSheetLinks),
-- поэтому успешная доставка при status = 'broken' невозможна, а лечит поломку
-- человек — правкой цели, перезаливом или проверкой связи.
UPDATE form_integrations
SET last_delivered_at = now(), last_error = NULL, failing_since = NULL,
    consecutive_failures = 0, next_attempt_at = now()
WHERE id = $1;

-- name: ClearFormIntegrationError :exec
-- Связка снова годна к записи: гасим причину и возвращаем из broken в live.
--
-- last_delivered_at НЕ трогаем, хотя MarkFormIntegrationDelivered делает ровно
-- то же самое плюс его: доставки здесь не было, и ставить её время значит врать
-- про ответ, которого не приезжало.
UPDATE form_integrations
SET last_error = NULL, status = 'live', failing_since = NULL,
    consecutive_failures = 0, next_attempt_at = now()
WHERE id = $1;

-- name: MarkFormIntegrationBroken :exec
-- Доставка невозможна без человека (доступ отозван, таблица удалена). Причина
-- показывается в кабинете; ретраить такое до конца времён смысла нет.
UPDATE form_integrations SET status = 'broken', last_error = $2 WHERE id = $1;

-- name: MarkFormIntegrationFailed :exec
-- Неудача усыпляет СВЯЗКУ, а не строку очереди: лежащий лист получает одну
-- попытку за окно бэкоффа, сколько бы ответов ни ждало. В общем outbox
-- расписание жило у СОБЫТИЯ, и тысяча накопленных ответов давала тысячу
-- запросов в час в одну и ту же мёртвую таблицу.
--
-- failing_since держит ПЕРВЫЙ отказ подряд (COALESCE): по нему считаются сутки
-- до поломки, и каждая следующая неудача не должна сдвигать отсчёт.
UPDATE form_integrations
SET last_error = $2, consecutive_failures = consecutive_failures + 1,
    failing_since = COALESCE(failing_since, sqlc.arg(failing_since)),
    next_attempt_at = sqlc.arg(next_attempt_at)
WHERE id = $1;

-- name: DueSheetLinks :many
-- Связки, которым есть что везти и чьё время наступило. Сломанные не берутся
-- вовсе: их ответы копятся до починки, но в Google мы не ходим. Порядок — по
-- next_attempt_at: дольше всех ждущая связка едет первой.
--
-- workspace_id приезжает джойном из ФОРМЫ, user_id — из аккаунта: по этой паре
-- сторож доставки проверяет, что владелец подключения всё ещё участник
-- пространства формы.
SELECT fi.id, fi.form_id, fi.account_id, fi.name, fi.spreadsheet_id, fi.spreadsheet_url,
       fi.sheet_id, fi.sheet_title, fi.columns, fi.enabled, fi.status,
       fi.last_error, fi.last_delivered_at, fi.next_attempt_at, fi.failing_since,
       fi.consecutive_failures, f.workspace_id, ia.user_id, ia.external_email
FROM form_integrations fi
JOIN integration_accounts ia ON ia.id = fi.account_id
JOIN forms f ON f.id = fi.form_id
WHERE fi.enabled AND fi.status = 'live' AND fi.next_attempt_at <= now()
  AND EXISTS (SELECT 1 FROM sheet_queue q WHERE q.link_id = fi.id)
ORDER BY fi.next_attempt_at
LIMIT $1;

-- name: PendingSheetSubmissions :many
-- Что связка везёт следующим — в порядке постановки. submission_id вторым
-- ключом сортировки не украшение: перенос ставит всю пачку ОДНИМ утверждением,
-- enqueued_at у её строк одинаков, и хронологию в листе держит только он.
--
-- backfill едет рядом: от него зависит гранулярность журнала (одна запись на
-- пачку переноса против записи на каждый живой ответ), но ни порядок, ни
-- расписание он не трогает. enqueued_at — метка версии строки, см. соседний
-- DeleteSheetQueued.
SELECT submission_id, backfill, enqueued_at FROM sheet_queue
WHERE link_id = $1
ORDER BY enqueued_at, submission_id
LIMIT $2;

-- name: DeleteSheetQueued :exec
-- Ответы доставлены (или доставлять их больше не надо): строки очереди уходят,
-- история остаётся в журнале. Пачкой, потому что пачкой и доставляются: у
-- Таблиц один append увозит все строки тика разом.
--
-- ⚠ Мина: `enqueued_at <= $3` снимает ТУ ЖЕ строку, которую доставщик читал, а
-- не её тёзку. Между чтением очереди и этим удалением лежат два-три похода в
-- Google, и перезалив (или переезд на другую цель), успевший в это окно, уже
-- поставил те же ответы ЗАНОВО — под новый лист и с более поздним enqueued_at.
-- Без границы удаление сняло бы их: строки уехали бы в старый лист, а в новый
-- не попали бы вовсе — человек нажал «перезалить», получил 202 и недосчитался
-- ответов молча.
DELETE FROM sheet_queue
WHERE link_id = $1 AND submission_id = ANY(sqlc.arg(submission_ids)::uuid[])
  AND enqueued_at <= sqlc.arg(enqueued_before);

-- name: InsertSheetQueued :exec
-- Повтор одной доставки из журнала. Ключ-пара делает двойное нажатие безвредным.
INSERT INTO sheet_queue (link_id, submission_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: ClearSheetQueue :exec
-- Тумблер «выключить» — это «не доставлять», а не «доставить позже»: ждущие
-- ответы снимаются тем же движением, иначе включение вывалило бы их разом.
-- Второй вызывающий — перезалив: он чистит лист целиком и ставит очередь заново.
DELETE FROM sheet_queue WHERE link_id = $1;

-- name: EnqueueSheetBackfill :execrows
-- Перенос накопленных: ВСЕ ответы формы ложатся в очередь связки одним
-- утверждением. Цепочки событий-пачек с курсором больше нет — прогресс переноса
-- и есть сама очередь, поэтому перезапуск процесса его не теряет, а порядок
-- «сначала накопленные, потом живые» держится enqueued_at по построению.
--
-- NOT over_quota — тот же фильтр, что у доставки: ответ, скрытый от владельца до
-- оплаты, не должен всплыть у него же в Таблице.
--
-- ⚠ DO UPDATE, а не DO NOTHING: живой ответ, принятый за секунду до переноса,
-- уже стоит в очереди со СВОИМ enqueued_at — более ранним, чем у всей пачки. Без
-- перештамповки он лёг бы в лист ПЕРЕД ответами, которые старше его на месяцы.
INSERT INTO sheet_queue (link_id, submission_id, backfill)
SELECT $1, s.id, true FROM submissions s
WHERE s.form_id = $2 AND NOT s.over_quota
ON CONFLICT (link_id, submission_id)
DO UPDATE SET backfill = true, enqueued_at = now();

-- name: ExpiredSheetQueued :many
-- Ответы, ждущие дольше срока хранения: их снимают с очереди и пишут в журнал.
SELECT link_id, submission_id FROM sheet_queue
WHERE enqueued_at < $1
ORDER BY enqueued_at
LIMIT $2;

-- name: InsertIntegrationDelivery :exec
-- Одна попытка доставки в журнал (схема — migrations/0060). Пишется ПОСЛЕ
-- исхода, отдельным запросом: доставка идёт в чужой API, транзакции вокруг неё
-- нет и быть не может.
--
-- link_id приводится к uuid явно: с 0062 колонка допускает NULL (запись может
-- висеть на вебхуке), а связка Таблиц пишет сюда всегда непустой id.
INSERT INTO integration_deliveries (
    id, link_id, kind, submission_id, outcome, detail, row_count
) VALUES (
    sqlc.arg(id), sqlc.arg(link_id)::uuid, sqlc.arg(kind), sqlc.arg(submission_id),
    sqlc.arg(outcome), sqlc.arg(detail), sqlc.arg(row_count)
);

-- name: ListIntegrationDeliveries :many
-- Лента журнала: новые сверху, страница за страницей курсором.
--
-- Курсор — id, а не created_at: UUIDv7 монотонен по времени, а у пачек переноса
-- соседние попытки ложатся в одну миллисекунду, и порядок по времени между ними
-- не определён. Пустой курсор ($2 = uuid nil) означает первую страницу — сравнение
-- с ним истинно для любого id, потому что нулевой UUID меньше всякого другого.
SELECT id, link_id, kind, submission_id, outcome, detail, row_count, created_at, webhook_id, http_status
FROM integration_deliveries
WHERE link_id = sqlc.arg(link_id)::uuid
  AND (sqlc.arg(cursor)::uuid = '00000000-0000-0000-0000-000000000000'::uuid OR id < sqlc.arg(cursor))
ORDER BY id DESC
LIMIT sqlc.arg(page_size);

-- name: GetIntegrationDelivery :one
-- Одна запись журнала — предмет повтора. link_id в условии не украшение: id
-- записи приезжает из адреса и правом доступа не является (инвариант 1), а
-- право проверено по СВЯЗКЕ.
SELECT id, link_id, kind, submission_id, outcome, detail, row_count, created_at, webhook_id, http_status
FROM integration_deliveries
WHERE id = sqlc.arg(id) AND link_id = sqlc.arg(link_id)::uuid;

-- name: SubmissionAlreadyDelivered :one
-- Доехал ли ЭТОТ ответ в лист этой связки хоть раз. Спрашивается перед
-- повтором, и вопрос именно такой, а не «чем кончилась вот эта попытка»:
-- строка журнала = одна попытка, и у ответа, доехавшего со второго раза, первая
-- навсегда остаётся неудачной. Гейт по её исходу разрешал бы класть в чужую
-- таблицу второй экземпляр ответа, который там уже лежит.
SELECT EXISTS (
    SELECT 1 FROM integration_deliveries
    WHERE link_id = sqlc.arg(link_id)::uuid AND submission_id = sqlc.arg(submission_id) AND outcome = 'delivered'
);

-- name: DeleteOldIntegrationDeliveries :execrows
-- Уборка журнала по возрасту (задача integration-delivery-cleanup). Это уборка
-- места, а не защита: диагностика месячной давности никому не отвечает на
-- вопрос «почему вчера не уехало», а таблица растёт со скоростью потока ответов.
DELETE FROM integration_deliveries WHERE created_at < $1;

-- ВЕБХУКИ (фаза 28 DEV-PLAN, миграция 0062, спека docs/design/webhooks.md).

-- name: InsertFormWebhook :execrows
-- Новый вебхук формы. Потолок на форму проверяется ТЕМ ЖЕ утверждением: ноль
-- строк — потолок достигнут. Гонка двух одновременных сохранений даёт ±1 —
-- потолок гасит усиление «одна отправка формы → N запросов», а не держит
-- инвариант, и advisory-lock ради точности здесь не окупается.
-- secret пуст — подписи у вебхука нет (0063): заголовок не появляется вовсе.
-- headers пусты — своих заголовков нет (0064).
INSERT INTO form_webhooks (id, form_id, name, url, secret, headers, set_by)
SELECT sqlc.arg(id)::uuid, sqlc.arg(form_id)::uuid, sqlc.arg(name)::text,
       sqlc.arg(url)::text, sqlc.arg(secret)::bytea, sqlc.arg(headers)::bytea,
       sqlc.arg(set_by)::uuid
WHERE (SELECT count(*) FROM form_webhooks WHERE form_id = sqlc.arg(form_id)::uuid) < sqlc.arg(max_per_form)::int;

-- name: ListFormWebhooks :many
-- Вебхуки формы в порядке заведения (UUIDv7 монотонен по времени). queued —
-- сколько ответов ждут доставки: экран показывает «в очереди N», и отдельный
-- запрос на каждую строку списка был бы лишним.
SELECT w.id, w.form_id, w.name, w.url, w.secret, w.headers, w.set_by, w.enabled, w.status,
       w.last_error, w.last_delivered_at, w.created_at,
       (SELECT count(*) FROM webhook_queue q WHERE q.webhook_id = w.id) AS queued
FROM form_webhooks w
WHERE w.form_id = $1
ORDER BY w.id;

-- name: GetFormWebhook :one
-- Один вебхук формы. form_id в условии не украшение: id вебхука приезжает из
-- адреса и правом доступа не является (инвариант 1).
SELECT w.id, w.form_id, w.name, w.url, w.secret, w.headers, w.set_by, w.enabled, w.status,
       w.last_error, w.last_delivered_at, w.created_at,
       (SELECT count(*) FROM webhook_queue q WHERE q.webhook_id = w.id) AS queued
FROM form_webhooks w
WHERE w.id = $1 AND w.form_id = $2;

-- name: UpdateFormWebhookSettings :execrows
-- Подпись и тумблер.
UPDATE form_webhooks SET name = $3, enabled = $4 WHERE id = $1 AND form_id = $2;

-- name: UpdateFormWebhookURL :execrows
-- Адрес, переданный в правке (даже тот же), — новая ответственность и новая
-- попытка: правящий становится тем, чьё членство сторожит доставку, поломка
-- снимается, расписание цели начинается заново. Так пересохранение адреса
-- оставшимся участником возвращает в работу вебхук ушедшего (спека §9).
UPDATE form_webhooks
SET url = $3, set_by = $4, status = 'live', last_error = NULL, failing_since = NULL,
    consecutive_failures = 0, next_attempt_at = now()
WHERE id = $1 AND form_id = $2;

-- name: ClearFormWebhookSecret :execrows
-- Подпись выключена: секрета больше нет, и заголовок в запросах не появляется.
UPDATE form_webhooks SET secret = NULL WHERE id = $1 AND form_id = $2;

-- name: UpdateFormWebhookSecret :execrows
-- Перевыпуск секрета. Действует сразу, переходного окна со старым нет. Статус
-- не трогается: вернуть вебхук в работу может только проверка или новый адрес.
UPDATE form_webhooks SET secret = $3 WHERE id = $1 AND form_id = $2;

-- name: UpdateFormWebhookHeaders :execrows
-- Свои заголовки запроса (0064). Набор заменяется ЦЕЛИКОМ: он маленький, и
-- «добавить/убрать по одному» стоило бы трёх ручек вместо одной. NULL — своих
-- заголовков у вебхука нет.
UPDATE form_webhooks SET headers = $3 WHERE id = $1 AND form_id = $2;

-- name: DeleteFormWebhook :execrows
-- Удаление вебхука; очередь и журнал уходят каскадом.
DELETE FROM form_webhooks WHERE id = $1 AND form_id = $2;

-- name: ClearWebhookQueue :exec
-- Тумблер «выключить» — это «не доставлять», а не «доставить позже»: ждущие
-- ответы снимаются тем же движением, иначе включение вывалило бы их разом.
DELETE FROM webhook_queue WHERE webhook_id = $1;

-- name: DueWebhooks :many
-- Цели, которым есть что везти и чьё время наступило. Сломанные не берутся
-- вовсе: их ответы копятся до починки, но в сеть мы не ходим. Порядок — по
-- next_attempt_at: дольше всех ждущая цель едет первой.
--
-- workspace_id приезжает джойном из ФОРМЫ: по нему сторож проверяет, что тот,
-- кто задал адрес, всё ещё участник пространства.
SELECT w.id, w.form_id, w.name, w.url, w.secret, w.headers, w.set_by, w.enabled, w.status,
       w.last_error, w.last_delivered_at, w.created_at,
       w.next_attempt_at, w.failing_since, w.consecutive_failures, f.workspace_id
FROM form_webhooks w
JOIN forms f ON f.id = w.form_id
WHERE w.enabled AND w.status = 'live' AND w.next_attempt_at <= now()
  AND EXISTS (SELECT 1 FROM webhook_queue q WHERE q.webhook_id = w.id)
ORDER BY w.next_attempt_at
LIMIT $1;

-- name: PendingWebhookSubmissions :many
-- Что цель везёт следующим — в порядке постановки. submission_id вторым ключом
-- сортировки: у двух ответов, поставленных в одну миллисекунду, порядок между
-- собой иначе не определён, и пачка тика прыгала бы.
SELECT submission_id FROM webhook_queue
WHERE webhook_id = $1
ORDER BY enqueued_at, submission_id
LIMIT $2;

-- name: DeleteWebhookQueued :exec
-- Ответ доставлен (или доставлять его больше не надо): строка очереди уходит,
-- история остаётся в журнале.
DELETE FROM webhook_queue WHERE webhook_id = $1 AND submission_id = $2;

-- name: InsertWebhookQueued :exec
-- Повтор из журнала. Ключ-пара делает двойное нажатие безвредным.
INSERT INTO webhook_queue (webhook_id, submission_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: ExpiredWebhookQueued :many
-- Ответы, ждущие дольше срока хранения: их снимают с очереди и пишут в журнал.
SELECT webhook_id, submission_id FROM webhook_queue
WHERE enqueued_at < $1
ORDER BY enqueued_at
LIMIT $2;

-- name: MarkWebhookDelivered :exec
-- Успех: гасим неудачи и время следующей попытки — очередь этой цели поедет
-- дальше тем же тиком.
UPDATE form_webhooks
SET last_delivered_at = now(), last_error = NULL, failing_since = NULL,
    consecutive_failures = 0, next_attempt_at = now()
WHERE id = $1;

-- name: MarkWebhookFailed :exec
-- Неудача усыпляет ЦЕЛЬ, а не строку очереди: лежащий адрес получает одну
-- попытку за окно бэкоффа, сколько бы ответов ни ждало.
--
-- failing_since держит ПЕРВЫЙ момент отказа (COALESCE): по нему считаются сутки
-- до поломки, и каждая следующая неудача не должна сдвигать отсчёт.
UPDATE form_webhooks
SET last_error = $2, consecutive_failures = consecutive_failures + 1,
    failing_since = COALESCE(failing_since, sqlc.arg(failing_since)),
    next_attempt_at = sqlc.arg(next_attempt_at)
WHERE id = $1;

-- name: MarkWebhookBroken :exec
-- Доставка невозможна без человека: доставщик в эту цель больше не ходит, но
-- ответы продолжают копиться — починка увезёт их по порядку.
UPDATE form_webhooks SET status = 'broken', last_error = $2 WHERE id = $1;

-- name: ReviveWebhook :exec
-- Проверка прошла: цель снова в работе, расписание с нуля.
UPDATE form_webhooks
SET status = 'live', last_error = NULL, failing_since = NULL,
    consecutive_failures = 0, next_attempt_at = now()
WHERE id = $1;

-- name: InsertWebhookDelivery :exec
-- Одна попытка доставки в вебхук. http_status пуст, когда ответа не было вовсе
-- (таймаут, DNS, запрет адреса).
INSERT INTO integration_deliveries (
    id, webhook_id, kind, submission_id, outcome, detail, http_status
) VALUES ($1, $2, 'submission', $3, $4, $5, $6);

-- name: ListWebhookDeliveries :many
-- Лента журнала вебхука: новые сверху, страница курсором (тот же приём, что у
-- ленты связки).
SELECT id, link_id, kind, submission_id, outcome, detail, row_count, created_at, webhook_id, http_status
FROM integration_deliveries
WHERE webhook_id = sqlc.arg(webhook_id)::uuid
  AND (sqlc.arg(cursor)::uuid = '00000000-0000-0000-0000-000000000000'::uuid OR id < sqlc.arg(cursor))
ORDER BY id DESC
LIMIT sqlc.arg(page_size);

-- name: GetWebhookDelivery :one
-- Одна запись журнала вебхука — предмет повтора.
SELECT id, link_id, kind, submission_id, outcome, detail, row_count, created_at, webhook_id, http_status
FROM integration_deliveries
WHERE id = sqlc.arg(id) AND webhook_id = sqlc.arg(webhook_id)::uuid;

-- name: WebhookSubmissionDelivered :one
-- Доезжал ли ЭТОТ ответ в эту цель хоть раз. Спрашивается перед повтором — тот
-- же вопрос и тот же довод, что у связки Таблиц.
SELECT EXISTS (
    SELECT 1 FROM integration_deliveries
    WHERE webhook_id = sqlc.arg(webhook_id)::uuid AND submission_id = sqlc.arg(submission_id) AND outcome = 'delivered'
);
