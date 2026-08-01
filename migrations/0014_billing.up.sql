-- 0014: тарифы и лимиты (фаза 17, спека docs/DESIGN-billing.md).
--
-- Фаза денег НЕ принимает: ни платёжного провайдера, ни таблицы payments, ни
-- статусов past_due/trialing — они приезжают вместе с платежами. Здесь только
-- тарифный контур: какой у воркспейса план, что план разрешает, сколько уже
-- израсходовано.

-- plans — каталог тарифов.
--
-- limits — JSONB, а не колонки на возможность: вся цель фазы в том, чтобы
-- добавление гейта стоило строки данных, а не миграции (ADR §10, спека §4).
-- Плата названа вслух: содержимое limits БД не проверяет, сторожем работает
-- каталог в Go (internal/entitlements) и тест TestPlansCoverCatalog — молчание
-- плана про известную возможность обязано краснеть, а не значить «разрешено».
--
-- price_kopeks заводится сразу, хотя в этой фазе ни на что не влияет: колонка,
-- добавленная вместе с платежами, потребовала бы миграции ровно тогда, когда
-- трогать биллинг страшнее всего.
CREATE TABLE plans (
    code         TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    price_kopeks INTEGER NOT NULL DEFAULT 0 CHECK (price_kopeks >= 0),
    limits       JSONB NOT NULL,
    -- is_public = false → план не показывается в списке тарифов. Такова доля
    -- legacy_free: выбрать его нельзя, в нём можно только остаться.
    is_public    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- subscriptions — подписка воркспейса. Ровно одна на воркспейс (PK по
-- workspace_id, а не отдельный id): «история подписок» — это журнал платежей
-- будущей фазы, а не набор строк здесь. Субъект подписки — воркспейс, потому
-- что монетизируется его содержимое (ADR §10).
--
-- status в этой фазе принимает active | canceled: past_due и trialing нечему
-- выставлять, пока нет списаний. Значения перечислены CHECK'ом, а не ENUM'ом:
-- добавить значение в CHECK — одна миграция, в ENUM — история про ALTER TYPE
-- вне транзакции.
CREATE TABLE subscriptions (
    workspace_id       UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    plan_code          TEXT NOT NULL REFERENCES plans(code),
    status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
    -- NULL у бесплатных планов: у них нет оплаченного периода.
    current_period_end TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- workspace_usage — расход за период. Отдельной таблицей, а не COUNT(*) по
-- submissions: счёт стоит на ГОРЯЧЕМ пути приёма ответа и по растущей таблице
-- незаметен на десяти формах, но ложится на тысяче (ADR §10).
--
-- period — первое число месяца по Europe/Moscow (решение владельца: «лимит
-- обнуляется 1-го числа» объяснимо пользователю одной фразой). Значение
-- вычисляет приложение — часовой пояс сервера БД в это не вмешивается.
CREATE TABLE workspace_usage (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    period       DATE NOT NULL,
    submissions  BIGINT NOT NULL DEFAULT 0 CHECK (submissions >= 0),
    PRIMARY KEY (workspace_id, period)
);

-- submissions.over_quota — ответ пришёл сверх квоты тарифа.
--
-- Пометка на строке, а не вычисление «сверхлимитного хвоста» на чтении: хвост
-- не дружит с курсорной пагинацией и просачивается в три независимых запроса
-- (список, экспорт, сводка), считаясь заново каждым. Колонка — одно условие в
-- WHERE и один UPDATE при апгрейде плана (ADR §10, спека §6).
--
-- ВАЖНО: это не отказ в приёме. Ответ сохраняется всегда, при любом состоянии
-- подписки; скрыт он только в кабинете владельца. Жёсткий кап формы
-- (forms.response_limit, 0007) — другая семантика: его ставит владелец, и он
-- действительно закрывает приём.
ALTER TABLE submissions ADD COLUMN over_quota BOOLEAN NOT NULL DEFAULT false;

-- Каталог тарифов.
--
-- ГЕЙТЫ ПРИЕЗЖАЮТ ВЫКЛЮЧЕННЫМИ (спека §8): у всех трёх планов лимиты
-- безлимитные, поэтому выкатка кода не запирает ничего никому. Включение —
-- отдельный UPDATE тогда, когда владелец решит, по одному ключу за раз:
--
--   UPDATE plans SET limits = jsonb_set(limits, '{submissions_per_month}', '100')
--    WHERE code = 'free';
--   UPDATE plans SET limits = jsonb_set(limits, '{analytics_funnel}', 'false')
--    WHERE code = 'free';
--
-- Число 100 — решение владельца 2026-08-01 (спека §11.1); оно живёт здесь
-- комментарием, а не значением, потому что момент включения — тоже решение,
-- и оно отдельное. Тот же UPDATE — аварийный тумблер обратно: гейт, ведущий
-- себя не так, снимается изменением данных за секунды, а не откатом релиза.
--
-- null = безлимит, отсутствие ключа = ошибка конфигурации (краснеет тестом).
INSERT INTO plans (code, title, price_kopeks, limits, is_public) VALUES
    ('free', 'Бесплатный', 0, '{
        "submissions_per_month": null,
        "workspaces": null,
        "analytics_funnel": true,
        "analytics_sources": true
     }'::jsonb, true),
    -- Цена Pro и его лимит по ответам не решены: цена бессмысленна без платежей,
    -- лимит — один UPDATE. Ставим безлимит, чтобы Pro не оказался УЖЕ Free.
    ('pro', 'Pro', 0, '{
        "submissions_per_month": null,
        "workspaces": null,
        "analytics_funnel": true,
        "analytics_sources": true
     }'::jsonb, true),
    -- legacy_free — грандфазеринг: план тех, кто пришёл до тарифов. Свои лимиты,
    -- на новый Free не мигрирует никогда, в списке тарифов не показывается.
    -- Заводится ДО первого тарифа, потому что задним числом — уже поздно.
    ('legacy_free', 'Бесплатный (ранний доступ)', 0, '{
        "submissions_per_month": null,
        "workspaces": null,
        "analytics_funnel": true,
        "analytics_sources": true
     }'::jsonb, false);

-- Все существующие воркспейсы — на legacy_free. Воркспейса без подписки не
-- бывает: иначе каждая проверка лимита обрастает веткой «а если строки нет»,
-- и однажды эта ветка разрешит лишнее.
INSERT INTO subscriptions (workspace_id, plan_code)
SELECT id, 'legacy_free' FROM workspaces;
