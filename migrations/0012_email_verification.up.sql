-- 0012: подтверждение email (почтовая фаза, слайс C). Мягкое: аккаунт работает
-- сразу, неподтверждённый адрес помечается баннером в кабинете.
--
-- Колонка на users добавляется nullable (обратная совместимость: существующие
-- строки → NULL → «не подтверждён»). Токены — по образцу password_reset_tokens
-- (0011): в БД только SHA-256, одноразовость и срок колонками, потребление
-- атомарным UPDATE (см. internal/auth/queries.sql ConsumeEmailVerificationToken).

ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;  -- NULL = не подтверждён

CREATE TABLE email_verification_tokens (
    token_hash BYTEA PRIMARY KEY,       -- SHA-256 сырого токена (не логируется)
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,    -- 24 часа от выдачи (подтверждение не так срочно, как сброс)
    used_at    TIMESTAMPTZ,             -- NULL = не использован; ставится при подтверждении (одноразовость)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Для фоновой чистки истёкших/использованных токенов (аналог idx_password_reset_tokens_expires).
CREATE INDEX idx_email_verification_tokens_expires ON email_verification_tokens (expires_at);
