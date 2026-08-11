-- Откат 0020: номер колонки обратно в строку "left"/"right", версия формата обратно в 4.
--
-- Откат ЧАСТИЧНО ЛОССИ, и это свойство прежнего формата, а не небрежность отката: строк
-- у ключа было две, поэтому третья и четвёртая колонки в нём непредставимы. Их ключи
-- СНИМАЮТСЯ — элемент возвращается во всю ширину, то есть в единственное состояние,
-- которое старый раскладчик умел прочитать. Ряды из двух колонок откатываются точно.

CREATE FUNCTION pg_temp_column_side(v jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN jsonb_typeof(v) <> 'number' THEN v
    WHEN v::text = '1' THEN '"left"'::jsonb
    WHEN v::text = '2' THEN '"right"'::jsonb
    ELSE NULL
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp_revert_block(b jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN b -> 'settings' IS NULL THEN b
    ELSE jsonb_set(b, '{settings}', (
      SELECT CASE
        WHEN s -> 'column' IS NULL THEN s
        WHEN pg_temp_column_side(s -> 'column') IS NULL THEN s - 'column'
        ELSE jsonb_set(s, '{column}', pg_temp_column_side(s -> 'column'))
      END
      FROM (
        SELECT CASE
          WHEN coalesce(jsonb_typeof(b #> '{settings,options}'), '') <> 'array' THEN b -> 'settings'
          ELSE jsonb_set(b -> 'settings', '{options}', (
            SELECT coalesce(jsonb_agg(
              CASE WHEN o -> 'column' IS NULL THEN o
                   WHEN pg_temp_column_side(o -> 'column') IS NULL THEN o - 'column'
                   ELSE jsonb_set(o, '{column}', pg_temp_column_side(o -> 'column'))
              END ORDER BY ord), '[]'::jsonb)
            FROM jsonb_array_elements(b #> '{settings,options}') WITH ORDINALITY AS t(o, ord)
          ))
        END AS s
      ) AS inner_settings
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp_revert_schema(doc jsonb) RETURNS jsonb AS $$
  SELECT jsonb_set(
    CASE
      WHEN coalesce(jsonb_typeof(doc -> 'blocks'), '') <> 'array' THEN doc
      ELSE jsonb_set(doc, '{blocks}', (
        SELECT coalesce(jsonb_agg(pg_temp_revert_block(b) ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(doc -> 'blocks') WITH ORDINALITY AS t(b, ord)
      ))
    END,
    '{schemaVersion}', '4'::jsonb
  )
$$ LANGUAGE sql IMMUTABLE;

UPDATE forms SET draft_schema = pg_temp_revert_schema(draft_schema);
UPDATE form_versions SET schema = pg_temp_revert_schema(schema);

DROP FUNCTION pg_temp_revert_schema(jsonb);
DROP FUNCTION pg_temp_revert_block(jsonb);
DROP FUNCTION pg_temp_column_side(jsonb);
