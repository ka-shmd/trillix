-- 0068: тип блока `consent` («Согласие») перестаёт существовать.
--
-- Согласие на обработку персональных данных становится настройкой формы под кнопкой
-- отправки (решение владельца 2026-09-16, docs/design/privacy-consent.md). Контракт схемы
-- строгий с обеих сторон, поэтому оставленный блок не дал бы разобрать ни черновик, ни
-- снапшот: публичная форма с ним отдавала бы 500.
--
-- Блок удаляется целиком. Ссылки на него — условия логики и подстановки в тексте —
-- становятся инертными, а не невалидными (правило инертной ссылки), поэтому документ
-- остаётся валидным без их чистки. Подпись, стоявшая в группе согласия, остаётся текстом.
--
-- ⚠ ТРОГАЕТ form_versions — таблицу, которую migrations/CLAUDE.md объявляет
-- иммутабельной. То же осознанное отступление и по тому же доводу, что в 0020, 0025,
-- 0026 и 0038: иначе публичная отдача обязана понимать удалённый тип вечно. Ценных
-- данных нет (решение владельца 2026-09-15). После релиза правило действует без
-- исключений.
CREATE FUNCTION pg_temp_drop_consent(doc jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(doc -> 'blocks'), '') <> 'array' THEN doc
    ELSE jsonb_set(doc, '{blocks}', (
      SELECT coalesce(jsonb_agg(b ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(doc -> 'blocks') WITH ORDINALITY AS t(b, ord)
      WHERE coalesce(b ->> 'type', '') <> 'consent'
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

UPDATE forms SET draft_schema = pg_temp_drop_consent(draft_schema)
 WHERE draft_schema -> 'blocks' @> '[{"type":"consent"}]';

UPDATE form_versions SET schema = pg_temp_drop_consent(schema)
 WHERE schema -> 'blocks' @> '[{"type":"consent"}]';

UPDATE form_templates SET schema = pg_temp_drop_consent(schema)
 WHERE schema -> 'blocks' @> '[{"type":"consent"}]';

DROP FUNCTION pg_temp_drop_consent(jsonb);
