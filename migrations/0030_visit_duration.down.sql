-- Откат 0030: карточка «Длительность визита» остаётся без данных, период по
-- визитам снова идёт мимо индекса. УНОСИТ ДАННЫЕ — колонка updated_at удаляется
-- вместе со всеми собранными временами последнего бикона (make migrate-down
-- спросит подтверждение).
DROP INDEX idx_form_visits_form;
CREATE INDEX idx_form_visits_form ON form_visits (form_id, last_block_id, submitted);
ALTER TABLE form_visits DROP COLUMN updated_at;
