DROP INDEX IF EXISTS idx_submissions_consent_revision;
ALTER TABLE submissions DROP COLUMN IF EXISTS consent_revision_id;
ALTER TABLE forms DROP COLUMN IF EXISTS consent_revision_id;
DROP TABLE IF EXISTS form_consent_revisions;
