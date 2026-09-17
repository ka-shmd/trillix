-- 0072: анкета регистрации по вкладкам «Частное лицо» и «Компания или ИП» (решение владельца
-- 2026-09-17 по образцу WebAsk, docs/design/signup-consent.md §3.3). Цель использования и
-- источник остаются общими для обеих вкладок.
ALTER TABLE signup_profiles
    -- ФИО одной строкой, как человек его пишет: разбора на части нет, а отчество в профиле
    -- (users.first_name/last_name) не живёт.
    ADD COLUMN full_name    TEXT CHECK (char_length(full_name) BETWEEN 1 AND 200),
    -- Частное лицо.
    ADD COLUMN occupation   TEXT CHECK (occupation IN
        ('study', 'employed', 'freelance', 'teaching', 'science', 'other')),
    ADD COLUMN profession   TEXT CHECK (char_length(profession) BETWEEN 1 AND 100),
    -- Компания или ИП.
    ADD COLUMN company_name TEXT CHECK (char_length(company_name) BETWEEN 1 AND 300),
    ADD COLUMN industry     TEXT CHECK (industry IN
        ('education', 'it', 'marketing', 'healthcare', 'retail', 'services',
         'manufacturing', 'finance', 'public', 'hr', 'events', 'other')),
    ADD COLUMN job_position TEXT CHECK (job_position IN
        ('owner', 'marketing', 'hr', 'product', 'analytics', 'teaching', 'development', 'other')),
    -- Поля одной вкладки у другой не хранятся: переключение вкладки не должно оставлять в
    -- анкете компании профессию частного лица.
    ADD CONSTRAINT signup_profiles_person_fields
        CHECK (kind = 'person' OR (occupation IS NULL AND profession IS NULL)),
    ADD CONSTRAINT signup_profiles_company_fields
        CHECK (kind = 'company' OR (company_name IS NULL AND industry IS NULL AND job_position IS NULL));
