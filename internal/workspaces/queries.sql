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

-- name: CreateInvitation :exec
-- Приглашение и письмо кладутся ОДНОЙ транзакцией (transactional outbox): либо
-- есть и ссылка, и письмо в очереди, либо ничего. Повторное приглашение тому же
-- адресу заменяет непринятое (частичный UNIQUE в 0017) — ON CONFLICT сносит
-- прежний токен, чтобы годной осталась ровно одна ссылка.
INSERT INTO invitations (token_hash, workspace_id, email, role, invited_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: DeletePendingInvitation :exec
-- Снимает непринятое приглашение адресу перед выдачей нового (и обслуживает
-- отзыв приглашения владельцем).
DELETE FROM invitations
WHERE workspace_id = $1 AND lower(email) = lower($2) AND used_at IS NULL;

-- name: GetInvitation :one
-- Приглашение по токену — для экрана «вас приглашают». Отдаёт заодно название
-- пространства: показать его нужно ДО принятия, а членства ещё нет.
SELECT i.workspace_id, i.email, i.role, i.expires_at, i.used_at, w.name AS workspace_name
FROM invitations i
JOIN workspaces w ON w.id = i.workspace_id
WHERE i.token_hash = $1;

-- name: ConsumeInvitation :one
-- Потребление токена атомарным UPDATE: повтор получает 0 строк, поэтому одной
-- ссылкой нельзя войти дважды, и гонка двух вкладок не создаёт двух членств.
UPDATE invitations
SET used_at = now()
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING workspace_id, email, role;

-- name: CountWorkspaceMembers :one
SELECT count(*)::bigint FROM workspace_members WHERE workspace_id = $1;

-- name: GetWorkspaceByID :one
SELECT id, name, created_at, (personal_user_id IS NOT NULL)::bool AS is_personal
FROM workspaces WHERE id = $1;

-- name: GetUserIDByEmail :one
SELECT id FROM users WHERE email = lower($1);

-- name: GetEmailByUserID :one
SELECT email FROM users WHERE id = $1;

-- name: ListWorkspaceMembers :many
-- Участники пространства: кто и в какой роли. Владелец первым (сортировка по
-- роли), дальше по времени вступления — порядок детерминированный.
SELECT m.user_id, u.email, m.role, m.created_at
FROM workspace_members m
JOIN users u ON u.id = m.user_id
WHERE m.workspace_id = $1
ORDER BY (m.role = 'owner') DESC, m.created_at ASC;

-- name: ListPendingInvitations :many
-- Непринятые и не истёкшие приглашения — их видно на той же странице, что и
-- участников: «позвали, но ещё не вошёл» — это состояние пространства.
SELECT email, role, expires_at
FROM invitations
WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()
ORDER BY created_at ASC;

-- name: DeleteMember :execrows
-- Удаление участника. role <> 'owner' в условии — сторож последнего владельца
-- на уровне запроса: владельца не удаляют вовсе, ни своей рукой, ни чужой.
DELETE FROM workspace_members
WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner';
