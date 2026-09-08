-- Откат 0056: возвращает TOTP (0023) и убирает код на почту.

CREATE TABLE user_totp (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret     BYTEA NOT NULL,
    confirmed_at TIMESTAMPTZ,
    last_step  BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE totp_recovery_codes (
    code_hash BYTEA PRIMARY KEY,
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at   TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_totp_recovery_codes_user ON totp_recovery_codes (user_id);

DROP INDEX idx_known_devices_user;
DROP TABLE known_devices;
DROP TABLE login_codes;
ALTER TABLE users DROP COLUMN two_factor_enabled;
