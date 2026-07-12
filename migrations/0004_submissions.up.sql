-- 0004: приём ответов (фаза 5). Ответ респондента привязан к конкретной
-- опубликованной версии формы (form_version_id), чтобы правки схемы не искажали
-- уже собранные данные. Схема и обоснование — docs/ARCHITECTURE.md §3.3.
-- Идентификаторы — UUIDv7 (domain.NewID); id генерирует клиент (идемпотентность).

CREATE TABLE submissions (
    id              UUID PRIMARY KEY,            -- UUIDv7, генерируется клиентом → ретрай упирается в PK
    form_id         UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    form_version_id UUID NOT NULL REFERENCES form_versions(id),
    answers         JSONB NOT NULL,              -- { "<block_id>": <значение> }
    meta            JSONB NOT NULL DEFAULT '{}', -- user_agent, referer (без IP в открытом виде)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Листинг ответов формы (фаза 6): новые сверху. id (UUIDv7) монотонен по времени,
-- курсорная пагинация пойдёт по нему; сортировочный индекс — по created_at.
CREATE INDEX idx_submissions_form ON submissions (form_id, created_at DESC);
