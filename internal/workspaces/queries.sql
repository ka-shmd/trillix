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

-- name: GetWorkspaceByID :one
SELECT id, slug, name, created_at, (personal_user_id IS NOT NULL)::bool AS is_personal
FROM workspaces WHERE id = $1;

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

-- name: DeleteMember :execrows
-- Удаление участника. role <> 'owner' в условии — сторож последнего владельца
-- на уровне запроса: владельца не удаляют вовсе, ни своей рукой, ни чужой.
DELETE FROM workspace_members
WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner';

-- name: DemoteOwner :execrows
-- Первая половина передачи владения: действующий владелец становится редактором.
-- Идёт СТРОГО ПЕРЕД PromoteToOwner в той же транзакции — частичный уникальный
-- индекс idx_workspace_members_owner проверяется на каждом операторе, и обратный
-- порядок упёрся бы во второго владельца.
--
-- role = 'owner' в условии — сторож: понижать можно только того, кто владелец,
-- ноль строк означает «этот человек владельцем уже не был» (гонка двух передач).
UPDATE workspace_members
SET role = 'editor'
WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner';

-- name: PromoteToOwner :execrows
-- Вторая половина передачи владения. role <> 'owner' — сторож того же класса:
-- ноль строк означает «этого участника в пространстве нет», и передача
-- откатывается вместе с понижением.
UPDATE workspace_members
SET role = 'owner'
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
-- name: CreateJoinLink :exec
-- Ссылка-приглашение (0058). Токен ложится СЫРЫМ, а не SHA-256, и это
-- единственное такое место в продукте — ADR §10: ценность ссылки в повторном
-- копировании, а из хеша её не восстановить.
INSERT INTO workspace_join_links (token, workspace_id, role, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5);

-- name: RevokeJoinLink :execrows
-- Гасит живую ссылку пространства. Ноль строк означает «живой не было» — не
-- ошибка: результат для человека тот же.
UPDATE workspace_join_links
SET revoked_at = now()
WHERE workspace_id = $1 AND revoked_at IS NULL;

-- name: GetActiveJoinLink :one
-- Живая ссылка пространства для кабинета. Истёкшую отдаёт ТОЖЕ: срок разбирает
-- сервис, чтобы экран мог сказать «истекла, создайте новую» вместо «ссылки нет».
-- Двух годных не бывает — держит idx_join_links_active.
SELECT token, workspace_id, role, expires_at
FROM workspace_join_links
WHERE workspace_id = $1 AND revoked_at IS NULL;

-- name: GetJoinLinkByToken :one
-- Вход по ссылке. Отозванная не находится вовсе, истёкшая находится и
-- отбраковывается сервисом — снаружи оба случая и «такой ссылки нет» неразличимы
-- намеренно: действие у человека одно, а различение позволяло бы перебором
-- выяснять, какие токены существовали.
--
-- Имя пространства едет тем же запросом: зовомому надо понять, куда его зовут, а
-- второй поездки за вывеской этот путь не стоит.
SELECT l.token, l.workspace_id, l.role, l.expires_at, w.name AS workspace_name
FROM workspace_join_links l
JOIN workspaces w ON w.id = l.workspace_id
WHERE l.token = $1 AND l.revoked_at IS NULL;

-- name: PurgeExpiredJoinLinks :execrows
-- Периодическая чистка: истёкшие и отозванные. Отозванные копятся по строке на
-- каждое «создать новую» и после отзыва не нужны никому.
DELETE FROM workspace_join_links
WHERE expires_at < now() OR revoked_at IS NOT NULL;
