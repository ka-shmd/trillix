-- Запросы модуля mail. Схема — migrations/0010_outbox. Генерация: `make sqlc`.

-- name: EnqueueOutbox :exec
-- Пишет намерение доставки. Вызывается продюсером в его транзакции (transactional
-- outbox): исполнитель приходит извне. attempts/next_attempt_at/sent_at — по
-- умолчанию (0 / now / NULL), то есть строка сразу готова к первой попытке.
INSERT INTO outbox (id, channel, payload)
VALUES ($1, $2, $3);

-- name: ListPendingOutbox :many
-- Готовые к отправке: не доставленные, чей next_attempt_at наступил. По
-- next_attempt_at (старейшая задолженность первой), потолок пачки — $1. Один
-- диспетчер на один инстанс (как in-memory rate limit, ADR §10), запускается
-- periodic-задачей последовательно — конкурентной выборки нет, блокировка строк
-- не нужна; многоинстансный апгрейд — FOR UPDATE SKIP LOCKED.
SELECT id, channel, payload, attempts
FROM outbox
WHERE sent_at IS NULL AND next_attempt_at <= now()
ORDER BY next_attempt_at
LIMIT $1;

-- name: MarkOutboxSent :exec
-- Успех — терминальное состояние: проставляем sent_at, гасим прошлую ошибку.
UPDATE outbox
SET sent_at = now(), last_error = NULL
WHERE id = $1;

-- name: MarkOutboxFailed :exec
-- Неудача: растим счётчик, откладываем следующую попытку (бэкофф считает сервис),
-- сохраняем текст ошибки для диагностики. sent_at не трогаем — строка остаётся в выборке.
UPDATE outbox
SET attempts = $2, next_attempt_at = $3, last_error = $4
WHERE id = $1;
