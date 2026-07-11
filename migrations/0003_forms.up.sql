-- 0003: формы как сущности (фаза 2) и иммутабельные версии (наполнятся в фазе 4).
-- Схема и её обоснование — docs/ARCHITECTURE.md §3.3.
-- Идентификаторы — UUIDv7 (domain.NewID); slug — nanoid(10) (domain.NewSlug).

CREATE TABLE forms (
    id                   UUID PRIMARY KEY,
    workspace_id         UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title                TEXT NOT NULL DEFAULT 'Untitled form',
    slug                 TEXT NOT NULL UNIQUE,          -- короткий id для публичной ссылки, nanoid(10)
    status               TEXT NOT NULL DEFAULT 'draft', -- draft | published | closed
    draft_schema         JSONB NOT NULL DEFAULT '{"blocks": []}',
    published_version_id UUID,                          -- FK на form_versions, ставится после публикации (фаза 4)
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Список форм воркспейса сортируется по свежести правки; id — tie-break
-- составного курсора (updated_at, id), стабильного при правках во время листания.
CREATE INDEX idx_forms_workspace ON forms (workspace_id, updated_at DESC, id DESC);

-- Иммутабельный снапшот черновика на момент публикации. Создаётся в фазе 4;
-- таблица заводится сейчас, чтобы FK forms.published_version_id имел цель.
CREATE TABLE form_versions (
    id         UUID PRIMARY KEY,
    form_id    UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    version    INT  NOT NULL,
    schema     JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (form_id, version)
);

ALTER TABLE forms
    ADD CONSTRAINT forms_published_version_fk
    FOREIGN KEY (published_version_id) REFERENCES form_versions(id);
