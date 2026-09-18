ALTER TABLE signup_profiles
    ADD COLUMN full_name TEXT CHECK (char_length(full_name) BETWEEN 1 AND 200);
