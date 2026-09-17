-- 0069: согласие на обработку персональных данных — живая настройка формы с ревизиями
-- (решение владельца 2026-09-16, docs/design/privacy-consent.md §3.1).
--
-- Ревизия — снимок раздела «Персональные данные» на момент сохранения: тумблер,
-- реквизиты оператора, цель, срок и оба документа. Строки только добавляются: по
-- ревизии восстанавливается текст, с которым соглашался человек, а доказать получение
-- согласия обязан оператор (ч. 3 ст. 9 152-ФЗ). Форма ссылается на текущую ревизию,
-- ответ — на ту, при которой принят.
CREATE TABLE form_consent_revisions (
    id         UUID PRIMARY KEY,
    form_id    UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
    -- Тумблер живёт в ревизии, а не колонкой формы: выключение не стирает реквизиты,
    -- и включение обратно возвращает их без повторного ввода.
    enabled    BOOLEAN NOT NULL,
    -- Реквизиты, цель, срок и документы (domain.ConsentSettings). Структуру проверяет
    -- приложение (migrations/CLAUDE.md).
    settings   JSONB NOT NULL,
    -- Версия шаблона типового текста, которой собирались документы ревизии. Правка
    -- формулировок в коде — новая версия, иначе исправление шаблона переписало бы
    -- задним числом текст, с которым соглашались раньше (спека §3.3).
    template   SMALLINT NOT NULL CHECK (template > 0),
    -- Кто сохранил. SET NULL: ревизия — свидетельство для ответов формы и переживает
    -- уход автора из продукта.
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Каскад удаления формы и выборка ревизий формы.
CREATE INDEX idx_form_consent_revisions_form ON form_consent_revisions (form_id);

-- Текущая ревизия. NULL — раздел ни разу не сохраняли, согласие выключено. SET NULL
-- срабатывает только при удалении самой формы (ревизии иначе не удаляются).
ALTER TABLE forms
    ADD COLUMN consent_revision_id UUID REFERENCES form_consent_revisions(id) ON DELETE SET NULL;

-- Ревизия, при которой человек поставил галочку. NULL — согласия при ответе не было.
-- NO ACTION, а не каскад: ревизия удаляется только вместе с формой, а её ответы уходят
-- тем же утверждением, и проверка в конце утверждения их уже не видит.
ALTER TABLE submissions
    ADD COLUMN consent_revision_id UUID REFERENCES form_consent_revisions(id);

-- Без индекса проверка внешнего ключа при удалении каждой ревизии сканировала бы
-- ответы целиком. Частичный: у большинства ответов согласия нет.
CREATE INDEX idx_submissions_consent_revision ON submissions (consent_revision_id)
    WHERE consent_revision_id IS NOT NULL;
