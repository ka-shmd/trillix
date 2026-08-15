-- Откат 0025: марка `b` снимается с заголовков и подписей — вес им снова даёт
-- поверхность (fields.css вернувшейся версии).
--
-- Откат ЛОССИ, и это свойство прежней модели, а не небрежность отката: до 0025 жирность
-- заголовка в данных не жила вовсе, поэтому отличить досеянную марку от той, которую
-- автор поставил сам, нечем. Снимаются обе — то есть возвращается ровно то состояние,
-- которое старый вид умел показать.

CREATE FUNCTION pg_temp_unbold_span(s jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(s -> 'm'), '') <> 'array' THEN s
    ELSE (
      -- Опустевший список марок УДАЛЯЕТСЯ, а не остаётся пустым массивом: `m` —
      -- необязательное поле, и пустой список означал бы «марки есть, их ноль».
      SELECT CASE WHEN rest = '[]'::jsonb THEN s - 'm' ELSE jsonb_set(s, '{m}', rest) END
      FROM (
        SELECT coalesce(jsonb_agg(v ORDER BY ord), '[]'::jsonb) AS rest
        FROM jsonb_array_elements(s -> 'm') WITH ORDINALITY AS t(v, ord)
        WHERE v <> '"b"'::jsonb
      ) AS kept
    )
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp_unbold_block(b jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(b ->> 'type', '') NOT IN ('form_title', 'title', 'label', 'heading') THEN b
    WHEN coalesce(jsonb_typeof(b -> 'text'), '') <> 'array' THEN b
    ELSE jsonb_set(b, '{text}', (
      SELECT coalesce(jsonb_agg(pg_temp_unbold_span(s) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(b -> 'text') WITH ORDINALITY AS t(s, ord)
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp_unbold_schema(doc jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(doc -> 'blocks'), '') <> 'array' THEN doc
    ELSE jsonb_set(doc, '{blocks}', (
      SELECT coalesce(jsonb_agg(pg_temp_unbold_block(b) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(doc -> 'blocks') WITH ORDINALITY AS t(b, ord)
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

UPDATE forms SET draft_schema = pg_temp_unbold_schema(draft_schema);
UPDATE form_versions SET schema = pg_temp_unbold_schema(schema);

DROP FUNCTION pg_temp_unbold_schema(jsonb);
DROP FUNCTION pg_temp_unbold_block(jsonb);
DROP FUNCTION pg_temp_unbold_span(jsonb);
