-- 0073: имя и фамилия с экрана регистрации пишутся в профиль аккаунта (users.first_name и
-- last_name), а не в анкету; ФИО одной строкой не собирается вовсе — отчество сервису ни для
-- чего не нужно (docs/design/signup-consent.md §3.3).
ALTER TABLE signup_profiles DROP COLUMN full_name;
