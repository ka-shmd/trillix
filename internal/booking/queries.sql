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
       coalesce(f.name, f.title) AS form_title, f.slug AS form_slug
FROM bookings b
JOIN forms f ON f.id = b.form_id
WHERE b.schedule_id = $1 AND b.status = 'confirmed' AND b.starts_at >= $2
ORDER BY b.starts_at, b.id
LIMIT $3;

-- name: BookingsInRange :many
-- Записи, задевающие отрезок, — полотну недели. Условие пересечения считается по
-- ДЛИТЕЛЬНОСТИ САМОЙ БРОНИ, а не по нынешней длительности приёма: автор поменяет
-- час на полчаса, и уже назначенные встречи от этого не должны съехать (0050).
--
-- Отменённые не показываются по той же причине, что и в списке ближайших: полотно
-- отвечает на вопрос «что занято», а не «что происходило». Холды тоже не показываются
-- — они живут пятнадцать минут, и мигающее на полотне занятое время автору врёт.
SELECT b.id, b.schedule_id, b.form_id, b.submission_id,
       b.starts_at, b.duration_minutes, b.seats, b.status,
       b.hold_expires_at, b.created_at,
       coalesce(f.name, f.title) AS form_title, f.slug AS form_slug
FROM bookings b
JOIN forms f ON f.id = b.form_id
WHERE b.schedule_id = $1
  AND b.status = 'confirmed'
  AND b.starts_at < $3
  AND b.starts_at + make_interval(mins => b.duration_minutes) > $2
ORDER BY b.starts_at, b.id;

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

-- name: GetBookingForConfirm :one
-- Бронь, которую подтверждает приём ответа. Три условия сразу, и все три несущие:
-- id брони приезжает в ОТВЕТЕ респондента, то есть недоверенным вводом, а форма и
-- клиент — то, что о нём уже известно. Без них можно было бы подтвердить чужую бронь
-- по угаданному id (инвариант 1).
--
-- client_id совпадает с id ответа по устройству: тем же id браузер брал холд.
--
-- Пояс расписания едет тем же джойном: письму о записи он нужен, чтобы написать время
-- в обоих поясах, а второй запрос ради одной строки — плата на каждом принятом ответе.
SELECT b.id, b.schedule_id, b.starts_at, b.duration_minutes, b.seats, b.status,
       b.hold_expires_at, b.submission_id, s.timezone
FROM bookings b
JOIN schedules s ON s.id = b.schedule_id
WHERE b.id = $1 AND b.form_id = $2 AND b.client_id = $3;

-- name: ConfirmBooking :execrows
-- Холд становится записью. hold_expires_at гасится: подтверждённая бронь срока не
-- имеет, и оставленное время однажды прочиталось бы чисткой как «протухла».
--
-- status IN ('held','confirmed') делает утверждение ИДЕМПОТЕНТНЫМ: ретрай отправки с
-- тем же id ответа проходит по второй ветке и ничего не меняет. Отменённую бронь
-- утверждение не воскрешает — 0 строк, и это разбирает сервис.
UPDATE bookings
SET status = 'confirmed', submission_id = $2, hold_expires_at = NULL
WHERE id = $1 AND status IN ('held', 'confirmed');

-- name: GetScheduleCapacity :one
-- Вместимость слота — одно число для подтверждения брони. Всю строку читать незачем:
-- документ правила это килобайты JSONB на каждом принятом ответе.
SELECT capacity FROM schedules WHERE id = $1;

-- name: GetBookingForCancel :one
-- Что показать на странице отмены: время, длительность, число мест и название формы.
-- Имени и контактов записавшегося здесь нет — их знает только ответ формы, и страница
-- отмены к нему не ходит (спека §13).
SELECT b.id, b.form_id, b.submission_id, b.starts_at, b.duration_minutes, b.seats, b.status,
       b.revision, coalesce(f.name, f.title) AS form_title, s.timezone
FROM bookings b
JOIN forms f ON f.id = b.form_id
JOIN schedules s ON s.id = b.schedule_id
WHERE b.id = $1;

-- name: CancelBookingByID :execrows
-- Отмена по ссылке из письма. Право предъявляет сам токен (подпись покрывает id и
-- срок), поэтому в условии только id и «ещё не отменена»: повторный переход по той же
-- ссылке даёт 0 строк, и для человека это «уже отменено», а не ошибка.
UPDATE bookings SET status = 'canceled', canceled_at = now()
WHERE id = $1 AND status <> 'canceled';

-- name: DeleteExpiredHolds :execrows
-- Чистка протухших холдов (internal/periodic).
--
-- Занятость она НЕ решает: счёт занятого сам отсекает истёкшие (hold_expires_at >
-- now()), поэтому место возвращается в оборот в тот же миг, а не когда добежит задача.
-- Здесь убирается мусор — строки брошенных вкладок, которые иначе копились бы вечно.
--
-- Отсрочка ($1 — момент, старее которого чистим) даёт запас на перезанятие: холд,
-- истёкший минуту назад, ещё может стать записью на отправке длинной анкеты.
DELETE FROM bookings WHERE status = 'held' AND hold_expires_at < $1;

-- name: CountFutureBookingsOfForm :one
-- Живые будущие записи формы — стоп-кран её удаления (design/booking.md §4.10).
-- Считаются только подтверждённые: холд ещё не договорённость.
SELECT count(*)::bigint FROM bookings
WHERE form_id = $1 AND status = 'confirmed' AND starts_at >= $2;

-- name: CountFutureBookingsOfSubmission :one
-- То же для одного ответа: удаление ответа не имеет права молча снести встречу.
SELECT count(*)::bigint FROM bookings
WHERE submission_id = $1 AND status = 'confirmed' AND starts_at >= $2;

-- name: GetFormScheduleZone :one
-- Пояс расписания формы — для выгрузок (CSV, лист интеграции): время записи автор
-- читает в своём рабочем поясе, а не в UTC и не в поясе того, кто открыл файл.
-- Нет строки — у формы нет записи, и колонки времени в выгрузке не встретится.
SELECT s.timezone
FROM forms f
JOIN schedules s ON s.id = f.schedule_id
WHERE f.id = $1;

-- name: BookingForMove :one
-- Бронь перед переносом: что двигаем и сколько мест это займёт на новом месте.
-- Расписание спрашивается вместе с ней — id из адреса правом не является, и строка
-- чужого расписания обязана быть неотличима от несуществующей.
SELECT b.id, b.schedule_id, b.form_id, b.submission_id,
       b.starts_at, b.duration_minutes, b.seats, b.status, b.revision
FROM bookings b
WHERE b.id = $1 AND b.schedule_id = $2 AND b.status = 'confirmed';

-- name: TakenSeatsAtExcept :one
-- Сколько мест занято в точке, НЕ СЧИТАЯ саму переносимую бронь.
--
-- Исключение по id, а не по client_id (как у публичного холда): переносу нужно не
-- «мой холд не мешает мне», а «эта самая строка не считает себя дважды» — она уже
-- лежит в таблице, и без исключения перенос внутри одного слота отказал бы сам себе.
SELECT coalesce(sum(seats), 0)::bigint
FROM bookings
WHERE schedule_id = $1 AND starts_at = $2 AND id <> $3
  AND (status = 'confirmed' OR (status = 'held' AND hold_expires_at > now()));

-- name: MoveBooking :execrows
-- Перенос брони на новое время. НОМЕР РЕДАКЦИИ РАСТЁТ ТЕМ ЖЕ УТВЕРЖДЕНИЕМ: разъедься
-- они, приглашение уехало бы с номером, который чужой календарь уже видел, и правка
-- была бы отброшена как устаревшая.
--
-- Длительность НЕ пересчитывается по нынешней нарезке: она снимок момента записи
-- (0050), и перенос встречи её менять не должен.
UPDATE bookings SET starts_at = $3, revision = revision + 1
WHERE id = $1 AND schedule_id = $2 AND status = 'confirmed';
