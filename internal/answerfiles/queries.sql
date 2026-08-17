-- Запросы модуля answerfiles. Схема — migrations/0027_submission_files.
-- Генерация: `make sqlc`.

-- Слот загрузки: строка «ожидает». submission_id и claimed_at пусты до приёма
-- ответа — обе половины заявления появляются вместе (CHECK в 0027).
-- name: InsertSubmissionFile :exec
INSERT INTO submission_files (
    id, workspace_id, form_id, block_id, object_key, original_name, size_bytes, content_type
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- Незаявленная загрузка по id — для сверки при приёме ответа. Условие
-- claimed_at IS NULL — часть ЗАПРОСА, а не проверка после: заявить дважды один
-- файл нельзя, и решать это должна база, а не окно между чтением и записью.
-- name: GetPendingSubmissionFile :one
SELECT id, workspace_id, form_id, block_id, object_key, original_name, size_bytes, content_type, created_at
FROM submission_files
WHERE id = $1 AND claimed_at IS NULL;

-- Заявление: файл привязывается к ответу. Возвращает число строк — ноль значит,
-- что загрузка чужая, не та, или заявлена ДРУГИМ ответом, и приём обязан это
-- заметить.
--
-- Условие про свой ответ (submission_id = $2) обязательно: приём идемпотентен по
-- submission_id (ретрай после сетевого сбоя шлёт тот же), и без него повторная
-- отправка отвергала бы собственные, уже заявленные файлы.
-- name: ClaimSubmissionFile :execrows
-- Размер здесь НЕ трогается: он записан при выдаче слота (и тем же числом
-- подписан), а Verify перед приёмом уже сверил его с настоящим размером объекта в
-- хранилище. Переписать проверенное значение на присланное значило бы вернуть
-- клиенту ровно то доверие, ради отсутствия которого вся проверка и сделана.
UPDATE submission_files
SET submission_id = $2, claimed_at = now()
WHERE id = $1 AND form_id = $3 AND block_id = $4
  AND (claimed_at IS NULL OR submission_id = $2);

-- Файлы ответа — автору (имя для таблицы, ключ для выдачи) и удалению.
-- name: ListSubmissionFiles :many
SELECT id, submission_id, block_id, object_key, original_name, size_bytes, content_type
FROM submission_files
WHERE submission_id = ANY($1::uuid[])
ORDER BY created_at;

-- Один файл для скачивания автором. Членство спрашивает сервис (файл живёт в
-- воркспейсе формы), поэтому здесь — только адрес объекта и его имя.
-- name: GetSubmissionFile :one
SELECT id, workspace_id, form_id, submission_id, object_key, original_name, content_type
FROM submission_files
WHERE id = $1 AND claimed_at IS NOT NULL;

-- Сироты: слот выдан, ответ не пришёл. Порция ограничена — чистка ходит по
-- расписанию и не должна выгребать таблицу целиком одним запросом.
-- name: ListOrphanSubmissionFiles :many
SELECT id, object_key
FROM submission_files
WHERE claimed_at IS NULL AND created_at < $1
ORDER BY created_at
LIMIT $2;

-- Снятие строк по id. Зовётся ПОСЛЕ удаления объектов: строка уносит с собой
-- ключ, и объект, переживший её, найти уже нечем.
-- name: DeleteSubmissionFiles :exec
DELETE FROM submission_files WHERE id = ANY($1::uuid[]);

-- Все заявленные файлы формы — выгрузке: в CSV автор видит имя, а не id. Одним
-- запросом на форму, а не по ответу: строчный запрос дал бы десять тысяч поездок
-- на форму с десятью тысячами ответов. Объём результата ограничен квотой
-- хранилища самого пространства.
-- name: ListFormFiles :many
SELECT id, original_name, size_bytes
FROM submission_files
WHERE form_id = $1 AND claimed_at IS NOT NULL;
