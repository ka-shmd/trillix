-- Откат 0063. Вебхукам без подписи проставляется пустой секрет: код предыдущей
-- версии колонку без значения не читает. Подписи у них и не было — после отката
-- они встанут с причиной «секрет не читается», и лечение прежнее: задать заново.
UPDATE form_webhooks SET secret = ''::bytea WHERE secret IS NULL;
ALTER TABLE form_webhooks ALTER COLUMN secret SET NOT NULL;
