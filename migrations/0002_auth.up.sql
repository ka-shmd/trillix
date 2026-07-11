-- 0002: реляционный фундамент аутентификации (фаза 1).
-- Схема и её обоснование — docs/ARCHITECTURE.md §3.3.
-- Идентификаторы — UUIDv7, генерируются в приложении (domain.NewID).

CREATE TABLE users (
    id            UUID PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
    password_hash TEXT NOT NULL,               -- argon2id
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Воркспейс закладывается сразу: перевод single-user на команды задним числом —
-- одна из самых болезненных миграций. В MVP при регистрации молча создаётся
-- личный воркспейс, UI его не показывает.
CREATE TABLE workspaces (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         TEXT NOT NULL DEFAULT 'owner',  -- owner | editor (на будущее)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

-- Сессии в БД, а не JWT: мгновенный отзыв, «выйти со всех устройств»,
-- нет ротации ключей. Хранится только SHA-256 от токена.
CREATE TABLE sessions (
    token_hash BYTEA PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);
