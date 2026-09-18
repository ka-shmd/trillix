ALTER TABLE signup_profiles
    DROP CONSTRAINT IF EXISTS signup_profiles_company_fields,
    DROP CONSTRAINT IF EXISTS signup_profiles_person_fields,
    DROP COLUMN IF EXISTS job_position,
    DROP COLUMN IF EXISTS industry,
    DROP COLUMN IF EXISTS company_name,
    DROP COLUMN IF EXISTS profession,
    DROP COLUMN IF EXISTS occupation,
    DROP COLUMN IF EXISTS full_name;
