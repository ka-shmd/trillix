DROP INDEX idx_outbox_coalesce;
ALTER TABLE outbox DROP COLUMN coalesce_key;
ALTER TABLE forms DROP COLUMN notify_on_submission;
