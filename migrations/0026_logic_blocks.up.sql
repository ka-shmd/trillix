-- 0026: условная логика переезжает из полей-носителей в блок полотна `logic`.
--
-- Правило перестало быть невидимым свойством вопроса: теперь оно стоит на полотне
-- своей строкой — блоком с условием и списком действий (ADR §10, спека
-- docs/design/logic-blocks.md). Четыре поля-носителя (`visibleIf` у блока и у
-- варианта, `requiredIf`, `jumpIf`) из схемы удалены, и документ с ними перестал
-- разбираться вовсе — форма открылась бы в кабинете ошибкой.
--
-- ПРАВИЛА НЕ КОНВЕРТИРУЮТСЯ, А СНОСЯТСЯ (решение владельца 2026-08-16:
-- пользовательских форм нет, данные в БД не жалеем). Конвертер обязан был бы вставлять
-- блок перед каждой группой-целью, соблюдать потолок блоков, разбирать `jumpIf` в
-- список действий и быть идемпотентным — сотни строк одноразового кода ради правил,
-- которых никто не писал. Правило действует, ПОКА ФОРМ НЕТ; появятся пользователи —
-- следующая ломающая правка формата пишет конвертер.
--
-- Формат при этом НЕ версионируется: `schemaVersion` заморожена на единице до релиза
-- (ADR §10), документы чинятся разовой миграцией в том же PR.
--
-- ⚠ ТРОГАЕТ `form_versions` — таблицу, которую migrations/CLAUDE.md объявляет
-- иммутабельной. То же осознанное отступление и по тому же доводу, что в 0020 и 0025:
-- иначе рендерер обязан понимать оба формата вечно. После релиза правило действует без
-- исключений.

-- Вариант теряет своё условие показа.
CREATE FUNCTION pg_temp_strip_option(o jsonb) RETURNS jsonb AS $$
  SELECT o - 'visibleIf'
$$ LANGUAGE sql IMMUTABLE;

-- Блок теряет три своих правила; варианты чистятся заодно, если они есть.
CREATE FUNCTION pg_temp_strip_block(b jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(b -> 'settings' -> 'options'), '') <> 'array'
      THEN b - 'visibleIf' - 'requiredIf' - 'jumpIf'
    ELSE jsonb_set(
      b - 'visibleIf' - 'requiredIf' - 'jumpIf',
      '{settings,options}',
      (
        SELECT coalesce(jsonb_agg(pg_temp_strip_option(o) ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(b -> 'settings' -> 'options') WITH ORDINALITY AS t(o, ord)
      )
    )
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp_strip_schema(doc jsonb) RETURNS jsonb AS $$
  SELECT CASE
    WHEN coalesce(jsonb_typeof(doc -> 'blocks'), '') <> 'array' THEN doc
    ELSE jsonb_set(doc, '{blocks}', (
      SELECT coalesce(jsonb_agg(pg_temp_strip_block(b) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(doc -> 'blocks') WITH ORDINALITY AS t(b, ord)
    ))
  END
$$ LANGUAGE sql IMMUTABLE;

UPDATE forms SET draft_schema = pg_temp_strip_schema(draft_schema);
UPDATE form_versions SET schema = pg_temp_strip_schema(schema);

DROP FUNCTION pg_temp_strip_schema(jsonb);
DROP FUNCTION pg_temp_strip_block(jsonb);
DROP FUNCTION pg_temp_strip_option(jsonb);
