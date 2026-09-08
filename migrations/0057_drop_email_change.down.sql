-- Откат 0057 — воссоздание таблицы 0022 ПУСТОЙ. Данные не возвращаются: строки
-- удалены вместе с таблицей, и восстанавливать одноразовые токены со сроком в
-- сутки было бы бессмысленно даже при наличии дампа.
--
-- Таблица нужна откату ровно затем, чтобы 0022 и всё, что за ней, оставались
-- накатываемыми на чистую базу в любом порядке.
CREATE TABLE email_change_tokens (
    token_hash BYTEA PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    new_email  TEXT NOT NULL CHECK (new_email = lower(new_email)),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_change_tokens_expires ON email_change_tokens (expires_at);
