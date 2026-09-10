-- 0060: журнал доставок интеграции (пункт очереди BACKLOG, задача владельца
-- 2026-09-10). До этой миграции о доставке было известно ровно одно —
-- form_integrations.last_error, причина ПОСЛЕДНЕЙ неудачи: этого хватает, чтобы
-- понять «сломано», и не хватает, чтобы понять «когда и что именно».

-- Строка = ОДНА попытка доставки, включая ретраи бэкоффа: журнал показывает
-- историю, а не итог. Итог живёт в form_integrations (status, last_error,
-- last_delivered_at) и остаётся там — он отвечает на другой вопрос.
CREATE TABLE integration_deliveries (
    id            UUID PRIMARY KEY,                    -- UUIDv7 (domain.NewID): монотонен по времени, поэтому он же курсор ленты
    -- Адресуется id СВЯЗКИ, а не формы: связок у формы сколько угодно, в том
    -- числе в одну книгу. Каскад — тот же довод: отвязали связку, и её история
    -- уходит с ней, иначе новая связка показала бы чужие доставки.
    link_id       UUID NOT NULL REFERENCES form_integrations(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,                       -- submission (живой ответ) | backfill (пачка переноса)
    -- Какой ответ везли. FK на submissions ЗДЕСЬ НЕТ намеренно: ответ удаляют
    -- (автор, тариф), а запись о том, что мы пробовали его доставить, обязана
    -- пережить удаление — «ответа больше нет» это один из исходов ниже, а не
    -- повод стереть историю. Поэтому же id остаётся заполненным.
    submission_id UUID,
    outcome       TEXT NOT NULL,                       -- delivered | failed | skipped
    -- Человеческий текст для экрана: что произошло и почему. Ошибка провайдера
    -- сюда не попадает — она на английском и про HTTP, а читает это автор формы
    -- (полный текст уходит в лог). У успеха пусто.
    detail        TEXT NOT NULL DEFAULT '',
    -- row_count, а не rows: ROWS — зарезервированное слово Postgres, и колонку
    -- пришлось бы кавычить в каждом запросе.
    row_count     INT NOT NULL DEFAULT 0,              -- сколько строк легло в лист: 1 у живого ответа, до BackfillBatch у пачки
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT integration_deliveries_kind_check CHECK (kind IN ('submission', 'backfill')),
    CONSTRAINT integration_deliveries_outcome_check CHECK (outcome IN ('delivered', 'failed', 'skipped')),
    -- Вид события и его предмет — один факт: у живого ответа id есть всегда, у
    -- пачки переноса его нет вовсе (она про диапазон, а не про строку).
    CONSTRAINT integration_deliveries_subject CHECK (
        (kind = 'submission' AND submission_id IS NOT NULL) OR
        (kind = 'backfill'   AND submission_id IS NULL)
    )
);

-- Горячий запрос ленты — «последние попытки этой связки». id DESC вместо
-- created_at: у пачки переноса соседние попытки ложатся в одну миллисекунду,
-- и порядок по времени между ними не определён, а по UUIDv7 определён всегда.
CREATE INDEX idx_integration_deliveries_link ON integration_deliveries (link_id, id DESC);

-- Уборка по возрасту (30 дней, задача integration-delivery-cleanup): без срока
-- таблица растёт со скоростью потока ответов и не останавливается никогда.
CREATE INDEX idx_integration_deliveries_created ON integration_deliveries (created_at);
