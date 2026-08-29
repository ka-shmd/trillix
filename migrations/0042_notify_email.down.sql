-- Откат снимает шаблон и ключ и возвращает прежний дефолт тумблера. Уже
-- выключенные письма обратно НЕ включаются: какие формы автор выключил сам, а
-- какие погасила эта миграция, нигде не записано, а включать чужую рассылку
-- наугад хуже, чем оставить её выключенной.
UPDATE plans SET limits = limits - 'form_notify_email';
ALTER TABLE forms DROP COLUMN notify_email;
ALTER TABLE forms ALTER COLUMN notify_on_submission SET DEFAULT true;
