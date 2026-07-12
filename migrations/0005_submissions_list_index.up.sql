-- 0005: индекс под листинг ответов (фаза 6, шаг 1). Приватный GET листает ответы
-- формы курсором по id (UUIDv7 монотонен → «новые сверху» = ORDER BY id DESC), а
-- keyset-условие идёт по паре (form_id, id). Существующий idx_submissions_form —
-- по (form_id, created_at DESC): created_at при пакетной вставке может совпадать
-- у нескольких строк (нестабильный порядок), поэтому курсор и сортировка — по id.
-- Индекс покрывает и фильтр по form_id, и сортировку/keyset по id одной структурой.
CREATE INDEX idx_submissions_form_id ON submissions (form_id, id DESC);
