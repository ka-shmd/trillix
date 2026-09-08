-- Запросы модуля templates. Схема — migrations/0059 (таблица form_templates).
-- Генерация: `make sqlc`.

-- name: ListWorkspaceTemplates :many
-- Шаблоны пространства («Мои» в галерее). Членство проверяет сервис — id из URL
-- правом не является; запрос никого не охраняет и адресует пространство одним id.
-- Свежие сверху, id — tie-break: тот же порядок, что у списка форм.
SELECT id, workspace_id, author_id, title, description, schema, visibility, created_at, updated_at
FROM form_templates
WHERE workspace_id = $1 AND visibility = 'private'
ORDER BY created_at DESC, id DESC;

-- name: ListPublicTemplates :many
-- Витрина: одна выборка на всех пользователей. Порядок — по возрастанию времени
-- создания: пока сортировки по популярности нет, витрину выстраивает тот, кто
-- заливал шаблоны, а не случай.
SELECT id, workspace_id, author_id, title, description, schema, visibility, created_at, updated_at
FROM form_templates
WHERE visibility = 'public'
ORDER BY created_at ASC, id ASC;

-- name: GetFormTemplate :one
-- Один шаблон вместе с тем, по чему решается доступ (visibility и workspace_id).
-- Права спрашивает сервис.
SELECT id, workspace_id, author_id, title, description, schema, visibility, created_at, updated_at
FROM form_templates
WHERE id = $1;

-- name: CreateFormTemplate :one
-- Заведение шаблона — и своего, и публичного: пару «видимость × пространство»
-- стережёт CHECK таблицы, поэтому отдельного запроса на каждый вид не нужно.
INSERT INTO form_templates (id, workspace_id, author_id, title, description, schema, visibility)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, workspace_id, author_id, title, description, schema, visibility, created_at, updated_at;

-- name: DeleteWorkspaceTemplate :execrows
-- Удаление СВОЕГО шаблона: пространство в условии, а не только id, — тот же
-- приём, что у форм. Публичный этим запросом не удаляется никогда (у него
-- workspace_id равен NULL, и сравнение не сойдётся ни с чем).
DELETE FROM form_templates WHERE id = $1 AND workspace_id = $2;
