-- Откат 0067. Подключённые счётчики форм теряются — восстановить их откат не может,
-- поэтому make migrate-down спросит подтверждение (DROP TABLE в списке разрушающих).
UPDATE plans SET limits = limits - 'form_counters';
DROP TABLE IF EXISTS form_counters;
