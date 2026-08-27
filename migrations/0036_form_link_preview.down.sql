-- Откат: снять ключ со всех планов и убрать колонку. Настроенные карточки при этом
-- теряются — восстановить их откат не может, поэтому make migrate-down спросит
-- подтверждение (DROP COLUMN в списке разрушающих).
UPDATE plans SET limits = limits - 'form_link_preview';
ALTER TABLE forms DROP COLUMN link_preview;
