-- Откат 0050. Порядок обратный созданию: forms ссылается на schedules, bookings —
-- на schedules и forms. Записи теряются вместе с таблицами: откат — не способ
-- хранения (тот же довод, что у 0010).
DROP INDEX IF EXISTS idx_forms_schedule;
ALTER TABLE forms DROP COLUMN IF EXISTS schedule_id;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS schedule_blocks;
DROP TABLE IF EXISTS schedules;
