-- Запросы модуля submissions. Схема — migrations/0004_submissions. Генерация:
-- `make sqlc` (общий пакет internal/postgres).

-- name: InsertSubmission :execrows
-- Приём ответа. id генерирует клиент (UUIDv7) — повторная отправка после сетевого
-- сбоя даёт тот же id и упирается в PK: ON CONFLICT DO NOTHING делает ретрай
-- идемпотентным (0 затронутых строк = ответ уже принят, для клиента это успех).
--
-- Расход тарифа (workspace_usage) инкрементится ТЕМ ЖЕ утверждением (фаза 17):
-- одно утверждение атомарно само по себе, поэтому быстрый путь приёма остаётся
-- без явной транзакции, а счётчик не разъезжается с фактом при падении между
-- двумя запросами. Инкремент читает ins: ретрай не дал строки — расход не вырос.
--
-- over_quota ($6) решается ДО вставки, по счётчику из GetEntitlements. Мягкий
-- лимит сознательно НЕ сериализуется (в отличие от жёсткого капа формы с
-- advisory-lock): на границе возможен ±1 ответ, и цена advisory-lock на всём
-- приёме ради точности «101-го против 100-го» не окупается ничем (ADR §10).
WITH ins AS (
    INSERT INTO submissions (id, form_id, form_version_id, answers, meta, over_quota)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO NOTHING
    RETURNING 1 AS one
), counted AS (
    INSERT INTO workspace_usage (workspace_id, period, submissions)
    SELECT sqlc.arg(workspace_id)::uuid, sqlc.arg(period)::date, 1 FROM ins
    ON CONFLICT (workspace_id, period)
    DO UPDATE SET submissions = workspace_usage.submissions + 1
    RETURNING 1 AS one
)
SELECT one FROM ins;

-- name: ListSubmissionsFirstPage :many
-- Первая страница ответов формы (фаза 6): новые сверху. id (UUIDv7) монотонен по
-- времени → ORDER BY id DESC даёт хронологию без нестабильности created_at. JOIN
-- form_versions отдаёт номер версии, по которой ответ отправлен (form_version_id —
-- NOT NULL FK, строка версии всегда есть). limit+1 строк — вызывающий по «лишней»
-- понимает, есть ли следующая страница. Индекс — idx_submissions_form_id.
-- Границы периода приходят всегда: у листинга ответов селектора периода нет и он
-- шлёт ±бесконечность, у сводки — выбранное владельцем окно (спека
-- design/analytics-tally.md §4). Одна форма запроса вместо двух: копия отличалась
-- бы одной строкой WHERE, а расходиться начала бы во всём остальном.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.form_id = $1 AND NOT s.over_quota
  AND s.created_at >= sqlc.arg(from_ts)::timestamptz
  AND s.created_at <  sqlc.arg(to_ts)::timestamptz
ORDER BY s.id DESC
LIMIT $2;

-- name: ListSubmissionsAfter :many
-- Следующая страница одноколоночным курсором (id): строго «меньше» якоря →
-- стабильно, ответы иммутабельны. Тот же индекс и порядок.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.form_id = $1 AND NOT s.over_quota
  AND s.id < sqlc.arg(cursor_id)::uuid
  AND s.created_at >= sqlc.arg(from_ts)::timestamptz
  AND s.created_at <  sqlc.arg(to_ts)::timestamptz
ORDER BY s.id DESC
LIMIT $2;

-- name: DeleteSubmission :execrows
-- Удаление одного ответа (GDPR-гигиена). Ограничено form_id: ответ чужой формы по
-- угаданному id не удалить (доступ к самой форме сервис проверяет отдельно). 0
-- удалённых строк → ответа нет/не в этой форме → 404.
DELETE FROM submissions
WHERE id = $1 AND form_id = $2;

-- name: CountSubmissions :one
-- ВСЕ ответы формы, включая сверхлимитные. Потребитель ровно один — жёсткий кап
-- формы (response_limit) в приёме ответа: кап считает принятое, а тариф на него
-- не влияет. Кабинету нужен другой счёт — CountSubmissionsForCabinet ниже.
SELECT count(*) FROM submissions WHERE form_id = $1;

-- name: CountSubmissionsForCabinet :one
-- Два числа одной поездкой: видимые ответы и скрытые тарифом (0014). Второе —
-- для плашки «N ответов скрыто»: молча спрятать данные, которые человек собрал,
-- нельзя, иначе скрытие читается как потеря.
SELECT count(*) FILTER (WHERE NOT over_quota)::bigint AS visible,
       count(*) FILTER (WHERE over_quota)::bigint AS hidden
FROM submissions WHERE form_id = $1;

-- name: CountSubmissionsInPeriod :one
-- Карточка «Ответы» над вкладками Insights (спека §5). Считает ВИДИМЫЕ ответы —
-- то же число, что стоит в таблице ответов: расхождение между соседними экранами
-- читалось бы как баг, а не как разница определений.
--
-- Свой запрос, а не поле в счётчиках визитов: ответы и визиты — два независимых
-- множества (ANALYTICS.md §1) и два модуля, и складывать их в одну строку значит
-- однажды поделить одно на другое.
SELECT count(*)::bigint FROM submissions
WHERE form_id = $1 AND NOT over_quota
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz;

-- name: RevealHiddenSubmissions :execrows
-- Снятие пометки со всех сверхлимитных ответов воркспейса — при переходе на план,
-- который их вмещает. Одной транзакцией и без исключений: скрытие обратимо, иначе
-- обещание «сохранены и откроются после апгрейда» было бы враньём.
UPDATE submissions s SET over_quota = false
FROM forms f
WHERE f.id = s.form_id AND f.workspace_id = $1 AND s.over_quota;

-- name: LockFormForSubmit :exec
-- Транзакционный advisory-lock по форме для жёсткого капа лимита ответов (фаза 8.5
-- шаг 4, ADR §10): сериализует конкурентные приёмы ОДНОЙ формы, поэтому счёт
-- «сколько уже принято» точен и перебор невозможен. Блокировку берёт ТОЛЬКО путь с
-- заданным лимитом; форма без лимита пишется без неё (contention только у формы у
-- предела). Ключ — хеш form_id (коллизия хешей лишь изредка сериализует две разные
-- формы — безвредно). xact-версия сама снимается на commit/rollback.
SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));

-- name: GetSubmissionForDelivery :one
-- Один ответ для фоновой доставки во внешнюю таблицу (фаза 25). form_id в
-- условии не украшение: id ответа приезжает из outbox, и связка «этот ответ
-- принадлежит этой форме» проверяется здесь, а не подразумевается.
--
-- NOT over_quota — тот же фильтр, что у кабинета: ответ, скрытый от владельца
-- до оплаты, не должен всплыть у него же в Google Таблице.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.id = $1 AND s.form_id = $2 AND NOT s.over_quota;

-- name: ListSubmissionsForBackfill :many
-- Пачка накопленных ответов для догрузки во внешнюю таблицу (фаза 25).
--
-- Порядок ВОЗРАСТАЮЩИЙ, в отличие от листинга кабинета: в таблицу строки
-- ложатся дописыванием, и «новые сверху» дали бы там перевёрнутую хронологию.
-- Курсор — тот же id (UUIDv7 монотонен по времени), только «больше якоря».
--
-- created_at < $2 — отсечка догрузки: всё, что пришло после неё, доставляет
-- живая очередь, и границы не пересекаются (ни дублей, ни пропусков).
SELECT s.id, s.answers, s.created_at, fv.version AS form_version
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.form_id = $1 AND NOT s.over_quota
  AND s.created_at < $2
  AND s.id > sqlc.arg(after)::uuid
ORDER BY s.id
LIMIT $3;

-- name: UpsertPartialSubmission :exec
-- Автосохранение черновика (спека design/analytics-tally.md §10.2). Ключ — id
-- ВИЗИТА, поэтому второе автосохранение того же визита перезаписывает первое, а не
-- плодит строки: черновик — это состояние, а не событие.
--
-- form_version_id и created_at не обновляются намеренно: версия та, на которой
-- человек открыл форму, а created_at — начало заполнения. Перезаписывается ровно
-- содержимое, точка ухода и время последней правки.
--
-- Условие по form_id — та же защита, что у визитов: visit_id выбирает клиент, а
-- UUIDv7 угадываем по временнóму префиксу, и без него ручкой одной формы правилась
-- бы строка другой.
INSERT INTO partial_submissions (visit_id, form_id, form_version_id, answers, last_block_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (visit_id) DO UPDATE
SET answers       = EXCLUDED.answers,
    last_block_id = EXCLUDED.last_block_id,
    updated_at    = now()
WHERE partial_submissions.form_id = EXCLUDED.form_id;

-- name: DeletePartialByVisit :execrows
-- Черновик стал ответом — удаляем. Зовётся ПОСЛЕ коммита приёма и best-effort:
-- 0 строк штатны (черновика не было, visit_id не доехал), ошибка не имеет права
-- отклонить уже принятый ответ.
DELETE FROM partial_submissions WHERE visit_id = $1 AND form_id = $2;

-- name: ListPartialsFirstPage :many
-- Черновики формы, новыми сверху. Курсор СОСТАВНОЙ (updated_at, visit_id), в
-- отличие от листинга ответов: ответ иммутабелен, и там хватает монотонного id, а
-- черновик меняется, пока человек печатает, — по id он бы прыгал в списке.
SELECT p.visit_id, p.answers, p.last_block_id, p.created_at, p.updated_at, fv.version AS form_version
FROM partial_submissions p
JOIN form_versions fv ON fv.id = p.form_version_id
WHERE p.form_id = $1
ORDER BY p.updated_at DESC, p.visit_id DESC
LIMIT $2;

-- name: ListPartialsAfter :many
-- Следующая страница тем же составным курсором.
SELECT p.visit_id, p.answers, p.last_block_id, p.created_at, p.updated_at, fv.version AS form_version
FROM partial_submissions p
JOIN form_versions fv ON fv.id = p.form_version_id
WHERE p.form_id = $1
  AND (p.updated_at, p.visit_id) < (sqlc.arg(cursor_at)::timestamptz, sqlc.arg(cursor_id)::uuid)
ORDER BY p.updated_at DESC, p.visit_id DESC
LIMIT $2;

-- name: ListFeedFirstPage :many
-- Вкладка «Все ответы»: отправленные и незавершённые ОДНИМ списком по времени
-- (спека design/analytics-tally.md §11). UNION ALL двух выборок, у каждой свой
-- индекс и свой порядок, — и это записанная цена вкладки.
--
-- КЛЮЧ СОРТИРОВКИ — «время последней активности»: у ответа это отправка
-- (created_at), у черновика — последняя правка (updated_at), то самое, что вкладка
-- «Частичные» показывает в колонке даты. Сортируй мы черновики по created_at (как
-- предполагала первая редакция спеки), список выглядел бы перемешанным: колонка
-- показывала бы одно время, а порядок строился бы по другому. Плюс индекса под
-- (form_id, created_at) у черновиков нет вовсе.
--
-- LIMIT стоит в КАЖДОЙ ветви и ещё раз снаружи: без внутренних Postgres прочитал бы
-- обе выборки целиком, чтобы отсортировать объединение.
(
    SELECT 'submission'::text AS kind, s.id AS row_id, s.created_at AS at,
           s.created_at AS started_at, NULL::text AS last_block_id,
           s.answers, fv.version AS form_version
    FROM submissions s
    JOIN form_versions fv ON fv.id = s.form_version_id
    WHERE s.form_id = $1 AND NOT s.over_quota
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT sqlc.arg(row_limit)
)
UNION ALL
(
    SELECT 'partial'::text, p.visit_id, p.updated_at,
           p.created_at, p.last_block_id,
           p.answers, fv.version
    FROM partial_submissions p
    JOIN form_versions fv ON fv.id = p.form_version_id
    WHERE p.form_id = $1
    ORDER BY p.updated_at DESC, p.visit_id DESC
    LIMIT sqlc.arg(row_limit)
)
ORDER BY at DESC, row_id DESC
LIMIT sqlc.arg(row_limit);

-- name: ListFeedAfter :many
-- Следующая страница ленты тем же составным курсором (время, id). Условие
-- применяется В КАЖДОЙ ветви до объединения — иначе оно фильтровало бы уже
-- склеенный результат, и страница выходила бы короче limit.
(
    SELECT 'submission'::text AS kind, s.id AS row_id, s.created_at AS at,
           s.created_at AS started_at, NULL::text AS last_block_id,
           s.answers, fv.version AS form_version
    FROM submissions s
    JOIN form_versions fv ON fv.id = s.form_version_id
    WHERE s.form_id = $1 AND NOT s.over_quota
      AND (s.created_at, s.id) < (sqlc.arg(cursor_at)::timestamptz, sqlc.arg(cursor_id)::uuid)
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT sqlc.arg(row_limit)
)
UNION ALL
(
    SELECT 'partial'::text, p.visit_id, p.updated_at,
           p.created_at, p.last_block_id,
           p.answers, fv.version
    FROM partial_submissions p
    JOIN form_versions fv ON fv.id = p.form_version_id
    WHERE p.form_id = $1
      AND (p.updated_at, p.visit_id) < (sqlc.arg(cursor_at)::timestamptz, sqlc.arg(cursor_id)::uuid)
    ORDER BY p.updated_at DESC, p.visit_id DESC
    LIMIT sqlc.arg(row_limit)
)
ORDER BY at DESC, row_id DESC
LIMIT sqlc.arg(row_limit);

-- name: CountPartials :one
-- Сколько черновиков у формы. Нужен вкладке «Незавершённые» и плашке тарифа:
-- число показывается и тому, кому разбивка закрыта.
SELECT count(*)::bigint FROM partial_submissions WHERE form_id = $1;

-- name: DeletePartialSubmission :execrows
-- Удаление одного черновика владельцем (та же гигиена, что у ответа). Ограничено
-- form_id: черновик чужой формы по угаданному id не удалить.
DELETE FROM partial_submissions WHERE visit_id = $1 AND form_id = $2;

-- name: DeleteOldPartials :execrows
-- Чистка по возрасту (периодическая задача partial-cleanup). Срок — 30 дней,
-- константа в коде: черновик это наблюдение, а не документ, и хранить его вечно
-- значит копить чужой неотправленный текст без причины.
DELETE FROM partial_submissions WHERE updated_at < $1;
