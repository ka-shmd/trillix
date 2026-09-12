-- 0065: Google Таблицы переезжают с общего outbox на очередь по целям — ту же
-- модель, что 0062 завела вебхукам (docs/BACKLOG.md, ADR §10 строка «Доставка
-- ИНТЕГРАЦИЙ — своя очередь, разобранная по ЦЕЛЯМ»).
--
-- Своя таблица очереди, а не общая с вебхуками: цель у видов разная, и общая
-- осталась бы без внешнего ключа на неё.

-- Расписание переезжает к ЦЕЛИ. В outbox оно жило у СОБЫТИЯ, и лежащий лист
-- получал по запросу на каждый накопленный ответ в час: лежит он для всех
-- ответов разом, и пауза нужна связке.
ALTER TABLE form_integrations
    ADD COLUMN next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN failing_since        TIMESTAMPTZ,   -- первый отказ подряд: по нему считаются сутки до поломки
    ADD COLUMN consecutive_failures INT NOT NULL DEFAULT 0;

-- sheet_queue — «этот ответ ещё не доставлен в эту связку». Доставленная строка
-- удаляется (история — в integration_deliveries), поэтому таблица маленькая.
-- Ключ — пара: двойная постановка (перезалив поверх живых ответов, повтор)
-- безвредна.
CREATE TABLE sheet_queue (
    link_id       UUID NOT NULL REFERENCES form_integrations(id) ON DELETE CASCADE,
    -- Каскад: удалённый ответ везти некуда.
    submission_id UUID NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    -- backfill — строка приехала переносом накопленных, а не приёмом ответа.
    -- На расписание и порядок не влияет вовсе: единственный её потребитель —
    -- журнал, где перенос даёт одну запись на пачку, а живые ответы — запись на
    -- ответ. Без флага лента из двадцати тысяч строк перестала бы читаться ровно
    -- там, где её открывают.
    backfill      BOOLEAN NOT NULL DEFAULT false,
    enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (link_id, submission_id)
);

-- Порядок внутри связки. submission_id вторым ключом не украшение: перенос
-- ставит всю пачку ОДНИМ утверждением, у всех её строк enqueued_at одинаков, и
-- хронологию держит только он (UUIDv7 монотонен по времени). Живые ответы
-- получают now() позже и ложатся в лист после перенесённых.
CREATE INDEX idx_sheet_queue_order ON sheet_queue (link_id, enqueued_at, submission_id);
-- Срок хранения: у сломанной связки ответы копятся до починки, и без уборки
-- очередь росла бы вечно.
CREATE INDEX idx_sheet_queue_age ON sheet_queue (enqueued_at);

-- Статус backfilling больше не нужен: порядок «сначала накопленные, потом
-- живые» держится очередью по построению, а не состоянием связки. Что идёт
-- перенос, экран видит по глубине очереди («в очереди N»).
UPDATE form_integrations SET status = 'live' WHERE status = 'backfilling';
ALTER TABLE form_integrations DROP CONSTRAINT form_integrations_status_check;
ALTER TABLE form_integrations
    ADD CONSTRAINT form_integrations_status_check CHECK (status IN ('live', 'broken'));

-- Отсечка переноса уходит вместе с ним: она страховала от второй записи того же
-- ответа, когда живое событие обгоняло пачку. Обгонять больше нечего.
ALTER TABLE form_integrations DROP COLUMN backfill_before;

-- Неотправленные события канала уносятся, а не переводятся в очередь: боевых
-- данных, которыми дорожат, у продукта сейчас нет (решение владельца
-- 2026-09-12), а перевод пачки переноса по курсору внутри payload — отдельный
-- разбор ради строк, которые никому не нужны. Доставленные строки уносятся
-- заодно: их читает только уборщик outbox, а канала больше нет.
DELETE FROM outbox WHERE channel = 'gsheets';
