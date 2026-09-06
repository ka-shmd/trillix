-- Запросы модуля workspaces. Схема — migrations/0002_auth (таблицы workspaces,
-- workspace_members). Генерация: `make sqlc`.

-- name: ListWorkspacesByUser :many
-- Пространства, в которых состоит пользователь. JOIN через workspace_members:
-- возвращаются только пространства с членством (инвариант доступа — id из URL
-- права не даёт). Личное создаётся регистрацией и всегда первое: сортировка по
-- created_at ставит его в начало, потому что оно старше любого другого.
--
-- is_personal вычисляется сравнением с personal_user_id, а не отдаётся сырым:
-- кабинету важно «личное ли оно ДЛЯ МЕНЯ», а не чьё оно вообще. IS NOT DISTINCT
-- FROM, а не «=»: у неличного пространства personal_user_id равен NULL, и
-- обычное сравнение дало бы NULL вместо false — то есть непустой bool в Go.
--
-- form_count — сколько форм в пространстве (подпись рядом с названием в обзоре).
-- Подзапрос, а не второй поход в forms: обзор рисует ВСЕ пространства разом, и
-- отдельный запрос на каждое был бы N+1 ради одного числа. Мягкого удаления у
-- форм нет — считаются все строки, включая черновики.
--
-- owner_id и два ранга — ровно те же три величины и по тем же правилам, что у
-- GetAccessContext (см. ниже), только на ВЕСЬ список сразу. По ним сервис решает,
-- заморожено ли пространство для спрашивающего: сам список ходит на каждом экране
-- кабинета, и вызывать checkFrozen построчно значило бы платить N+1 за вывеску.
-- Лимиты сюда не читаются намеренно — их знает только entitlements.
SELECT w.id, w.slug, w.name, w.created_at,
       (w.personal_user_id IS NOT DISTINCT FROM m.user_id) AS is_personal,
       (SELECT count(*) FROM forms f WHERE f.workspace_id = w.id)::bigint AS form_count,
       o.user_id AS owner_id,
       CASE WHEN m.role = 'owner' THEN 1
            ELSE 1 + (SELECT count(*) FROM workspace_members m2
                       WHERE m2.workspace_id = m.workspace_id AND m2.role <> 'owner'
                         AND (m2.created_at, m2.user_id) <= (m.created_at, m.user_id))
       END::bigint AS member_rank,
       (SELECT count(*) FROM workspaces w2
          JOIN workspace_members o2 ON o2.workspace_id = w2.id AND o2.role = 'owner'
         WHERE o2.user_id = o.user_id
           AND w2.personal_user_id IS NULL
           AND (w2.created_at, w2.id) <= (w.created_at, w.id))::bigint AS team_rank
FROM workspace_members m
JOIN workspaces w ON w.id = m.workspace_id
JOIN workspace_members o ON o.workspace_id = w.id AND o.role = 'owner'
WHERE m.user_id = $1
ORDER BY w.created_at ASC;

-- name: CreateWorkspace :one
-- Обычное пространство: personal_user_id остаётся NULL. «Личное» — не отдельный
-- вид, а технический признак ровно с двумя следствиями: заводится вместе с
-- аккаунтом (его нельзя удалить и покинуть) и не замораживается. Всё
-- остальное — приглашения, роли, места, права — у пространств одинаковое.
-- Владельца добавляет отдельная строка членства в той же транзакции:
-- пространство без владельца — пространство без плана.
INSERT INTO workspaces (id, slug, name)
VALUES ($1, $2, $3)
RETURNING id, slug, name, created_at;

-- name: RenameWorkspace :one
-- Переименование пространства. Право спрашивает сервис (ActionWorkspaceManage);
-- запрос никого не охраняет и адресует пространство одним id.
UPDATE workspaces
SET name = $2
WHERE id = $1
RETURNING id, slug, name, created_at, (personal_user_id IS NOT NULL)::bool AS is_personal;

-- name: DeleteWorkspace :execrows
-- Удаление пространства со всем содержимым: формы, версии, ответы, визиты,
-- участники и приглашения уносит каскад (все FK на workspaces — ON DELETE
-- CASCADE). Объекты в бакете каскад не видит — их сносит сервис ДО этого
-- запроса.
--
-- personal_user_id IS NULL — сторож ЛИЧНОГО пространства на уровне запроса, а не
-- только в Go: человеку негде было бы жить, а формы и подписка остались бы без
-- места. Тот же приём, что «role <> 'owner'» в DeleteMember.
DELETE FROM workspaces WHERE id = $1 AND personal_user_id IS NULL;

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

-- name: GetWorkspaceByID :one
SELECT id, slug, name, created_at, (personal_user_id IS NOT NULL)::bool AS is_personal
FROM workspaces WHERE id = $1;

-- name: GetUserIDByEmail :one
-- Удалённый аккаунт — «такого нет»: адрес остаётся занятым (войти по нему
-- нельзя, но и переиспользовать тоже), а приглашать его владельцу незачем.
-- Слепота обязана совпадать со слепотой списка участников: иначе владелец не
-- видел бы человека в составе, но получал бы «он уже в пространстве».
SELECT id FROM users WHERE email = lower($1) AND deleted_at IS NULL;

-- name: GetEmailByUserID :one
SELECT email FROM users WHERE id = $1;

-- name: ListWorkspaceMembers :many
-- Участники пространства: кто и в какой роли. Владелец первым (сортировка по
-- роли), дальше по времени вступления — порядок детерминированный.
-- Удалённые аккаунты в составе не показываются: строка членства переживает
-- пометку, но человека за ней уже нет, и владельцу он мешал бы дважды —
-- непонятной строкой в списке и занятым местом по тарифу.
SELECT m.user_id, u.email, u.first_name, u.last_name, u.avatar_key, m.role, m.created_at
FROM workspace_members m
JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
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
-- личное ли пространство, кто владелец, и два ранга для заморозки.
--
-- Два ранга нужны заморозке, и оба по одному правилу «место занимают самые
-- старые» — иначе после даунгрейда состав доступного менялся бы от запроса к
-- запросу:
--   * team_rank — какое это по счёту ДОПОЛНИТЕЛЬНОЕ пространство владельца;
--   * member_rank — какой по счёту участник ЭТОГО пространства спрашивает.
--     Владелец всегда первый: он плательщик, и отрезать его от собственных форм
--     нельзя ни при каком тарифе.
SELECT m.role,
       (w.personal_user_id IS NOT NULL)::bool AS is_personal,
       o.user_id AS owner_id,
       CASE WHEN m.role = 'owner' THEN 1
            ELSE 1 + (SELECT count(*) FROM workspace_members m2
                       WHERE m2.workspace_id = m.workspace_id AND m2.role <> 'owner'
                         AND (m2.created_at, m2.user_id) <= (m.created_at, m.user_id))
       END::bigint AS member_rank,
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

-- name: ListOwnedTeamsWithMembers :many
-- Командные пространства, где спрашивающий — владелец И есть кто-то ещё. Нужен
-- удалению аккаунта (фаза 23, слайс G): у пространства ровно один владелец
-- (idx_workspace_members_owner), и его уход оставил бы участников в
-- пространстве, работающем по плану несуществующего аккаунта — это TD-53.
-- Личные пропущены: они уходят с хозяином и участников, кроме него, не имеют.
SELECT w.name
FROM workspaces w
JOIN workspace_members o ON o.workspace_id = w.id AND o.role = 'owner' AND o.user_id = $1
--
-- «Кто-то ещё» — только живой аккаунт: удалённый участник иначе запирал бы
-- владельца в пространстве навсегда (уйти он не может, а снять оставшегося
-- некого — того уже нет в списке состава).
WHERE w.personal_user_id IS NULL
  AND EXISTS (SELECT 1 FROM workspace_members m
               JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
               WHERE m.workspace_id = w.id AND m.user_id <> $1)
ORDER BY w.created_at;
