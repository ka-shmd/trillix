-- Запросы модуля forms. Схема — migrations/0003_forms. Генерация: `make sqlc`.

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
-- (заглушка редактора в фазе 2, живой билдер — в фазе 3).
SELECT id, workspace_id, title, slug, status, draft_schema, published_version_id, created_at, updated_at
FROM forms
WHERE id = $1;

-- name: ListFormsFirstPage :many
-- Первая страница списка форм воркспейса: свежие правки сверху. limit+1 строк —
-- вызывающий по «лишней» строке понимает, есть ли следующая страница.
SELECT id, workspace_id, title, slug, status, published_version_id, created_at, updated_at
FROM forms
WHERE workspace_id = $1
ORDER BY updated_at DESC, id DESC
LIMIT $2;

-- name: ListFormsAfter :many
-- Следующая страница составным курсором (updated_at, id): строго «старше» якоря
-- по паре колонок — стабильно даже если форму отредактировали во время листания.
SELECT id, workspace_id, title, slug, status, published_version_id, created_at, updated_at
FROM forms
WHERE workspace_id = $1
  AND (updated_at, id) < (sqlc.arg(cursor_updated_at)::timestamptz, sqlc.arg(cursor_id)::uuid)
ORDER BY updated_at DESC, id DESC
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
