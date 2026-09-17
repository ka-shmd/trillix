-- 0070: список реквизитов оператора в пространстве — подсказка в разделе «Персональные
-- данные» другой формы (решение владельца 2026-09-17, docs/design/privacy-consent.md §3.6).
--
-- Копия, а не источник: ревизия согласия хранит реквизиты сама, и правка или удаление
-- строки здесь не меняет ни форм, ни документов, с которыми соглашались люди.
CREATE TABLE consent_operators (
    id           UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    inn          TEXT NOT NULL,
    address      TEXT NOT NULL,
    email        TEXT NOT NULL,
    -- Отпечаток набора — ключ «одинаковые не дублируются». Хешем, а не уникальным индексом
    -- по четырём колонкам: наименование и адрес вместе длиннее предела строки индекса
    -- btree (~2,7 КБ), и вставка длинного набора падала бы ошибкой БД.
    fingerprint  TEXT GENERATED ALWAYS AS
        (md5(name || E'\x1f' || inn || E'\x1f' || address || E'\x1f' || email)) STORED,
    -- Когда набор сохранили в последний раз: подсказка показывает свежие первыми.
    used_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, fingerprint)
);

-- Подсказка: свежие наборы пространства.
CREATE INDEX idx_consent_operators_workspace ON consent_operators (workspace_id, used_at DESC);
