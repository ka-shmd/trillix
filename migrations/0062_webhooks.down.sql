-- Откат 0062. Записи журнала о вебхуках удаляются ДО возврата NOT NULL на
-- link_id: у них link_id пуст, и ALTER без этого упал бы.
DROP INDEX IF EXISTS idx_integration_deliveries_webhook;
DELETE FROM integration_deliveries WHERE webhook_id IS NOT NULL;
ALTER TABLE integration_deliveries DROP CONSTRAINT IF EXISTS integration_deliveries_target;
ALTER TABLE integration_deliveries DROP COLUMN IF EXISTS http_status;
ALTER TABLE integration_deliveries DROP COLUMN IF EXISTS webhook_id;
ALTER TABLE integration_deliveries ALTER COLUMN link_id SET NOT NULL;

DROP TABLE IF EXISTS webhook_queue;
DROP TABLE IF EXISTS form_webhooks;
