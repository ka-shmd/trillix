-- 0062: вебхуки (фаза 28 DEV-PLAN, спека docs/design/webhooks.md §4, ADR §10).
-- Три части: цель доставки, её очередь и общий для обоих видов цели журнал.

-- form_webhooks — цель доставки: адрес, секрет подписи и СОСТОЯНИЕ цели.
-- Расписание живёт здесь, а не у строки очереди: если адрес лежит, он лежит
-- для всех ответов разом, и пауза нужна цели, а не каждому событию.
CREATE TABLE form_webhooks (
    id                   UUID PRIMARY KEY,
    form_id              UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL DEFAULT '',
    -- url — адрес получателя. Сам по себе секрет: Zapier и Make кодируют токен
    -- в пути, поэтому в логи уходит только хост.
    url                  TEXT NOT NULL,
    -- secret — секрет подписи ШИФРОТЕКСТОМ (AES-GCM, ключ — HKDF от
    -- FORM_TOKEN_SECRET со своей меткой). Хешем нельзя: для подписи он нужен в
    -- открытом виде.
    secret               BYTEA NOT NULL,
    -- set_by — кто последним задал адрес: сторож членства перед доставкой.
    -- SET NULL, а не каскад: удаление аккаунта не должно молча удалять вебхук
    -- команды — пустое значение сторож читает как «отвечать некому».
    set_by               UUID REFERENCES users(id) ON DELETE SET NULL,
    enabled              BOOLEAN NOT NULL DEFAULT true,
    status               TEXT NOT NULL DEFAULT 'live',
    last_error           TEXT,                              -- человеческая причина для экрана
    last_delivered_at    TIMESTAMPTZ,
    -- Расписание цели: когда её можно тронуть, с какого момента она подряд не
    -- принимает (сутки — поломка) и какая по счёту неудача (бэкофф).
    next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    failing_since        TIMESTAMPTZ,
    consecutive_failures INT NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT form_webhooks_status_check CHECK (status IN ('live', 'broken'))
);

-- Вебхуки формы: список на экране и постановка при приёме ответа (у формы их
-- не больше пяти, поэтому частичный индекс по enabled выгоды не даёт).
CREATE INDEX idx_form_webhooks_form ON form_webhooks (form_id);

-- webhook_queue — «этот ответ ещё не доставлен в эту цель». Доставленная
-- строка удаляется (история — в журнале), поэтому таблица всегда маленькая.
-- Ключ — пара: двойная постановка (повтор из журнала, двойной клик) безвредна.
CREATE TABLE webhook_queue (
    webhook_id    UUID NOT NULL REFERENCES form_webhooks(id) ON DELETE CASCADE,
    -- Каскад: удалённый ответ везти некуда.
    submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (webhook_id, submission_id)
);

-- Порядок внутри цели: ответы уходят в порядке постановки.
CREATE INDEX idx_webhook_queue_order ON webhook_queue (webhook_id, enqueued_at);
-- Срок хранения (30 дней) — уборка по возрасту.
CREATE INDEX idx_webhook_queue_age ON webhook_queue (enqueued_at);

-- Журнал доставок становится общим для обоих видов цели: запись висит ЛИБО на
-- связке Таблиц, ЛИБО на вебхуке. Каскад тот же довод, что у link_id: удалили
-- цель — её история уходит с ней, иначе новая цель показала бы чужие доставки.
ALTER TABLE integration_deliveries ALTER COLUMN link_id DROP NOT NULL;
ALTER TABLE integration_deliveries
    ADD COLUMN webhook_id UUID REFERENCES form_webhooks(id) ON DELETE CASCADE;
-- http_status — код ответа получателя. Пусто у Таблиц и у отказа до ответа
-- (таймаут, DNS, запрет адреса).
ALTER TABLE integration_deliveries ADD COLUMN http_status INT;
ALTER TABLE integration_deliveries
    ADD CONSTRAINT integration_deliveries_target CHECK (num_nonnulls(link_id, webhook_id) = 1);

CREATE INDEX idx_integration_deliveries_webhook
    ON integration_deliveries (webhook_id, id DESC) WHERE webhook_id IS NOT NULL;
