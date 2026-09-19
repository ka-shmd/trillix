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
    INSERT INTO submissions (id, form_id, form_version_id, answers, meta, over_quota, consent_revision_id, visit_id)
    VALUES ($1, $2, $3, $4, $5, $6, sqlc.narg(consent_revision_id), sqlc.narg(visit_id))
    ON CONFLICT (id) DO NOTHING
    RETURNING 1 AS one
), counted AS (
    INSERT INTO workspace_usage (workspace_id, period, submissions)
    SELECT sqlc.arg(workspace_id)::uuid, sqlc.arg(period)::date, 1 FROM ins
    ON CONFLICT (workspace_id, period)
    DO UPDATE SET submissions = workspace_usage.submissions + 1
    RETURNING 1 AS one
), queued AS (
    -- Доставка в вебхуки формы (фаза 28) ставится ТЕМ ЖЕ утверждением: ответ и
    -- строка его очереди появляются вместе, поэтому падение процесса между ними
    -- невозможно, а транзакции на быстром пути приёма по-прежнему нет. Читает
    -- ins: идемпотентный ретрай не дал строки — второй доставки не появится,
    -- откат сверх жёсткого капа уносит и очередь.
    --
    -- Выключенные вебхуки пропускаются здесь: событие, которое некому доставить,
    -- лучше не заводить вовсе. СЛОМАННЫЕ — нет: их ответы копятся, и починка
    -- увозит накопленное по порядку (спека §6).
    INSERT INTO webhook_queue (webhook_id, submission_id)
    SELECT w.id, $1 FROM form_webhooks w, ins
    WHERE w.form_id = $2 AND w.enabled
    RETURNING 1 AS one
), sheets_queued AS (
    -- Доставка в связки Google Таблиц — тем же утверждением и по тем же
    -- основаниям (0065). До переезда событие ставилось ПОСЛЕ коммита ответа, и
    -- краш в этом окне стоил строки в чужой таблице: у Таблиц окно лечилось
    -- кнопкой «Перезалить всё», но лечил его человек, который о потере не знал.
    INSERT INTO sheet_queue (link_id, submission_id)
    SELECT fi.id, $1 FROM form_integrations fi, ins
    WHERE fi.form_id = $2 AND fi.enabled
    RETURNING 1 AS one
)
SELECT one FROM ins;

-- name: ListSubmissionsFirstPage :many
-- Метки визита ответа (0076, спека design/analytics-v2.md §6.4) едут рядом: сегмент
-- сводки, колонки «Источник» и «Устройство» в выгрузке и в окне ответа. LEFT JOIN по
-- визиту ЭТОЙ ЖЕ формы: visit_id прислал клиент, и чужой визит меток не даёт. Нет
-- визита — has_visit = false, метки пустые. Разбор меток — в Go (domain.VisitMeta),
-- как у разбивок визитов.
-- Первая страница ответов формы (фаза 6): новые сверху. id (UUIDv7) монотонен по
-- времени → ORDER BY id DESC даёт хронологию без нестабильности created_at. JOIN
-- form_versions отдаёт номер версии, по которой ответ отправлен (form_version_id —
-- NOT NULL FK, строка версии всегда есть). limit+1 строк — вызывающий по «лишней»
-- понимает, есть ли следующая страница. Индекс — idx_submissions_form_id.
-- Границы периода приходят всегда: у листинга ответов селектора периода нет и он
-- шлёт ±бесконечность, у сводки — выбранное владельцем окно (спека
-- design/analytics-tally.md §4). Одна форма запроса вместо двух: копия отличалась
-- бы одной строкой WHERE, а расходиться начала бы во всём остальном.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version,
       (v.id IS NOT NULL)::boolean AS has_visit,
       coalesce(v.meta->>'user_agent', '')::text AS visit_user_agent,
       coalesce(v.meta->>'referer', '')::text AS visit_referer,
       coalesce(v.meta->>'utm_source', '')::text AS visit_utm_source,
       coalesce(v.meta->>'utm_medium', '')::text AS visit_utm_medium,
       coalesce(v.country_code, '')::text AS visit_country_code,
       coalesce(v.city, '')::text AS visit_city
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
LEFT JOIN form_visits v ON v.id = s.visit_id AND v.form_id = s.form_id
WHERE s.form_id = $1 AND NOT s.over_quota
  AND s.created_at >= sqlc.arg(from_ts)::timestamptz
  AND s.created_at <  sqlc.arg(to_ts)::timestamptz
ORDER BY s.id DESC
LIMIT $2;

-- name: ListSubmissionsAfter :many
-- Следующая страница одноколоночным курсором (id): строго «меньше» якоря →
-- стабильно, ответы иммутабельны. Тот же индекс и порядок.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version,
       (v.id IS NOT NULL)::boolean AS has_visit,
       coalesce(v.meta->>'user_agent', '')::text AS visit_user_agent,
       coalesce(v.meta->>'referer', '')::text AS visit_referer,
       coalesce(v.meta->>'utm_source', '')::text AS visit_utm_source,
       coalesce(v.meta->>'utm_medium', '')::text AS visit_utm_medium,
       coalesce(v.country_code, '')::text AS visit_country_code,
       coalesce(v.city, '')::text AS visit_city
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
LEFT JOIN form_visits v ON v.id = s.visit_id AND v.form_id = s.form_id
WHERE s.form_id = $1 AND NOT s.over_quota
  AND s.id < sqlc.arg(cursor_id)::uuid
  AND s.created_at >= sqlc.arg(from_ts)::timestamptz
  AND s.created_at <  sqlc.arg(to_ts)::timestamptz
ORDER BY s.id DESC
LIMIT $2;

-- name: GetSubmissionForForm :one
-- Один ответ целиком — окну ответа, открытому не из списка (карточка записи на
-- полотне расписания). Ограничено form_id по тому же доводу, что и удаление: id
-- ответа приезжает из адреса и правом доступа не является, доступ к самой форме
-- сервис проверяет отдельно.
--
-- Сверхлимитные (over_quota) отдаются: список их прячет, потому что это витрина
-- тарифа, а здесь спрашивают КОНКРЕТНЫЙ ответ по ссылке из записи — и «нет такого»
-- на существующий ответ было бы враньём.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version,
       (v.id IS NOT NULL)::boolean AS has_visit,
       coalesce(v.meta->>'user_agent', '')::text AS visit_user_agent,
       coalesce(v.meta->>'referer', '')::text AS visit_referer,
       coalesce(v.meta->>'utm_source', '')::text AS visit_utm_source,
       coalesce(v.meta->>'utm_medium', '')::text AS visit_utm_medium,
       coalesce(v.country_code, '')::text AS visit_country_code,
       coalesce(v.city, '')::text AS visit_city
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
LEFT JOIN form_visits v ON v.id = s.visit_id AND v.form_id = s.form_id
WHERE s.id = $1 AND s.form_id = $2;

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
--
-- Прошлое окно той же длины (сравнение на карточке, спека design/analytics-v2.md §8)
-- считается тем же сканом: выборка начинается с prev_from, текущее окно — FILTER.
-- Без сравнения prev_from = from_ts, и previous равно нулю.
SELECT count(*) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz)::bigint AS current,
       count(*) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz)::bigint AS previous
FROM submissions
WHERE form_id = $1 AND NOT over_quota
  AND created_at >= sqlc.arg(prev_from_ts)::timestamptz
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
--
-- Название формы едет тем же запросом: тело вебхука его называет, а спрашивать
-- его отдельно у forms доставке нечем — пользователя, чьё право можно проверить,
-- на фоновом пути нет.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version, f.title AS form_title
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
JOIN forms f ON f.id = s.form_id
WHERE s.id = $1 AND s.form_id = $2 AND NOT s.over_quota;

-- name: GetSubmissionForPrint :one
-- Один ответ вместе со схемой ТОЙ версии, по которой он отправлен (печать PDF).
-- Схема приезжает из form_versions, а не из forms.draft_schema: печатается тот
-- документ, который видел респондент, — вопрос, удалённый автором позже, обязан
-- остаться на бумаге вместе со своим ответом (ARCHITECTURE §3.2).
--
-- form_id в условии и NOT over_quota — по тем же основаниям, что у соседнего
-- GetSubmissionForDelivery: связка «ответ принадлежит этой форме» проверяется, а
-- скрытый тарифом ответ не печатается, раз он не показан и в кабинете.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version, fv.schema AS form_schema
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.id = $1 AND s.form_id = $2 AND NOT s.over_quota;

-- name: ListSubmissionsForDelivery :many
-- Пачка ответов для доставки во внешнюю таблицу (0065). Пачкой, потому что
-- пачкой и уезжает: у Таблиц один values.append увозит все строки тика разом, а
-- лимит Google считает запросы, не строки.
--
-- Порядок ЗДЕСЬ не важен и не задаётся: очередь связки уже назвала его, и
-- доставщик раскладывает ответ этой выборки по своему списку id. Кто из
-- запрошенных не вернулся — удалён автором либо скрыт тарифом (NOT over_quota,
-- тот же фильтр, что у соседнего GetSubmissionForDelivery): доставлять нечего.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.form_id = $1 AND NOT s.over_quota
  AND s.id = ANY(sqlc.arg(ids)::uuid[]);

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
--
-- ⚠ ВИЗИТ, УЖЕ ОТПРАВИВШИЙ ОТВЕТ, ЧЕРНОВИКА НЕ ПОЛУЧАЕТ — ноль строк, тишина в ответ.
-- Приём удаляет черновик, но автосохранение живёт в чужой вкладке, и удалённое оно
-- присылает заново: запрос, ушедший за миг до кнопки и доехавший после, или старый
-- закешированный бандл рендерера, который после отправки продолжает сохранять. Строка
-- родилась бы ПОСЛЕ ответа, с содержимым этого же ответа, и легла бы во вкладку
-- «Незавершённые» рядом с ним. Порядок в приёме для этого и такой: сначала визит
-- помечается отправленным, потом удаляется черновик (service.go, submit).
--
-- Визита нет вовсе (бикон не дошёл, старый бандл не шлёт visit_id) — сохраняем, как
-- сохраняли: про такой черновик неизвестно ничего, и терять набранное из-за молчащей
-- аналитики нельзя.
INSERT INTO partial_submissions (visit_id, form_id, form_version_id, answers, last_block_id)
SELECT sqlc.arg(visit_id)::uuid, sqlc.arg(form_id)::uuid, sqlc.arg(form_version_id)::uuid,
       sqlc.arg(answers)::jsonb, sqlc.narg(last_block_id)::text
WHERE NOT EXISTS (
    SELECT 1 FROM form_visits v
    WHERE v.id = sqlc.arg(visit_id)::uuid AND v.form_id = sqlc.arg(form_id)::uuid AND v.submitted
)
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
