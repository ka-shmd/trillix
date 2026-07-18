-- Запросы модуля forms. Схема — migrations/0003_forms. Генерация: `make sqlc`.
--
-- published_version — номер (form_versions.version) текущей опубликованной версии
-- формы (NULL, пока форму не публиковали). Читающие запросы (Get/List) достают его
-- LEFT JOIN по published_version_id — тип nullable. Мутации его НЕ выбирают: сервис
-- и так знает версию (при публикации — из InsertFormVersion, иначе переносит из
-- заранее прочитанной формы), а коррелированный подзапрос в RETURNING sqlc считает
-- NOT NULL, из-за чего скан NULL (черновик) на них падал бы.

-- name: GetPersonalWorkspace :one
-- Личный воркспейс пользователя (в MVP — единственный, созданный при регистрации).
-- «Текущий воркспейс» дашборда, куда кладутся и откуда читаются формы.
SELECT workspace_id
FROM workspace_members
WHERE user_id = $1
ORDER BY created_at ASC
LIMIT 1;

-- name: IsWorkspaceMember :one
-- Проверка права доступа к ресурсу: состоит ли пользователь в воркспейсе формы.
-- Основа анти-IDOR — id формы из URL не доказывает право (ARCHITECTURE §4.3).
SELECT EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = $1 AND user_id = $2
);

-- name: CreateForm :one
INSERT INTO forms (id, workspace_id, title, slug)
VALUES ($1, $2, $3, $4)
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: CreateFormWithSchema :one
-- Как CreateForm, но с заданным именем и черновиком схемы: дубликация формы задаёт
-- name = «{база} (копия N)» и копирует draft_schema исходника; title (публичный
-- заголовок) копируется как есть. Статус — дефолтный draft (публикация не
-- переносится), поэтому published_version_id в RETURNING всегда NULL.
INSERT INTO forms (id, workspace_id, title, slug, name, draft_schema)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: GetForm :one
-- Полная форма, включая черновик схемы: GET /forms/{id} отдаёт draft_schema
-- (заглушка редактора в фазе 2, живой билдер — в фазе 3). published_version — номер
-- опубликованной версии (NULL для черновика), для шапки билдера «версия N».
SELECT f.id, f.workspace_id, f.name, f.title, f.slug, f.status, f.draft_schema, f.published_version_id,
    fv.version AS published_version,
    -- Черновик отличается от опубликованной версии → в шапке билдера бейдж «есть
    -- неопубликованные изменения». Сравнение JSONB (draft_schema и снапшот пишутся
    -- канонизированными, так что сразу после публикации они равны). Заголовок в
    -- версию не входит — переименование бейдж не поднимает. coalesce: без версии → false.
    coalesce(f.published_version_id IS NOT NULL AND f.draft_schema IS DISTINCT FROM fv.schema, false)::bool AS has_unpublished_changes,
    (SELECT count(*) FROM submissions s WHERE s.form_id = f.id) AS submission_count,
    -- Просмотры и конверсия (фаза 8.5 шаг 6). Два скалярных подзапроса — тот же
    -- идиом, что у submission_count выше; оба идут по idx_form_visits_form.
    -- Конверсия считается по визитам (submitted/total), а НЕ делением
    -- submission_count на visit_count: это разные множества (ответ мог прийти без
    -- визита), и их частное — не конверсия (ADR §10).
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id) AS visit_count,
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id AND v.submitted) AS visit_submitted_count,
    f.close_at, f.response_limit, f.closed_message,
    f.created_at, f.updated_at
FROM forms f
LEFT JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.id = $1;

-- name: GetFormBySlug :one
-- Та же полная форма, что GetForm, но по slug: приватный резолв формы для кабинета,
-- где URL редактора/ответов/шаринга адресуют форму коротким slug (как публичный
-- рендерер /r/{slug}), а не UUID. slug глобально уникален (UNIQUE) и стабилен
-- (nanoid, задаётся при создании, не меняется). Доступ проверяет service по
-- workspace_id строки (членство), сам slug права не даёт.
SELECT f.id, f.workspace_id, f.name, f.title, f.slug, f.status, f.draft_schema, f.published_version_id,
    fv.version AS published_version,
    coalesce(f.published_version_id IS NOT NULL AND f.draft_schema IS DISTINCT FROM fv.schema, false)::bool AS has_unpublished_changes,
    (SELECT count(*) FROM submissions s WHERE s.form_id = f.id) AS submission_count,
    -- Просмотры и конверсия (фаза 8.5 шаг 6). Два скалярных подзапроса — тот же
    -- идиом, что у submission_count выше; оба идут по idx_form_visits_form.
    -- Конверсия считается по визитам (submitted/total), а НЕ делением
    -- submission_count на visit_count: это разные множества (ответ мог прийти без
    -- визита), и их частное — не конверсия (ADR §10).
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id) AS visit_count,
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id AND v.submitted) AS visit_submitted_count,
    f.close_at, f.response_limit, f.closed_message,
    f.created_at, f.updated_at
FROM forms f
LEFT JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.slug = $1;

-- name: ListFormsFirstPage :many
-- Первая страница списка форм воркспейса: свежие правки сверху. limit+1 строк —
-- вызывающий по «лишней» строке понимает, есть ли следующая страница.
SELECT f.id, f.workspace_id, f.name, f.title, f.slug, f.status, f.published_version_id,
    fv.version AS published_version,
    coalesce(f.published_version_id IS NOT NULL AND f.draft_schema IS DISTINCT FROM fv.schema, false)::bool AS has_unpublished_changes,
    (SELECT count(*) FROM submissions s WHERE s.form_id = f.id) AS submission_count,
    -- Просмотры и конверсия (фаза 8.5 шаг 6). Два скалярных подзапроса — тот же
    -- идиом, что у submission_count выше; оба идут по idx_form_visits_form.
    -- Конверсия считается по визитам (submitted/total), а НЕ делением
    -- submission_count на visit_count: это разные множества (ответ мог прийти без
    -- визита), и их частное — не конверсия (ADR §10).
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id) AS visit_count,
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id AND v.submitted) AS visit_submitted_count,
    f.created_at, f.updated_at
FROM forms f
LEFT JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.workspace_id = $1
ORDER BY f.updated_at DESC, f.id DESC
LIMIT $2;

-- name: ListFormsAfter :many
-- Следующая страница составным курсором (updated_at, id): строго «старше» якоря
-- по паре колонок — стабильно даже если форму отредактировали во время листания.
SELECT f.id, f.workspace_id, f.name, f.title, f.slug, f.status, f.published_version_id,
    fv.version AS published_version,
    coalesce(f.published_version_id IS NOT NULL AND f.draft_schema IS DISTINCT FROM fv.schema, false)::bool AS has_unpublished_changes,
    (SELECT count(*) FROM submissions s WHERE s.form_id = f.id) AS submission_count,
    -- Просмотры и конверсия (фаза 8.5 шаг 6). Два скалярных подзапроса — тот же
    -- идиом, что у submission_count выше; оба идут по idx_form_visits_form.
    -- Конверсия считается по визитам (submitted/total), а НЕ делением
    -- submission_count на visit_count: это разные множества (ответ мог прийти без
    -- визита), и их частное — не конверсия (ADR §10).
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id) AS visit_count,
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id AND v.submitted) AS visit_submitted_count,
    f.created_at, f.updated_at
FROM forms f
LEFT JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.workspace_id = $1
  AND (f.updated_at, f.id) < (sqlc.arg(cursor_updated_at)::timestamptz, sqlc.arg(cursor_id)::uuid)
ORDER BY f.updated_at DESC, f.id DESC
LIMIT $2;

-- name: UpdateFormTitle :one
-- Возвращает строку только если форма принадлежит воркспейсу — иначе 0 строк
-- (service трактует это как «не найдена/чужая»). updated_at двигаем вручную.
-- title — ПУБЛИЧНЫЙ заголовок (первая строка билдера); имя дашборда — UpdateFormName.
UPDATE forms
SET title = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormName :one
-- Внутреннее имя формы (дашборд): переименование в кабинете и суффикс «(копия N)»
-- при дубле. Публичный заголовок (title) не трогает. В пределах воркспейса; 0 строк
-- (чужая/нет формы) → service трактует как 404. updated_at двигаем вручную.
UPDATE forms
SET name = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormCloseSettings :one
-- Живые настройки закрытия формы (фаза 8.5 шаг 4): дата, лимит, текст «приём
-- закрыт». Заменяют все три колонки разом (страница настроек шлёт полный набор;
-- NULL = ограничение снято) — колонки, а не JSONB-схема, т.к. настройка живая, а
-- схема снапшотится при публикации (ADR §10). В пределах воркспейса; 0 строк
-- (чужая/нет формы) → service трактует как 404. updated_at двигаем вручную.
UPDATE forms
SET close_at = $3, response_limit = $4, closed_message = $5, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: ListFormNames :many
-- Имена и заголовки всех форм воркспейса — для нумерации копий: сервис вычисляет
-- отображаемое имя (name ?? title) каждой формы и подбирает следующий «(копия N)»
-- без коллизий. Форм на воркспейс немного, грузятся разом.
SELECT name, title FROM forms WHERE workspace_id = $1;

-- name: UpdateFormDraftSchema :one
-- Автосейв билдера с оптимистичной блокировкой: строка обновляется, только если
-- форма в воркспейсе И её updated_at совпадает с присланным клиентом. Иначе 0
-- строк — service различает «чужая/нет формы» (проверено заранее) от расхождения
-- версии (updated_at сдвинула другая вкладка → 409). updated_at двигаем вручную.
UPDATE forms
SET draft_schema = $3, updated_at = now()
WHERE id = $1
  AND workspace_id = $2
  AND updated_at = sqlc.arg(expected_updated_at)::timestamptz
RETURNING id, workspace_id, name, title, slug, status, draft_schema, published_version_id, created_at, updated_at;

-- name: DeleteForm :execrows
-- Удаляет только в пределах воркспейса; возвращает число удалённых строк
-- (0 → чужая/несуществующая форма).
DELETE FROM forms
WHERE id = $1 AND workspace_id = $2;

-- name: GetPublicFormBySlug :one
-- Публичная выдача формы по slug: title + схема последней опубликованной версии +
-- статус и живые настройки закрытия (фаза 8.5 шаг 4). INNER JOIN по
-- published_version_id отсекает черновик (у него версии нет) → 0 строк → 404,
-- существование приватного не раскрывается. Закрытую (снятую вручную ИЛИ по
-- дате/лимиту) строку ОТДАЁМ: вызывающий вычислит FormClosed и покажет «приём
-- закрыт» — форма была публичной (инвариант 5 распространяется только на черновик).
-- submission_count считаем ТОЛЬКО при заданном лимите (иначе 0): у форм без лимита
-- лишний скан submissions на каждом открытии не нужен. published_version_id —
-- источник ETag (иммутабелен на версию); f.id (form_id) нужен приёму ответа.
SELECT f.id AS form_id, f.title, fv.version, fv.schema, f.published_version_id,
    f.status, f.close_at, f.response_limit, f.closed_message,
    CASE WHEN f.response_limit IS NOT NULL
         THEN (SELECT count(*) FROM submissions s WHERE s.form_id = f.id)
         ELSE 0 END::bigint AS submission_count
FROM forms f
JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.slug = $1;

-- name: ListFormVersions :many
-- Все опубликованные версии формы (снапшоты схем), по возрастанию номера. Нужен
-- CSV-экспорту (фаза 6): колонки — объединение блоков по всем версиям, а подписи
-- choice-опций берутся из версии, по которой отправлен ответ. Версий на форму
-- немного — грузятся разом. form_versions иммутабельна, порядок стабилен.
SELECT version, schema
FROM form_versions
WHERE form_id = $1
ORDER BY version;

-- name: NextFormVersion :one
-- Следующий номер версии формы: max+1 (1 для первой публикации). Уникальность
-- (form_id, version) в схеме страхует от гонки двух параллельных публикаций —
-- вторая упрётся в constraint. Каст к int, чтобы sqlc вывел не-nullable тип.
SELECT (coalesce(max(version), 0) + 1)::int AS next_version
FROM form_versions
WHERE form_id = $1;

-- name: InsertFormVersion :one
-- Иммутабельный снапшот черновика при публикации. Возвращает id — им проставляется
-- forms.published_version_id в той же транзакции.
INSERT INTO form_versions (id, form_id, version, schema)
VALUES ($1, $2, $3, $4)
RETURNING id, version;

-- name: SetFormPublished :one
-- Публикация: status='published' + ссылка на свежую версию. В пределах воркспейса;
-- 0 строк (чужая/нет формы) service трактует как 404. updated_at двигаем вручную.
UPDATE forms
SET status = 'published', published_version_id = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: SetFormClosed :one
-- Снятие с публикации: status='closed'. published_version_id не трогаем — знаем,
-- какая версия была последней опубликованной. В пределах воркспейса.
UPDATE forms
SET status = 'closed', updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;
