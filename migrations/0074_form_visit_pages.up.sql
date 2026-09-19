-- 0074: путь визита — какие страницы многостраничной формы человек открывал и когда
-- (фаза 30 DEV-PLAN, спека design/analytics-v2.md §4, ADR §10).
--
-- Строка на ОТКРЫТУЮ страницу, а не лог событий: страницу открывает бикон перехода,
-- касания полей сюда не пишутся. Первая страница строки не получает — её открытие
-- это бикон «открыли», то есть form_visits.created_at. У одностраничной формы строк
-- нет вовсе.
--
-- Только вставка: запоминается ПЕРВОЕ открытие страницы (ON CONFLICT DO NOTHING).
-- Строка визита в form_visits по-прежнему одна и обновляется тем же биконом.
CREATE TABLE form_visit_pages (
    visit_id         UUID        NOT NULL REFERENCES form_visits(id) ON DELETE CASCADE,
    -- Первый вопрос открытой страницы — то же, что бикон шлёт в last_block_id.
    -- Страница выводится из него на чтении, по схеме (domain.PageOrder).
    block_id         TEXT        NOT NULL,
    -- Время сервера на приёме бикона: бикон перехода уходит в момент открытия
    -- страницы, клиентскому времени аналитика не верит.
    reached_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Копии из визита: счёт пути за окно наблюдения идёт по этой таблице без похода
    -- в form_visits, а окно режется по НАЧАЛУ визита, как у всей аналитики.
    form_id          UUID        NOT NULL,
    visit_created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (visit_id, block_id)
);

-- Путь визитов формы за окно: группировка по визиту идёт index-only.
CREATE INDEX idx_form_visit_pages_form ON form_visit_pages (form_id, visit_created_at, visit_id, block_id)
    INCLUDE (reached_at);
