-- Запросы модуля workspaces. Схема — migrations/0002_auth (таблицы workspaces,
-- workspace_members). Генерация: `make sqlc`.

-- name: ListWorkspacesByUser :many
-- Пространства, в которых состоит пользователь. JOIN через workspace_members:
-- возвращаются только пространства с членством (инвариант доступа — id из URL
-- права не даёт). Личное создаётся регистрацией и всегда первое: сортировка по
-- created_at ставит его в начало, потому что оно старше любого командного.
--
-- is_personal вычисляется сравнением с personal_user_id, а не отдаётся сырым:
-- кабинету важно «личное ли оно ДЛЯ МЕНЯ», а не чьё оно вообще. IS NOT DISTINCT
-- FROM, а не «=»: у командного пространства personal_user_id равен NULL, и
-- обычное сравнение дало бы NULL вместо false — то есть непустой bool в Go.
SELECT w.id, w.name, w.created_at,
       (w.personal_user_id IS NOT DISTINCT FROM m.user_id) AS is_personal
FROM workspace_members m
JOIN workspaces w ON w.id = m.workspace_id
WHERE m.user_id = $1
ORDER BY w.created_at ASC;

-- name: CreateTeamWorkspace :one
-- КОМАНДНОЕ пространство: personal_user_id остаётся NULL — личное заводит
-- только транзакция регистрации (internal/auth), и оно у аккаунта ровно одно
-- (UNIQUE в 0016). Владельца добавляет отдельная строка членства в той же
-- транзакции: воркспейс без владельца — пространство, у которого нет плана.
INSERT INTO workspaces (id, name)
VALUES ($1, $2)
RETURNING id, name, created_at;

-- name: GetMemberRole :one
-- Роль участника: основа проверки прав (Can). Нет строки → не участник, и это
-- 404, а не 403 — существование чужого пространства не раскрывается.
SELECT role
FROM workspace_members
WHERE workspace_id = $1 AND user_id = $2;
