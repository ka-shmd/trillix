-- 0059: шаблоны форм переезжают из статики фронта в базу (задача владельца
-- 2026-09-08, POST-MVP фаза 19 шаги 1 и 4). До этой миграции шаблонов в
-- продукте не существовало как данных: шесть заготовок лежали константой в
-- web/app/src/features/forms/templates/templates.ts, и «свой шаблон» был
-- невыразим в принципе.
--
-- ВИДИМОСТЕЙ ДВЕ, А НЕ ТРИ. План фазы называл третью — built_in для встроенных;
-- решение владельца 2026-09-08: встроенные заливаются той же ручкой, что и
-- прочие публичные, и отличаются от них ровно ничем. Третье значение означало
-- бы третью ветку в каждой выборке ради различия, которого никто не видит.
CREATE TABLE form_templates (
    id           UUID PRIMARY KEY,
    -- Чей шаблон. NULL ровно у публичных: публичный шаблон не принадлежит
    -- пространству — он виден всем и переживает удаление пространства автора.
    -- Пару «видимость × пространство» держит CHECK ниже, а не соглашение в Go.
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    -- Кто сохранил. ON DELETE SET NULL: шаблон пространства переживает уход
    -- своего автора из продукта — он принадлежит команде, а не человеку.
    author_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    -- Документ формы целиком: блоки, оформление, обложка, логотип. Структуру
    -- проверяет ValidateSchema в приложении (migrations/CLAUDE.md), не БД.
    schema       JSONB NOT NULL,
    visibility   TEXT NOT NULL CHECK (visibility IN ('private', 'public')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT form_templates_scope CHECK (
        (visibility = 'private' AND workspace_id IS NOT NULL) OR
        (visibility = 'public' AND workspace_id IS NULL)
    )
);

-- Галерея пространства: свои шаблоны, свежие сверху. id — tie-break, как у
-- списка форм (0003).
CREATE INDEX idx_form_templates_workspace
    ON form_templates (workspace_id, created_at DESC, id DESC);

-- Галерея публичных: одна выборка на всех, поэтому индекс частичный — строк с
-- visibility='public' в таблице меньшинство, и приватные в него не попадают.
CREATE INDEX idx_form_templates_public
    ON form_templates (created_at ASC, id ASC) WHERE visibility = 'public';

-- Администратор сервиса: единственный, кто может завести публичный шаблон.
-- Ставится руками (UPDATE users SET is_admin = true WHERE email = …) — экрана
-- у флага нет и в этой задаче не появляется, приложение для админов будет
-- отдельной работой. Роли пространства (workspace_members.role) флаг не
-- касается вовсе: те про доступ к чужим формам, этот — про витрину сервиса.
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
