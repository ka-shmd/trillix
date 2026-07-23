-- 0011: токены сброса пароля (почтовая фаза, слайс B). По образцу sessions:
-- в БД лежит только SHA-256 сырого токена (утечка дампа не даёт рабочих ссылок).
-- Одноразовость и срок — колонками, потребление токена атомарным UPDATE
-- (см. internal/auth/queries.sql ConsumePasswordResetToken).
CREATE TABLE password_reset_tokens (
    token_hash BYTEA PRIMARY KEY,       -- SHA-256 сырого токена (не логируется)
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,    -- 30 минут от выдачи
    used_at    TIMESTAMPTZ,             -- NULL = не использован; ставится при сбросе (одноразовость)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Для фоновой чистки истёкших/использованных токенов (аналог idx_sessions_expires).
CREATE INDEX idx_password_reset_tokens_expires ON password_reset_tokens (expires_at);
