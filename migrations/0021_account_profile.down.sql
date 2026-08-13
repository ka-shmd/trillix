-- Откат 0021. Данные профиля теряются — это и есть откат: колонок не было.
ALTER TABLE user_identities DROP COLUMN provider_email;
ALTER TABLE users DROP COLUMN last_name;
ALTER TABLE users DROP COLUMN first_name;
