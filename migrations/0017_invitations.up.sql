-- 0017: приглашения в пространство (фаза 18).
--
-- Устроены точно как password_reset_tokens (0011) и email_verification_tokens
-- (0012): в БД лежит только SHA-256 сырого токена — сам токен уходит ссылкой в
-- письме и в базе не хранится, поэтому утечка дампа не даёт рабочих ссылок.
-- Одноразовость и срок — колонками; потребление токена атомарным UPDATE.
CREATE TABLE invitations (
    token_hash   BYTEA PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    -- email хранится как ввели, а сравнивается по lower(): адрес показывается
    -- приглашённому в том виде, в каком его напечатал владелец.
    email        TEXT NOT NULL,
    -- Пригласить ВЛАДЕЛЬЦЕМ нельзя: он ровно один (0016), и передача владения —
    -- отдельное действие, а не побочный эффект приглашения. CHECK выражает
    -- именно это правило, а не перечисляет допустимые роли: список ролей ещё
    -- вырастет, а «владельца не приглашают» останется.
    role         TEXT NOT NULL CHECK (role <> 'owner'),
    invited_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Одно НЕПРИНЯТОЕ приглашение на пару (пространство, адрес): повторная отправка
-- тому же человеку заменяет прежнее, а не плодит десяток живых ссылок, каждая
-- из которых остаётся годной. Частичный индекс — потому что принятых
-- приглашений одному адресу может накопиться сколько угодно (позвали, отозвали,
-- позвали снова).
CREATE UNIQUE INDEX idx_invitations_pending
    ON invitations (workspace_id, lower(email)) WHERE used_at IS NULL;

-- Для фоновой чистки истёкших (аналог idx_password_reset_tokens_expires).
CREATE INDEX idx_invitations_expires ON invitations (expires_at);

-- Новый ключ тарифа: сколько человек помещается в пространство. Заводится
-- ВЫКЛЮЧЕННЫМ (null = безлимит) — гейты приезжают на прод выключенными и
-- включаются отдельным UPDATE (решение фазы 17). Каждый план обязан НАЗВАТЬ
-- каждый ключ каталога: молчание плана не должно значить ни «можно», ни
-- «нельзя» — оно краснеет тестом TestPlansCoverCatalog.
UPDATE plans SET limits = jsonb_set(limits, '{members_per_workspace}', 'null');
