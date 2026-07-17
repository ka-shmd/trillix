-- Откат 0007: убрать настройки закрытия формы (форма снова закрывается только
-- вручную снятием с публикации).
ALTER TABLE forms DROP COLUMN closed_message;
ALTER TABLE forms DROP COLUMN response_limit;
ALTER TABLE forms DROP COLUMN close_at;
