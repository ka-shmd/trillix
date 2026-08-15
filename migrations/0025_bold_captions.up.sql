-- 0025: жирность заголовков и подписей переезжает В ДОКУМЕНТ, маркой `b`.
--
-- До этой правки вес держала поверхность (`.rf-title` 800, `.rf-label` 600,
-- `.rf-heading` 700 в fields.css), а марка `b` ложилась ПОВЕРХ — и «жирный» из панели
-- делал подпись жирнее, заголовок раздела не менял вовсе, а заголовок формы делал легче.
-- Снять жирность было нечем: в данных её не было. Теперь вес у этих поверхностей
-- обычный, жирность лежит в тексте маркой, и кнопка панели честно её показывает и
-- снимает (решение владельца 2026-08-15).
--
-- Отсюда эта миграция: у существующих документов марки нет, и без досева каждая уже
-- собранная форма открылась бы обычным текстом там, где всегда был жирный. Формат при
-- этом НЕ меняется — марка `b` существует с фазы 14, `schemaVersion` остаётся 1.
--
-- ⚠ ТРОГАЕТ `form_versions` — таблицу, которую migrations/CLAUDE.md объявляет
-- иммутабельной. То же осознанное отступление и по тому же доводу, что в 0020: снапшот
-- обязан совпадать с тем, что видел респондент, а до релиза респондентов не было.
-- Альтернатива — оставить опубликованные формы с обычным весом заголовков — меняет их
-- вид сильнее, чем эта правка. После релиза правило действует без исключений.

-- Спан получает `b`, если её ещё нет. Кусок с другими марками их сохраняет.
CREATE FUNCTION pg_temp_bold_span(s jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(s -> 'm'), '') <> 'array' THEN jsonb_set(s, '{m}', '["b"]'::jsonb, true)
    WHEN s -> 'm' @> '["b"]'::jsonb THEN s
    ELSE jsonb_set(s, '{m}', (s -> 'm') || '"b"'::jsonb)
  END
$$ LANGUAGE sql IMMUTABLE;

-- Блоки, набранные жирным: заголовок формы, подпись вопроса, малая подпись, заголовок
-- раздела. Абзац и текст согласия сюда не входят — они и были обычного веса.
CREATE FUNCTION pg_temp_bold_block(b jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(b ->> 'type', '') NOT IN ('form_title', 'title', 'label', 'heading') THEN b
    WHEN coalesce(jsonb_typeof(b -> 'text'), '') <> 'array' THEN b
    ELSE jsonb_set(b, '{text}', (
      SELECT coalesce(jsonb_agg(pg_temp_bold_span(s) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(b -> 'text') WITH ORDINALITY AS t(s, ord)
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp_bold_schema(doc jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(doc -> 'blocks'), '') <> 'array' THEN doc
    ELSE jsonb_set(doc, '{blocks}', (
      SELECT coalesce(jsonb_agg(pg_temp_bold_block(b) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(doc -> 'blocks') WITH ORDINALITY AS t(b, ord)
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

UPDATE forms SET draft_schema = pg_temp_bold_schema(draft_schema);
UPDATE form_versions SET schema = pg_temp_bold_schema(schema);

DROP FUNCTION pg_temp_bold_schema(jsonb);
DROP FUNCTION pg_temp_bold_block(jsonb);
DROP FUNCTION pg_temp_bold_span(jsonb);
