-- Запросы модуля integrations. Схема — migrations/0029_integrations. Генерация: `make sqlc`.

-- name: UpsertIntegrationAccount :exec
-- Подключение аккаунта. Повторное подключение (сменил аккаунт Google, отозвал
-- доступ, переподключается после ротации ключа) ЗАМЕНЯЕТ строку, а не плодит
-- вторую: одно подключение на провайдера в пространстве — рамка MVP, и она же
-- уникальный индекс, служащий здесь арбитром ON CONFLICT.
INSERT INTO integration_accounts (
    id, workspace_id, provider, external_account_id, external_email, refresh_token, scopes, connected_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (workspace_id, provider) DO UPDATE SET
    external_account_id = EXCLUDED.external_account_id,
    external_email      = EXCLUDED.external_email,
    refresh_token       = EXCLUDED.refresh_token,
    scopes              = EXCLUDED.scopes,
    connected_by        = EXCLUDED.connected_by,
    connected_at        = now();

-- name: GetIntegrationAccount :one
-- Подключение пространства. refresh_token едет шифротекстом и наружу модуля не
-- выходит: расшифровывает его только сервис, и только чтобы сходить к провайдеру.
SELECT id, workspace_id, provider, external_account_id, external_email, refresh_token, scopes, connected_by, connected_at
FROM integration_accounts
WHERE workspace_id = $1 AND provider = $2;

-- name: UpdateIntegrationAccountToken :exec
-- Провайдер прислал новый refresh взамен использованного. Меняется ТОЛЬКО
-- токен: connected_at и connected_by остаются прежними — ротация на стороне
-- провайдера не является новым подключением и не должна выглядеть им на экране.
UPDATE integration_accounts SET refresh_token = $2 WHERE id = $1;

-- name: DeleteIntegrationAccount :one
-- Отключение. RETURNING отдаёт токен на отзыв у провайдера: прочитать его
-- отдельным запросом ДО удаления значит открыть окно, в котором строка уже
-- прочитана, но ещё жива. Формы, привязанные к этому аккаунту, уносит каскад.
DELETE FROM integration_accounts
WHERE workspace_id = $1 AND provider = $2
RETURNING refresh_token;

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
-- workspace_id приезжает джойном из аккаунта: он нужен, чтобы спросить право, а
-- второй запрос за ним означал бы окно между проверкой и действием.
SELECT fi.id, fi.form_id, fi.account_id, fi.name, fi.spreadsheet_id, fi.spreadsheet_url,
       fi.sheet_id, fi.sheet_title, fi.columns, fi.enabled, fi.status, fi.backfill_before,
       fi.last_error, fi.last_delivered_at, ia.workspace_id, ia.external_email
FROM form_integrations fi
JOIN integration_accounts ia ON ia.id = fi.account_id
WHERE fi.form_id = $1
ORDER BY fi.id;

-- name: ListEnabledFormIntegrations :many
-- Кому доставлять принятый ответ. Выключенные связки пропускаются здесь, а не
-- в диспетчере: событие, которое некому доставить, лучше не заводить вовсе.
SELECT id FROM form_integrations WHERE form_id = $1 AND enabled;

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
UPDATE form_integrations
SET spreadsheet_id = $3, spreadsheet_url = $4, sheet_id = $5, sheet_title = $6,
    columns = $7, status = $8, backfill_before = NULL, last_error = NULL
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
       fi.sheet_id, fi.sheet_title, fi.columns, fi.enabled, fi.status, fi.backfill_before,
       fi.last_error, fi.last_delivered_at, ia.workspace_id, ia.external_email
FROM form_integrations fi
JOIN integration_accounts ia ON ia.id = fi.account_id
WHERE fi.id = $1;

-- name: GetIntegrationAccountByID :one
SELECT id, workspace_id, provider, external_account_id, external_email, refresh_token, scopes, connected_by, connected_at
FROM integration_accounts
WHERE id = $1;

-- name: UpdateFormIntegrationColumns :exec
-- Колонки листа изменились (в форме появился новый вопрос). Только добавление:
-- удалённый вопрос свою колонку не теряет, иначе данные прошлых версий уехали бы
-- под чужие заголовки.
UPDATE form_integrations SET columns = $2 WHERE id = $1;

-- name: MarkFormIntegrationDelivered :exec
-- Успешная доставка: гасим прошлую ошибку и возвращаем статус в live — сломанная
-- интеграция, которая заработала, обязана перестать краснеть в кабинете.
UPDATE form_integrations
SET last_delivered_at = now(), last_error = NULL,
    -- Статус возвращается в live только из broken: сломанная интеграция, которая
    -- заработала, обязана перестать краснеть в кабинете. Идущий ПЕРЕНОС этой
    -- пометкой не сбивается — иначе первая же доставленная пачка объявила бы
    -- догрузку законченной, и остальные ответы не доехали бы никогда.
    status = CASE WHEN status = 'broken' THEN 'live' ELSE status END
WHERE id = $1;

-- name: MarkFormIntegrationBroken :exec
-- Доставка невозможна без человека (доступ отозван, таблица удалена). Причина
-- показывается в кабинете; ретраить такое до конца времён смысла нет.
UPDATE form_integrations SET status = 'broken', last_error = $2 WHERE id = $1;

-- name: StartFormIntegrationBackfill :exec
-- Начало догрузки: статус backfilling и отсечка. Всё, что пришло ДО неё, кладёт
-- догрузка; всё, что после, — живая очередь. Границы не пересекаются.
UPDATE form_integrations
SET status = 'backfilling', backfill_before = $2, last_error = NULL
WHERE id = $1;

-- name: FinishFormIntegrationBackfill :exec
-- Догрузка кончилась: доставка становится живой.
--
-- Отсечка НЕ гасится и остаётся границей переноса навсегда. Она нужна и после:
-- живое событие, поставленное до старта переноса и доехавшее после его конца,
-- относится к ответу, который перенос уже положил в лист, — без границы он лёг
-- бы туда вторым разом.
UPDATE form_integrations
SET status = 'live'
WHERE id = $1;
