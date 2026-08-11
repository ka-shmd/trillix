-- 0020: колонка ряда становится НОМЕРОМ, версия формата замораживается на единице.
--
-- Две связанные правки контракта, сделанные разом (решения владельца 2026-08-10):
--
--   1. `settings.column` у блока и у варианта был строкой "left"/"right" — двух значений
--      хватало ровно на две колонки, и ряд из трёх был невыразим. Стал номером 1..4.
--   2. Цепочка апгрейдов на чтении (v1→v2→v3→v4) удалена вместе с `schema_upgrade.go`:
--      пользователей ещё нет, и сопровождать конвертеры ради данных, которых нет, дороже,
--      чем починить базу разово. Версия заморожена на 1 до релиза.
--
-- Отсюда и эта миграция: читатель больше не приводит формат на лету, значит документы
-- обязаны лежать в БД уже в нём. Без неё каждая существующая форма отвечала бы 422
-- («неизвестная schemaVersion», «не удалось разобрать схему») на первом же чтении.
--
-- ⚠ ТРОГАЕТ `form_versions` — таблицу, которую migrations/CLAUDE.md объявляет
-- иммутабельной. Это осознанное отступление, ограниченное дорелизным контуром: снапшот
-- публикации обязан совпадать с тем, что видел респондент, а респондентов ещё не было.
-- Альтернатива — удалить снапшоты и снять формы с публикации — теряет больше и по той
-- же причине никого не защищает. После релиза правило действует без исключений.
--
-- Документы в формате ДО текущего (schemaVersion 2/3: плоский текст блока, поля
-- label/description вместо блоков-подписей) эта миграция починить не может — их чинила
-- удалённая цепочка. Их число печатается ниже: если оно ненулевое, формы правятся руками
-- или удаляются отдельным решением, молча ломаться они не будут.

-- Номер колонки из прежней строки. Обратное соответствие: "left" — первая колонка,
-- "right" — вторая; всё остальное (в том числе уже число) остаётся как есть.
CREATE FUNCTION pg_temp_column_number(v jsonb) RETURNS jsonb AS $$
  SELECT CASE jsonb_typeof(v)
    WHEN 'string' THEN CASE v #>> '{}' WHEN 'left' THEN '1'::jsonb WHEN 'right' THEN '2'::jsonb ELSE v END
    ELSE v
  END
$$ LANGUAGE sql IMMUTABLE;

-- Блок целиком: свой ключ колонки и ключи колонок у вариантов списка.
CREATE FUNCTION pg_temp_convert_block(b jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN b -> 'settings' IS NULL THEN b
    ELSE jsonb_set(b, '{settings}', (
      SELECT CASE
        WHEN s -> 'column' IS NULL THEN s
        ELSE jsonb_set(s, '{column}', pg_temp_column_number(s -> 'column'))
      END
      FROM (
        SELECT CASE
          WHEN coalesce(jsonb_typeof(b #> '{settings,options}'), '') <> 'array' THEN b -> 'settings'
          ELSE jsonb_set(b -> 'settings', '{options}', (
            SELECT coalesce(jsonb_agg(
              CASE WHEN o -> 'column' IS NULL THEN o
                   ELSE jsonb_set(o, '{column}', pg_temp_column_number(o -> 'column'))
              END ORDER BY ord), '[]'::jsonb)
            FROM jsonb_array_elements(b #> '{settings,options}') WITH ORDINALITY AS t(o, ord)
          ))
        END AS s
      ) AS inner_settings
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

-- Документ схемы: блоки конвертируются, версия проставляется текущая (1).
CREATE FUNCTION pg_temp_convert_schema(doc jsonb) RETURNS jsonb AS $$
  SELECT jsonb_set(
    CASE
      WHEN coalesce(jsonb_typeof(doc -> 'blocks'), '') <> 'array' THEN doc
      ELSE jsonb_set(doc, '{blocks}', (
        SELECT coalesce(jsonb_agg(pg_temp_convert_block(b) ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(doc -> 'blocks') WITH ORDINALITY AS t(b, ord)
      ))
    END,
    '{schemaVersion}', '1'::jsonb
  )
$$ LANGUAGE sql IMMUTABLE;

UPDATE forms SET draft_schema = pg_temp_convert_schema(draft_schema);
UPDATE form_versions SET schema = pg_temp_convert_schema(schema);

-- Документы, которые эта миграция починить не может: они в формате до групп блоков и
-- до спанов текста. Не ошибка миграции — сообщение человеку.
DO $$
DECLARE stale int;
BEGIN
  SELECT count(*) INTO stale FROM (
    SELECT draft_schema AS doc FROM forms
    UNION ALL
    SELECT schema FROM form_versions
  ) AS d
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements(d.doc -> 'blocks') AS b
    WHERE jsonb_typeof(b -> 'blocks') IS NULL
      AND (b ? 'label' OR b ? 'description' OR jsonb_typeof(b -> 'text') = 'string')
  );
  IF stale > 0 THEN
    RAISE WARNING 'документов в формате до текущего: % — читаться они не будут, цепочка апгрейдов удалена', stale;
  END IF;
END $$;

DROP FUNCTION pg_temp_convert_schema(jsonb);
DROP FUNCTION pg_temp_convert_block(jsonb);
DROP FUNCTION pg_temp_column_number(jsonb);
