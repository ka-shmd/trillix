-- Откат 0065. Возвращает схему, но НЕ данные: удалённые события канала gsheets
-- не восстанавливаются, а связки, стоявшие в backfilling, вернутся как live —
-- накат их различие уже стёр.
ALTER TABLE form_integrations ADD COLUMN backfill_before TIMESTAMPTZ;

ALTER TABLE form_integrations DROP CONSTRAINT form_integrations_status_check;
ALTER TABLE form_integrations
    ADD CONSTRAINT form_integrations_status_check CHECK (status IN ('backfilling', 'live', 'broken'));

DROP TABLE sheet_queue;

ALTER TABLE form_integrations
    DROP COLUMN consecutive_failures,
    DROP COLUMN failing_since,
    DROP COLUMN next_attempt_at;
