-- Откат 0032: карточка «Уникальные» остаётся без данных. УНОСИТ ДАННЫЕ — вместе с
-- колонкой удаляются все собранные ключи (make migrate-down спросит подтверждение).
-- Восстановить их нельзя: ни IP, ни вчерашние соли не хранятся.
DROP INDEX idx_form_visits_visitor;
ALTER TABLE form_visits DROP COLUMN visitor_key;
