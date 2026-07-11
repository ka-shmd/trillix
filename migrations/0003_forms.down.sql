-- Откат 0003. Сначала снять циклический FK forms → form_versions, затем таблицы
-- в порядке, обратном зависимостям (form_versions ссылается на forms).
ALTER TABLE forms DROP CONSTRAINT IF EXISTS forms_published_version_fk;
DROP TABLE IF EXISTS form_versions;
DROP TABLE IF EXISTS forms;
