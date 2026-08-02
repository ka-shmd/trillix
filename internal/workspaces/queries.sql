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

-- name: GetAccessContext :one
-- Всё, что нужно для решения о доступе, ОДНОЙ поездкой: роль спрашивающего,
-- личное ли пространство, кто его владелец и какое оно по счёту среди командных
-- пространств этого владельца (по времени создания).
--
-- Ранг нужен заморозке: когда тариф владельца упал, доступными остаются личное
-- и самые старые командные — «какие именно» решает не выбор пользователя, а
-- детерминированный порядок, иначе после даунгрейда состав доступного менялся
-- бы от запроса к запросу.
SELECT m.role,
       (w.personal_user_id IS NOT NULL)::bool AS is_personal,
       o.user_id AS owner_id,
       (SELECT count(*) FROM workspaces w2
          JOIN workspace_members o2 ON o2.workspace_id = w2.id AND o2.role = 'owner'
         WHERE o2.user_id = o.user_id
           AND w2.personal_user_id IS NULL
           AND (w2.created_at, w2.id) <= (w.created_at, w.id))::bigint AS team_rank
FROM workspace_members m
JOIN workspaces w ON w.id = m.workspace_id
JOIN workspace_members o ON o.workspace_id = w.id AND o.role = 'owner'
WHERE m.workspace_id = $1 AND m.user_id = $2;

-- name: PurgeExpiredInvitations :execrows
-- Фоновая чистка: истёкшие и уже использованные приглашения не нужны никому —
-- ни ссылка, ни история (кто кого звал, видно по членству). Индекс
-- idx_invitations_expires заведён ровно под этот запрос.
DELETE FROM invitations WHERE expires_at < now() OR used_at IS NOT NULL;
