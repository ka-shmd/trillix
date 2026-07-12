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
RETURNING id, workspace_id, title, slug, status, published_version_id, created_at, updated_at;

-- name: GetForm :one
-- Полная форма, включая черновик схемы: GET /forms/{id} отдаёт draft_schema
-- (заглушка редактора в фазе 2, живой билдер — в фазе 3). published_version — номер
-- опубликованной версии (NULL для черновика), для шапки билдера «версия N».
SELECT f.id, f.workspace_id, f.title, f.slug, f.status, f.draft_schema, f.published_version_id,
    fv.version AS published_version,
    f.created_at, f.updated_at
FROM forms f
LEFT JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.id = $1;

-- name: ListFormsFirstPage :many
-- Первая страница списка форм воркспейса: свежие правки сверху. limit+1 строк —
-- вызывающий по «лишней» строке понимает, есть ли следующая страница.
SELECT f.id, f.workspace_id, f.title, f.slug, f.status, f.published_version_id,
    fv.version AS published_version,
    f.created_at, f.updated_at
FROM forms f
LEFT JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.workspace_id = $1
ORDER BY f.updated_at DESC, f.id DESC
LIMIT $2;

-- name: ListFormsAfter :many
-- Следующая страница составным курсором (updated_at, id): строго «старше» якоря
-- по паре колонок — стабильно даже если форму отредактировали во время листания.
SELECT f.id, f.workspace_id, f.title, f.slug, f.status, f.published_version_id,
    fv.version AS published_version,
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
UPDATE forms
SET title = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, title, slug, status, published_version_id, created_at, updated_at;

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
RETURNING id, workspace_id, title, slug, status, draft_schema, published_version_id, created_at, updated_at;

-- name: DeleteForm :execrows
-- Удаляет только в пределах воркспейса; возвращает число удалённых строк
-- (0 → чужая/несуществующая форма).
DELETE FROM forms
WHERE id = $1 AND workspace_id = $2;

-- name: GetPublishedFormBySlug :one
-- Публичная выдача формы по slug: title + схема ОПУБЛИКОВАННОЙ версии. INNER JOIN и
-- status='published' гарантируют, что черновик/закрытая форма не вернут строку
-- (вызывающий → 404, приватное не раскрывается). published_version_id — источник
-- ETag (иммутабелен на версию).
SELECT f.title, fv.version, fv.schema, f.published_version_id
FROM forms f
JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.slug = $1 AND f.status = 'published';

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
RETURNING id, workspace_id, title, slug, status, published_version_id, created_at, updated_at;

-- name: SetFormClosed :one
-- Снятие с публикации: status='closed'. published_version_id не трогаем — знаем,
-- какая версия была последней опубликованной. В пределах воркспейса.
UPDATE forms
SET status = 'closed', updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, title, slug, status, published_version_id, created_at, updated_at;
