-- Запросы модуля booking. Схема — migrations/0050_booking. Генерация: `make sqlc`.
--
-- Права здесь НЕ проверяются условием запроса, в отличие от интеграций: расписание
-- принадлежит ПРОСТРАНСТВУ, и доступ к нему решает членство спрашивающего
-- (workspaces.Can). Поэтому чтение отдаёт workspace_id, а охрана стоит первой
-- строкой сервис-метода — тот же приём, что у форм.

-- name: CreateSchedule :one
-- Заведение расписания. Параметры нарезки приезжают уже проверенными
-- (domain.ValidateSchedule); CHECK'и схемы — второй рубеж, а не первый.
INSERT INTO schedules (
    id, workspace_id, name, timezone, availability,
    slot_minutes, buffer_minutes, horizon_days, lead_minutes,
    capacity, max_seats_per_booking, show_remaining
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING id, workspace_id, name, timezone, availability,
          slot_minutes, buffer_minutes, horizon_days, lead_minutes,
          capacity, max_seats_per_booking, show_remaining, created_at, updated_at;

-- name: ListSchedules :many
-- Список расписаний пространства. Порядок — от свежего к старому, id в хвосте
-- как tie-break: два расписания, заведённые в одну миллисекунду, не должны
-- прыгать местами при перерисовке.
SELECT id, workspace_id, name, timezone, availability,
       slot_minutes, buffer_minutes, horizon_days, lead_minutes,
       capacity, max_seats_per_booking, show_remaining, created_at, updated_at
FROM schedules
WHERE workspace_id = $1
ORDER BY created_at DESC, id DESC;

-- name: GetSchedule :one
-- Одно расписание по id. Отдаёт workspace_id — по нему сервис и спрашивает право
-- (id из адреса правом доступа не является, инвариант 1).
SELECT id, workspace_id, name, timezone, availability,
       slot_minutes, buffer_minutes, horizon_days, lead_minutes,
       capacity, max_seats_per_booking, show_remaining, created_at, updated_at
FROM schedules
WHERE id = $1;

-- name: UpdateSchedule :one
-- Правка расписания целиком: экран сохраняет форму настроек одним куском, и
-- частичные патчи означали бы «не трогать» и «очистить» одним значением.
--
-- Уже назначенные встречи правка НЕ трогает: длительность копируется в бронь при
-- создании (0050), поэтому смена приёма с 60 минут на 30 не сжимает договорённое.
UPDATE schedules SET
    name = $2, timezone = $3, availability = $4,
    slot_minutes = $5, buffer_minutes = $6, horizon_days = $7, lead_minutes = $8,
    capacity = $9, max_seats_per_booking = $10, show_remaining = $11,
    updated_at = now()
WHERE id = $1
RETURNING id, workspace_id, name, timezone, availability,
          slot_minutes, buffer_minutes, horizon_days, lead_minutes,
          capacity, max_seats_per_booking, show_remaining, created_at, updated_at;

-- name: DeleteSchedule :execrows
-- Удаление расписания. Стоп-кран (живые будущие записи) сервис проверяет ДО
-- вызова: ключ CASCADE его не выражает, а RESTRICT держал бы расписание вечно
-- из-за прошлогодней брони (0050).
--
-- Форма, ссылающаяся на расписание, удалить его не даст: FK forms.schedule_id
-- отвергнет DELETE ошибкой БД, и сервис переведёт её в понятный отказ.
DELETE FROM schedules WHERE id = $1;

-- name: CountFutureBookings :one
-- Стоп-кран удаления: сколько живых БУДУЩИХ записей у расписания.
--
-- Считаются только подтверждённые: холд — ещё не договорённость (ни ответа, ни
-- письма записавшемуся), и держать им расписание значило бы отдавать право
-- удаления брошенной вкладке на четверть часа.
SELECT count(*)::bigint FROM bookings
WHERE schedule_id = $1 AND status = 'confirmed' AND starts_at >= $2;

-- name: CountSchedulesByForm :one
-- Сколько форм ссылается на расписание. Нужен отказу с человеческим текстом:
-- ошибка внешнего ключа сама по себе автору ничего не объясняет.
SELECT count(*)::bigint FROM forms WHERE schedule_id = $1;

-- name: CreateScheduleBlock :one
-- Ручная блокировка: отпуск, свои дела, «сегодня обед на час позже».
INSERT INTO schedule_blocks (id, schedule_id, starts_at, ends_at, note)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, schedule_id, starts_at, ends_at, note, created_at;

-- name: BlocksInRange :many
-- Блокировки, задевающие отрезок. Условие пересечения, а не вхождения: блокировка
-- на неделю обязана попасть в выдачу любого дня этой недели.
SELECT id, schedule_id, starts_at, ends_at, note, created_at
FROM schedule_blocks
WHERE schedule_id = $1 AND starts_at < $3 AND ends_at > $2
ORDER BY starts_at, id;

-- name: DeleteScheduleBlock :execrows
-- schedule_id в условии не украшение: id блокировки приезжает из адреса и правом
-- доступа не является. Чужую блокировку этим запросом не снять.
DELETE FROM schedule_blocks WHERE id = $1 AND schedule_id = $2;

-- name: ListUpcomingBookings :many
-- Ближайшие записи для экрана расписания. Отменённые не показываются: экран
-- отвечает на вопрос «кто придёт», а не «что происходило».
--
-- Название формы джойном: без него список записей — это столбик времён, по
-- которому не понять, откуда запись взялась.
SELECT b.id, b.schedule_id, b.form_id, b.submission_id,
       b.starts_at, b.duration_minutes, b.seats, b.status,
       b.hold_expires_at, b.created_at,
       coalesce(f.name, f.title) AS form_title
FROM bookings b
JOIN forms f ON f.id = b.form_id
WHERE b.schedule_id = $1 AND b.status = 'confirmed' AND b.starts_at >= $2
ORDER BY b.starts_at, b.id
LIMIT $3;

-- name: CancelBookingByAuthor :execrows
-- Отмена записи автором из кабинета. Место освобождается тем же утверждением:
-- строка перестаёт считаться занятой в тот же момент, когда меняется статус.
--
-- Повторная отмена даёт 0 строк — для вызывающего это «уже отменена», а не ошибка.
UPDATE bookings SET status = 'canceled', canceled_at = now()
WHERE id = $1 AND schedule_id = $2 AND status <> 'canceled';

-- name: TakenSeatsInRange :many
-- Сколько мест занято в каждой точке отрезка. Публичная выдача свободного времени
-- вычитает это из вместимости.
--
-- Считаются подтверждённые и НЕИСТЁКШИЕ холды: протухший холд место не держит, и
-- ждать чистки (internal/periodic) выдача не обязана — та убирает мусор, а не решает.
--
-- Свой холд спрашивающего исключается ($4): человек, передумавший и вернувшийся к
-- списку, обязан снова увидеть время, которое сам же и держит, — иначе при вместимости
-- 1 только что отпущенный слот пропадал бы у него на четверть часа.
SELECT starts_at, sum(seats)::bigint AS seats
FROM bookings
WHERE schedule_id = $1
  AND starts_at >= $2 AND starts_at < $3
  AND client_id <> $4
  AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now()))
GROUP BY starts_at;

-- name: TakenSeatsAt :one
-- То же для ОДНОЙ точки — счёт под advisory-lock перед взятием холда.
SELECT coalesce(sum(seats), 0)::bigint
FROM bookings
WHERE schedule_id = $1 AND starts_at = $2 AND client_id <> $3
  AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now()));

-- name: LockSlot :exec
-- Транзакционный advisory-lock по паре «расписание + начало слота» (ADR §10).
--
-- Уникальным индексом гонка здесь не закрывается: при вместимости больше единицы
-- уникальна не строка, а СУММА мест. Приём тот же, что у жёсткого капа лимита ответов;
-- ключ — текст пары, чтобы разные слоты одного расписания не сериализовались друг о
-- друга.
SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));

-- name: HoldSlot :one
-- Придержать время. Одна бронь на клиента в форме (частичный уникальный индекс), и
-- поэтому передумавший респондент ПЕРЕНОСИТ свою бронь, а не заводит вторую.
--
-- Оговорка DO UPDATE ... WHERE несущая: переносится только ХОЛД. Строка, уже ставшая
-- подтверждённой записью, остаётся на месте — иначе повторный холд после отправки
-- молча переписал бы состоявшуюся встречу, и ответ ссылался бы на другое время.
-- Ноль строк в этом случае — не ошибка запроса, а состояние, которое разбирает сервис.
INSERT INTO bookings (
    id, schedule_id, form_id, starts_at, duration_minutes, seats, status, hold_expires_at, client_id
) VALUES ($1, $2, $3, $4, $5, $6, 'held', $7, $8)
ON CONFLICT (form_id, client_id) WHERE status <> 'canceled'
DO UPDATE SET
    schedule_id      = EXCLUDED.schedule_id,
    starts_at        = EXCLUDED.starts_at,
    duration_minutes = EXCLUDED.duration_minutes,
    seats            = EXCLUDED.seats,
    hold_expires_at  = EXCLUDED.hold_expires_at
WHERE bookings.status = 'held'
RETURNING id;
