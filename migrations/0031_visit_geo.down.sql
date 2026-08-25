-- Откат 0031: карточки стран и городов остаются без данных. УНОСИТ ДАННЫЕ — вместе
-- с колонками удаляются все собранные страны и города (make migrate-down спросит
-- подтверждение). Восстановить их из визитов нельзя: IP не хранится.
DROP INDEX idx_form_visits_geo;
ALTER TABLE form_visits
    DROP COLUMN country_code,
    DROP COLUMN country,
    DROP COLUMN city;
