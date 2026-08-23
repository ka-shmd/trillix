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
SELECT s.id, s.answers, s.created_at, fv.version AS form_version
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.form_id = $1 AND NOT s.over_quota
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
