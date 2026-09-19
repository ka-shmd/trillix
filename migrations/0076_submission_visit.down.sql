-- Откат 0076: связь ответа с визитом теряется (сами ответы и визиты целы).
ALTER TABLE submissions DROP COLUMN visit_id;
