-- Откат снимает бланк, тумблер и ключ. Настройка теряется целиком, и вернуть её
-- нечем: колонка и есть единственное её хранилище.
UPDATE plans SET limits = limits - 'form_respondent_email';
ALTER TABLE forms DROP COLUMN respondent_email;
ALTER TABLE forms DROP COLUMN notify_respondent;
