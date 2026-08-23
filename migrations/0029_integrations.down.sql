-- Откат 0029. Порядок обратный созданию: form_integrations ссылается на
-- integration_accounts.
DROP TABLE IF EXISTS form_integrations;
DROP TABLE IF EXISTS integration_accounts;
