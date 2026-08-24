-- 0033: частичные ответы — черновик того, что респондент набрал и не отправил
-- (спека design/analytics-tally.md §10, ADR §10).
--
-- ГЛАВНОЕ: продукт начинает хранить то, что человек НЕ ОТПРАВЛЯЛ. Это качественно
-- другое обещание, чем визиты и user-agent, поэтому сбор включается тумблером формы
-- (колонка ниже), тумблер за платным тарифом, а респондента предупреждают на самой
-- форме. Правило «платным становится показ, а не сбор» здесь сознательно
-- развёрнуто: визиты — счётчики, а черновик — содержимое чужого ответа.
ALTER TABLE forms ADD COLUMN collect_partial BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE partial_submissions (
    -- Ключ — id ВИЗИТА, а не свой: черновик принадлежит одному визиту, и второе
    -- автосохранение обязано перезаписать первое, а не создать вторую строку.
    --
    -- FK на form_visits тут НЕТ намеренно: бикон визита может не доехать (CSP,
    -- лимитер, закрытая вкладка), а черновик от этого пропадать не должен.
    visit_id        UUID PRIMARY KEY,
    form_id         UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    form_version_id UUID NOT NULL REFERENCES form_versions(id),
    -- Набранное на момент последнего автосохранения. Валидация МЯГКАЯ: черновик
    -- неполон по определению, требовать обязательные поля значило бы не сохранить
    -- ничего. Файлы сюда не входят — слот файла выдаётся отдельным потоком и
    -- считается в квоту хранилища.
    answers         JSONB NOT NULL,
    last_block_id   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Листинг черновиков формы новыми сверху плюс чистка по возрасту. Курсор составной
-- (updated_at, visit_id): черновик МЕНЯЕТСЯ, пока человек печатает, поэтому
-- одноколоночный курсор по id (как у иммутабельных ответов) здесь не годится.
CREATE INDEX idx_partial_form ON partial_submissions (form_id, updated_at DESC, visit_id DESC);

-- Ключ гейта в лимитах ВСЕХ планов: молчание плана про известный ключ считается
-- ошибкой конфигурации и краснеет TestPlansCoverCatalog (данные решают, что даёт
-- план; какие гейты бывают — код в internal/entitlements/catalog.go).
--
-- В true, как и остальные: возможность открыта всем, гейт стоит на месте
-- выключенным. Включение — один UPDATE без выкатки:
--
--   UPDATE plans SET limits = jsonb_set(limits, '{submissions_partial}', 'false')
--    WHERE code IN ('free', 'legacy_free');
UPDATE plans SET limits = limits || '{"submissions_partial": true}'::jsonb;
