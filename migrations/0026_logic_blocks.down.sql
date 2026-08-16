-- Откат 0026: вернуть нечего.
--
-- Правила были СНЕСЕНЫ, а не переложены (см. up), поэтому восстанавливать их не из
-- чего: в документе не осталось ни условия, ни цели. Откат честно ничего не делает —
-- это лучше, чем сочинить правила, которых автор не писал.
--
-- Что откат ОБЯЗАН сделать, чтобы код прошлой версии не упал: убрать блоки `logic`.
-- Прежняя схема такого типа не знает и отвергает документ целиком (z.enum и
-- blockTypes), то есть форма с блоком условия не открылась бы ни в кабинете, ни у
-- респондента.

CREATE FUNCTION pg_temp_drop_logic(doc jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(doc -> 'blocks'), '') <> 'array' THEN doc
    ELSE jsonb_set(doc, '{blocks}', (
      SELECT coalesce(jsonb_agg(b ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(doc -> 'blocks') WITH ORDINALITY AS t(b, ord)
      WHERE coalesce(b ->> 'type', '') <> 'logic'
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

UPDATE forms SET draft_schema = pg_temp_drop_logic(draft_schema);
UPDATE form_versions SET schema = pg_temp_drop_logic(schema);

DROP FUNCTION pg_temp_drop_logic(jsonb);
