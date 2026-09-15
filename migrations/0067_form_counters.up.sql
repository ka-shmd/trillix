-- 0067: счётчики аналитики автора на форме (фаза 29 DEV-PLAN, спека
-- docs/design/yandex-metrika.md §4–§5, ADR §10). Первый вид — Яндекс Метрика.

-- form_counters — счётчик формы. Живая настройка, а не поле схемы: подключение и
-- тумблер действуют без перепубликации. У формы не больше одного счётчика вида.
CREATE TABLE form_counters (
    id         UUID PRIMARY KEY,
    form_id    UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    -- kind — вид счётчика. Новый вид (VK Pixel, GA) — значение в CHECK, а не новая
    -- таблица. Зеркалит CounterYandexMetrika в internal/integrations/counter.go.
    kind       TEXT NOT NULL,
    -- counter — номер счётчика в сервисе: идентификатор, а не число, поэтому текстом.
    -- Зеркалит counterNumberRe в internal/integrations/counter.go.
    counter    TEXT NOT NULL,
    enabled    BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT form_counters_kind_check CHECK (kind IN ('yandex_metrika')),
    CONSTRAINT form_counters_counter_check CHECK (counter ~ '^[1-9][0-9]{0,11}$'),
    -- Ключ ведётся form_id: он же индекс под чтение счётчика формы при отдаче.
    CONSTRAINT form_counters_form_kind_key UNIQUE (form_id, kind)
);

-- form_counters — платная возможность (решение владельца 2026-09-15): закрыта на
-- free и legacy_free, как свой CSS и снятие бейджа в 0019. Открыть — один UPDATE:
--   UPDATE plans SET limits = jsonb_set(limits, '{form_counters}', 'true')
--    WHERE code IN ('free', 'legacy_free');
UPDATE plans SET limits = limits || '{"form_counters": false}'::jsonb
WHERE code IN ('free', 'legacy_free');
UPDATE plans SET limits = limits || '{"form_counters": true}'::jsonb
WHERE code NOT IN ('free', 'legacy_free');
