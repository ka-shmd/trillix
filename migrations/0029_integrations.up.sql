-- 0029: интеграции формы, первая из них — Google Таблицы (фаза 25 DEV-PLAN,
-- слайс A). Решения и отвергнутые альтернативы — docs/ARCHITECTURE.md §10 (ADR),
-- спека docs/design/integrations-gsheets.md.

-- Подключённый внешний аккаунт. Принадлежит ПРОСТРАНСТВУ, а не пользователю:
-- формы лежат в пространствах, и подключение на user_id означало бы, что кредс
-- участника доступен формам чужой команды, куда его позвали, а после снятия
-- доступа ответы продолжают течь в Drive бывшего участника (ADR §10).
CREATE TABLE integration_accounts (
    id                  UUID PRIMARY KEY,                    -- UUIDv7 (domain.NewID)
    workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,                       -- google (второй провайдер приедет без миграции)
    external_account_id TEXT NOT NULL,                       -- sub из id_token: стабилен при смене почты у провайдера
    external_email      TEXT NOT NULL,                       -- «подключено как …» на экране; не идентификатор
    refresh_token       BYTEA NOT NULL,                      -- AES-256-GCM, ключ — HKDF от FORM_TOKEN_SECRET (секрет: не логируется)
    scopes              TEXT NOT NULL,                       -- что реально выдал провайдер: проверяем, а не верим запрошенному
    -- connected_by — не только аудит «чьим согласием данные уезжают наружу»
    -- (152-ФЗ), но и правило «ушёл человек — ушло его согласие», выраженное
    -- схемой: CASCADE уносит подключение при удалении аккаунта, и доставка
    -- встаёт со статусом «нужно переподключить», а не течёт молча.
    connected_by        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connected_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Одно подключение на провайдера в пространстве (рамка MVP): второго
-- потребителя нет, а снять ограничение можно миграцией, не трогая модель.
CREATE UNIQUE INDEX idx_integration_accounts_ws ON integration_accounts (workspace_id, provider);

-- Форма ↔ таблица. Отдельно от аккаунта, потому что подключение переживает
-- отвязку формы и наоборот.
CREATE TABLE form_integrations (
    id                UUID PRIMARY KEY,
    form_id           UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    account_id        UUID NOT NULL REFERENCES integration_accounts(id) ON DELETE CASCADE,
    spreadsheet_id    TEXT NOT NULL,
    spreadsheet_url   TEXT NOT NULL,                         -- показываем ссылкой; собирать её строкой в UI значит однажды собрать неверно
    sheet_id          INT NOT NULL,                          -- gid листа: имя автор волен переименовать, gid — нет
    -- columns — порядок КЛЮЧЕЙ колонок листа (метаколонки + id вопросов), а не
    -- подписей: сопоставление «колонка ↔ вопрос» по подписи разъехалось бы при
    -- первом же переименовании вопроса. Колонка только добавляется (спека §8).
    columns           JSONB NOT NULL,
    status            TEXT NOT NULL,                         -- backfilling | live | broken
    backfill_before   TIMESTAMPTZ,                           -- отсечка догрузки; NULL, когда догрузка кончилась
    last_error        TEXT,                                  -- человеческая причина для экрана; не секрет
    last_delivered_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT form_integrations_status_check CHECK (status IN ('backfilling', 'live', 'broken'))
);

-- Одна таблица на форму (рамка MVP) — и он же индекс горячего запроса
-- «куда доставлять ответ этой формы».
CREATE UNIQUE INDEX idx_form_integrations_form ON form_integrations (form_id);

-- Запрос экрана пространства «какие формы уже привязаны» и каскад отключения.
CREATE INDEX idx_form_integrations_account ON form_integrations (account_id);
