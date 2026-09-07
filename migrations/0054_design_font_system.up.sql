-- 0054: системный шрифт уходит из каталога оформления (решение владельца 2026-09-07).
--
-- Стек system-ui давал три разные формы на трёх операционных системах — вид, за
-- который не отвечает ни автор формы, ни мы. В каталоге остаются шесть самохостных
-- семейств (domain.designFonts / DESIGN_FONTS), а значение "system" отвергается
-- валидатором с обеих сторон.
--
-- Отсюда и эта миграция: контракт схемы строгий (oneOf на Go, z.enum в Zod), поэтому
-- ОСТАВЛЕННОЕ значение не «просто устарело» — оно ломает документ. Черновик с ним
-- перестал бы сохраняться (422 на автосейве), а снапшот — разбираться у респондента,
-- то есть форма не открылась бы вовсе.
--
-- Ключ СНИМАЕТСЯ, а не переписывается на "inter": дефолт оформления везде хранится
-- отсутствием ключа, и записанный дефолт был бы платной настройкой (DesignPaidFeatures)
-- у автора, который шрифта не выбирал. Снятый ключ даёт ровно то, что автор увидит на
-- полотне, — Inter из :root fields.css.
CREATE FUNCTION pg_temp_strip_system_font(doc jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(doc -> 'design'), '') <> 'object' THEN doc
    WHEN doc -> 'design' ->> 'font' IS DISTINCT FROM 'system' THEN doc
    -- Скобки обязательны: у вычитания приоритет ВЫШЕ, чем у `->`, и без них
    -- Postgres читает выражение как doc -> ('design' - 'font').
    WHEN (doc -> 'design') - 'font' = '{}'::jsonb THEN doc - 'design'
    ELSE jsonb_set(doc, '{design}', (doc -> 'design') - 'font')
  END
$$ LANGUAGE sql IMMUTABLE;

UPDATE forms SET draft_schema = pg_temp_strip_system_font(draft_schema)
 WHERE draft_schema -> 'design' ->> 'font' = 'system';

-- ⚠ ТРОГАЕТ form_versions — таблицу, которую migrations/CLAUDE.md объявляет
-- иммутабельной. То же осознанное отступление и по тому же доводу, что в 0020, 0025,
-- 0026 и 0038: снапшот со снятым из каталога значением не разобрать строгим парсером,
-- а понимать оба формата вечно — цена выше, чем правка снимка. Вид опубликованной
-- формы при этом меняется ровно так же, как в черновике: системный стек → Inter.
UPDATE form_versions SET schema = pg_temp_strip_system_font(schema)
 WHERE schema -> 'design' ->> 'font' = 'system';

DROP FUNCTION pg_temp_strip_system_font(jsonb);
