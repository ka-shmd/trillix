-- Запросы модуля submissions. Схема — migrations/0004_submissions. Генерация:
-- `make sqlc` (общий пакет internal/postgres).

-- name: InsertSubmission :execrows
-- Приём ответа. id генерирует клиент (UUIDv7) — повторная отправка после сетевого
-- сбоя даёт тот же id и упирается в PK: ON CONFLICT DO NOTHING делает ретрай
-- идемпотентным (0 затронутых строк = ответ уже принят, для клиента это успех).
INSERT INTO submissions (id, form_id, form_version_id, answers, meta)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (id) DO NOTHING;
