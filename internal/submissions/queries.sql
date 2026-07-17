-- Запросы модуля submissions. Схема — migrations/0004_submissions. Генерация:
-- `make sqlc` (общий пакет internal/postgres).

-- name: InsertSubmission :execrows
-- Приём ответа. id генерирует клиент (UUIDv7) — повторная отправка после сетевого
-- сбоя даёт тот же id и упирается в PK: ON CONFLICT DO NOTHING делает ретрай
-- идемпотентным (0 затронутых строк = ответ уже принят, для клиента это успех).
INSERT INTO submissions (id, form_id, form_version_id, answers, meta)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (id) DO NOTHING;

-- name: ListSubmissionsFirstPage :many
-- Первая страница ответов формы (фаза 6): новые сверху. id (UUIDv7) монотонен по
-- времени → ORDER BY id DESC даёт хронологию без нестабильности created_at. JOIN
-- form_versions отдаёт номер версии, по которой ответ отправлен (form_version_id —
-- NOT NULL FK, строка версии всегда есть). limit+1 строк — вызывающий по «лишней»
-- понимает, есть ли следующая страница. Индекс — idx_submissions_form_id.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.form_id = $1
ORDER BY s.id DESC
LIMIT $2;

-- name: ListSubmissionsAfter :many
-- Следующая страница одноколоночным курсором (id): строго «меньше» якоря →
-- стабильно, ответы иммутабельны. Тот же индекс и порядок.
SELECT s.id, s.answers, s.created_at, fv.version AS form_version
FROM submissions s
JOIN form_versions fv ON fv.id = s.form_version_id
WHERE s.form_id = $1
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
-- Общее число ответов формы (счётчик «N ответов» в кабинете). Дёшево по
-- idx_submissions_form_id (index-only на form_id).
SELECT count(*) FROM submissions WHERE form_id = $1;

-- name: LockFormForSubmit :exec
-- Транзакционный advisory-lock по форме для жёсткого капа лимита ответов (фаза 8.5
-- шаг 4, ADR §10): сериализует конкурентные приёмы ОДНОЙ формы, поэтому счёт
-- «сколько уже принято» точен и перебор невозможен. Блокировку берёт ТОЛЬКО путь с
-- заданным лимитом; форма без лимита пишется без неё (contention только у формы у
-- предела). Ключ — хеш form_id (коллизия хешей лишь изредка сериализует две разные
-- формы — безвредно). xact-версия сама снимается на commit/rollback.
SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0));
