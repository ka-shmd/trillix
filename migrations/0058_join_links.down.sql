-- Откат 0058: ссылки-приглашения снимаются, таблица приглашений 0017
-- воссоздаётся ПУСТОЙ. Данные не возвращаются — строки удалены вместе с
-- таблицей, и восстанавливать одноразовые токены со сроком в неделю было бы
-- бессмысленно даже при наличии дампа.
--
-- Таблица нужна откату ровно затем, чтобы 0017 и всё, что за ней, оставались
-- накатываемыми на чистую базу в любом порядке.
CREATE TABLE invitations (
    token_hash   BYTEA PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email        TEXT NOT NULL,
    role         TEXT NOT NULL CHECK (role <> 'owner'),
    invited_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_invitations_pending
    ON invitations (workspace_id, lower(email)) WHERE used_at IS NULL;

CREATE INDEX idx_invitations_expires ON invitations (expires_at);

DROP TABLE IF EXISTS workspace_join_links;
