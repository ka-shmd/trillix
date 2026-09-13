-- Запросы модуля notify. Схема — migrations/0066_notifications. Генерация: `make sqlc`.

-- name: InsertNotifications :exec
-- Постановка повода ВСЕМ адресатам одним утверждением: пары «id строки —
-- получатель» приезжают массивами, и число участников не превращается в число
-- запросов. Идентификаторы генерит Go (UUIDv7, domain.NewID) — gen_random_uuid()
-- дал бы v4 против ADR.
--
-- ON CONFLICT — коалесинг в непрочитанное (частичный UNIQUE): повтор повода не
-- плодит строку, а растит счётчик и обновляет снимок (форму переименовали —
-- непрочитанная строка догоняет имя на следующем событии).
--
-- Ветка CASE разрывает склейку на границе ПЕРИОДА: payload.period есть только у
-- over_quota, и непрочитанная строка прошлого месяца не должна копить счётчик
-- дальше. У остальных поводов оба значения NULL, IS NOT DISTINCT FROM даёт true,
-- и склейка обычная — отдельной ветки по kind не нужно.
WITH recipients AS (
    -- Два unnest в одной проекции идут парами (zip), а не декартовым произведением:
    -- массивы приходят одной длины — id строки на получателя.
    SELECT unnest(@ids::uuid[]) AS id, unnest(@users::uuid[]) AS user_id
)
INSERT INTO notifications (id, user_id, workspace_id, kind, form_id, subject_id, payload)
SELECT r.id, r.user_id, @workspace_id::uuid, @kind::text, sqlc.narg(form_id)::uuid,
       @subject_id::uuid, @payload::jsonb
FROM recipients r
ON CONFLICT (user_id, kind, subject_id) WHERE read_at IS NULL
DO UPDATE SET
    count = CASE WHEN notifications.payload->>'period' IS NOT DISTINCT FROM excluded.payload->>'period'
                 THEN notifications.count + 1 ELSE 1 END,
    first_at = CASE WHEN notifications.payload->>'period' IS NOT DISTINCT FROM excluded.payload->>'period'
                    THEN notifications.first_at ELSE now() END,
    last_at = now(),
    payload = excluded.payload;

-- name: ClearUnreadNotifications :execrows
-- Отбой: повод-препятствие снят (цель починена, включена или удалена), и
-- непрочитанные строки о нём гаснут. Прочитанные остаются историей — они честно
-- описывают, что тогда было.
DELETE FROM notifications
WHERE kind = @kind::text AND subject_id = @subject_id::uuid AND read_at IS NULL;

-- name: ListNotifications :many
-- Лента пользователя: все его пространства разом, свежие сверху.
--
-- Порядок и курсор — по паре (last_at, id): последнее событие склейки поднимает
-- строку наверх, а id разводит строки с одинаковым last_at (одно событие
-- адресуется всем участникам сразу, и время у их строк совпадает до микросекунды).
-- Сравнение строкой-кортежем, а не двумя условиями: так его берёт индекс
-- idx_notifications_feed.
--
-- JOIN на workspace_members — не украшение и не оптимизация: строка адресована
-- человеку когда-то, а членство с тех пор могло кончиться, и выгнанный участник не
-- вправе видеть даже названий форм (инвариант 1). Гашение его строк при исключении
-- — уборка, а гарантия — этот JOIN.
SELECT n.id, n.workspace_id, w.name AS workspace_name, w.slug AS workspace_slug,
       n.kind, n.subject_id, n.payload, n.count, n.first_at, n.last_at, n.read_at
FROM notifications n
JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = n.user_id
JOIN workspaces w ON w.id = n.workspace_id
WHERE n.user_id = @user_id::uuid
  AND (sqlc.narg(cursor_at)::timestamptz IS NULL
       OR (n.last_at, n.id) < (sqlc.narg(cursor_at)::timestamptz, sqlc.narg(cursor_id)::uuid))
ORDER BY n.last_at DESC, n.id DESC
LIMIT @lim::int;

-- name: CountUnreadNotifications :one
-- Число на колокольчике. Тот же сторож членства, что у ленты; идёт по частичному
-- UNIQUE idx_notifications_live.
SELECT count(*)
FROM notifications n
JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.user_id = n.user_id
WHERE n.user_id = @user_id::uuid AND n.read_at IS NULL;

-- name: MarkNotificationsRead :execrows
-- Прочтение названных строк. Чужие не трогаются (user_id в условии), уже
-- прочитанные не переписываются — иначе повтор сдвигал бы им срок уборки.
UPDATE notifications SET read_at = now()
WHERE user_id = @user_id::uuid AND read_at IS NULL AND id = ANY(@ids::uuid[]);

-- name: MarkAllNotificationsRead :execrows
UPDATE notifications SET read_at = now()
WHERE user_id = @user_id::uuid AND read_at IS NULL;

-- name: DeleteNotification :execrows
-- Удаление одной строки ленты человеком. Отбор по владельцу: чужую строку запрос
-- просто не находит, и отвечать на неё отдельно незачем.
DELETE FROM notifications WHERE id = @id::uuid AND user_id = @user_id::uuid;

-- name: DeleteAllNotifications :execrows
-- «Удалить все» — вся лента этого человека, включая непрочитанное: это его
-- решение, а не уборка по возрасту. Чужие строки того же повода не трогаются —
-- у каждого адресата своя.
DELETE FROM notifications WHERE user_id = @user_id::uuid;

-- name: PurgeNotifications :execrows
-- Уборка по возрасту: прочитанные живут короче непрочитанных. Индекса под ветку
-- read_at нет — OR всё равно сведёт план к одному проходу, а таблица держится
-- маленькой коалесингом и самой этой уборкой (гоняется раз в час).
DELETE FROM notifications
WHERE (read_at IS NOT NULL AND read_at < @read_before::timestamptz)
   OR (read_at IS NULL AND first_at < @unread_before::timestamptz);
