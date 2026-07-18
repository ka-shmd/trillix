-- Запросы модуля visits. Схема — migrations/0008_form_visits. Генерация:
-- `make sqlc` (общий пакет internal/postgres).

-- name: UpsertFormVisit :exec
-- Запись визита биконом рендерера. id генерирует клиент (UUIDv7), поэтому второй
-- бикон того же визита упирается в PK и становится UPDATE'ом.
--
-- Обновляются РОВНО два поля. Не обновляются намеренно:
--   submitted       — его ставит только приём ответа; иначе поздний бикон затирал бы
--                     уже засчитанную конверсию обратно в false;
--   form_version_id — визит принадлежит той версии, на которой открыт; переиздание
--                     формы посреди сессии не должно переклеивать его на новую;
--   meta, created_at — контекст первого касания, а не последнего.
--
-- Два условия в WHERE — не перестраховка, каждое закрывает свой сценарий:
--   form_id — id визита выбирает клиент, а UUIDv7 угадываем по временно́му префиксу:
--             без этого условия ручкой одной формы правится строка другой;
--   seq     — sendBeacon не гарантирует порядок доставки, а visibilitychange шлёт
--             бикон на каждое переключение вкладки, поэтому «поздний» ранний бикон
--             без этого условия отбрасывал бы визит назад по воронке.
INSERT INTO form_visits (id, form_id, form_version_id, last_block_id, seq, meta)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (id) DO UPDATE
SET last_block_id = EXCLUDED.last_block_id,
    seq           = EXCLUDED.seq
WHERE form_visits.form_id = EXCLUDED.form_id
  AND form_visits.seq < EXCLUDED.seq;

-- name: MarkVisitSubmitted :execrows
-- Отметка конверсии при приёме ответа. Ограничено form_id: визит чужой формы по
-- угаданному id не пометить. 0 строк — не ошибка: визита нет (бикон потерялся,
-- страница из кэша старой версии, подделанный visit_id) → ответ всё равно принят,
-- аналитика не имеет права его отклонить.
UPDATE form_visits SET submitted = true
WHERE id = $1 AND form_id = $2;

-- name: CountFormVisits :one
-- Просмотры и конверсия формы одним сканом по idx_form_visits_form.
SELECT count(*) AS total,
       count(*) FILTER (WHERE submitted) AS submitted
FROM form_visits
WHERE form_id = $1;
