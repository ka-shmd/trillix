-- Запросы модуля visits. Схема — migrations/0008_form_visits. Генерация:
-- `make sqlc` (общий пакет internal/postgres).

-- name: UpsertFormVisit :exec
-- Запись визита биконом рендерера. id генерирует клиент (UUIDv7), поэтому второй
-- бикон того же визита упирается в PK и становится UPDATE'ом.
--
-- Обновляются РОВНО три поля (updated_at приехал с 0030 — это вторая граница
-- длительности визита; первая — created_at). Не обновляются намеренно:
--   submitted       — его ставит только приём ответа; иначе поздний бикон затирал бы
--                     уже засчитанную конверсию обратно в false;
--   form_version_id — визит принадлежит той версии, на которой открыт; переиздание
--                     формы посреди сессии не должно переклеивать его на новую;
--   meta, created_at — контекст первого касания, а не последнего.
--
-- Два условия в WHERE — не перестраховка, каждое закрывает свой сценарий:
--   form_id — id визита выбирает клиент, а UUIDv7 угадываем по временно́му префиксу:
--             без этого условия ручкой одной формы правится строка другой;
--   seq     — sendBeacon не гарантирует порядок доставки, а visibilitychange шлёт
--             бикон на каждое переключение вкладки, поэтому «поздний» ранний бикон
--             без этого условия отбрасывал бы визит назад по воронке.
--
-- Гео (country_code/country/city) пишется только этой вставкой и в UPDATE не
-- входит: место определяется по IP ПЕРВОГО бикона, у последующих адрес тот же,
-- зато лишний поиск по справочнику на каждый бикон — нет.
-- Ключ посетителя — там же и по той же причине: он считается от адреса ПЕРВОГО
-- бикона и от даты, и пересчитывать его на каждом биконе незачем.
INSERT INTO form_visits (id, form_id, form_version_id, last_block_id, seq, meta,
                         country_code, country, city, visitor_key)
VALUES ($1, $2, $3, $4, $5, $6, sqlc.narg(country_code), sqlc.narg(country), sqlc.narg(city),
        sqlc.narg(visitor_key))
ON CONFLICT (id) DO UPDATE
SET last_block_id = EXCLUDED.last_block_id,
    seq           = EXCLUDED.seq,
    updated_at    = now()
WHERE form_visits.form_id = EXCLUDED.form_id
  AND form_visits.seq < EXCLUDED.seq;

-- name: InsertVisitPage :exec
-- Строка пути визита: бикон перехода открыл страницу (миграция 0074). Только
-- вставка — запоминается ПЕРВОЕ открытие страницы; время ставит сервер.
--
-- Вставка идёт ВЫБОРКОЙ из form_visits по id и form_id, а не значениями: id визита
-- выбирает клиент, и путь визита чужой формы иначе дописывался бы ручкой своей.
-- Нет строки визита (апсерт не прошёл) — нет и строки пути.
--
-- Потолок строк на визит: ручка публична на запись, и неизвестные block_id на
-- чтении отбрасываются, но копиться бесконечно им нельзя.
INSERT INTO form_visit_pages (visit_id, block_id, form_id, visit_created_at)
SELECT v.id, sqlc.arg(block_id)::text, v.form_id, v.created_at
FROM form_visits v
WHERE v.id = sqlc.arg(visit_id)
  AND v.form_id = sqlc.arg(form_id)
  AND (SELECT count(*) FROM form_visit_pages p WHERE p.visit_id = v.id) < sqlc.arg(max_pages)::int
ON CONFLICT (visit_id, block_id) DO NOTHING;

-- name: MarkVisitSubmitted :execrows
-- Отметка конверсии при приёме ответа. Ограничено form_id: визит чужой формы по
-- угаданному id не пометить. 0 строк — не ошибка: визита нет (бикон потерялся,
-- страница из кэша старой версии, подделанный visit_id) → ответ всё равно принят,
-- аналитика не имеет права его отклонить.
UPDATE form_visits SET submitted = true
WHERE id = $1 AND form_id = $2;

-- name: CountVisitsByLastBlock :many
-- Раскладка визитов по самой дальней точке — сырьё воронки (фаза 8.5 шаг 6б).
--
-- Здесь агрегация в SQL — и это НЕ противоречит решению шага 3 («сводку считает Go,
-- а не SQL»), а его обратная сторона. Там на SQL пришлось бы переписать семантику
-- ответа (что значит «yes», что значит массив опций) — третью копию правил после Go
-- и Zod. Здесь семантики нет вообще: это подсчёт строк по одной колонке, а результат
-- размером в число вопросов, а не в число визитов. Порядок и подписи шагов всё равно
-- достраивает Go по модели вопросов (domain.QuestionOrder).
--
-- NULL last_block_id — законная строка: «открыл и ушёл, не тронув ни одного вопроса».
-- Она не отбрасывается, а становится верхом воронки, поэтому GROUP BY, а не WHERE.
--
-- Группируем ТАКЖЕ по submitted, и это несущая деталь, а не лишнее измерение:
-- отправивший форму тоже имеет last_block_id — того поля, которого коснулся
-- последним. Без разделения все дошедшие до конца попали бы в «отвалились на
-- последнем вопросе», и воронка обвиняла бы вопрос, который на самом деле работает.
-- «Дошёл до вопроса» считается по всем визитам, «отвалился здесь» — только по
-- неотправившим.
-- Границы периода приходят всегда: «всё время» — это ±бесконечность, а не
-- отсутствующее условие. Одна форма запроса вместо двух означает один план и одну
-- ветку кода; бесконечность индексу не мешает (та же диапазонная проверка).
--
-- Разрез (seg_kinds/seg_keys, спека design/analytics-v2.md §5.4, analytics-v3.md
-- §11.6): визиты режутся по СЫРОМУ значению — строке user-agent, тройке меток,
-- стране, городу или версии, — список подходящих значений собирает Go
-- (domain.VisitFilter). Ключ зеркалит domain.SourceKey и domain.CityKey,
-- разделитель частей ключа — chr(31).
--
-- УСЛОВИЙ НЕСКОЛЬКО, и они через «И»: seg_kinds — вид сырого значения у каждого
-- условия, seg_keys — подходящие значения ВСЕХ условий одним массивом, где у
-- каждого ключа спереди НОМЕР СВОЕГО УСЛОВИЯ и chr(30). Номер, а не вид: условия
-- «устройство» и «браузер» оба читают user-agent, и по общему виду их списки
-- слились бы в один — «И» превратилось бы в «ИЛИ». NOT EXISTS читается как «ни
-- одно условие не нарушено».
--
-- Внешнее «seg_kinds IS NULL OR» — не перестраховка: при NULL план сворачивает
-- условие целиком, подзапрос не читает meta, и запрос остаётся index-only. Без
-- него разреза нет, а чтение строки есть.
SELECT last_block_id, submitted, count(*) AS visits
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
  AND (sqlc.narg(seg_kinds)::text[] IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(sqlc.narg(seg_kinds)::text[]) WITH ORDINALITY AS seg(kind, n)
        WHERE (seg.n::text || chr(30) ||
         (CASE seg.kind
            WHEN 'ua'      THEN coalesce(meta->>'user_agent', '')
            WHEN 'source'  THEN coalesce(meta->>'referer', '') || chr(31) || coalesce(meta->>'utm_source', '') || chr(31) || coalesce(meta->>'utm_medium', '')
            WHEN 'country' THEN coalesce(country_code, '')
            WHEN 'city'    THEN coalesce(city, '') || chr(31) || coalesce(country_code, '')
            WHEN 'version' THEN form_version_id::text
        END)) <> ALL(sqlc.narg(seg_keys)::text[])))
GROUP BY last_block_id, submitted;

-- name: CountVisitPaths :many
-- Визиты С ПУТЁМ, сгруппированные по дальней точке, исходу и набору открытых
-- страниц (спека design/analytics-v2.md §4.4). Набор — отсортированный массив
-- block_id; различных наборов у формы столько, сколько в ней веток, поэтому
-- результат размером в «вопросы × исход × ветки», а не в число визитов.
--
-- Визиты без пути (одностраничная форма, дальше первой страницы не ушли, собраны
-- до 0074) сюда не попадают: Go получает их вычитанием из CountVisitsByLastBlock.
-- Путь группируется по своему индексу; в form_visits идём только за визитами,
-- у которых путь есть.
SELECT v.last_block_id, v.submitted, p.blocks::text[] AS blocks, count(*)::bigint AS visits
FROM (
    SELECT fp.visit_id, array_agg(fp.block_id ORDER BY fp.block_id) AS blocks
    FROM form_visit_pages fp
    WHERE fp.form_id = $1
      AND fp.visit_created_at >= sqlc.arg(from_ts)::timestamptz
      AND fp.visit_created_at <  sqlc.arg(to_ts)::timestamptz
    GROUP BY fp.visit_id
) p
JOIN form_visits v ON v.id = p.visit_id
WHERE true
  AND (sqlc.narg(seg_kinds)::text[] IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(sqlc.narg(seg_kinds)::text[]) WITH ORDINALITY AS seg(kind, n)
        WHERE (seg.n::text || chr(30) ||
         (CASE seg.kind
            WHEN 'ua'      THEN coalesce(v.meta->>'user_agent', '')
            WHEN 'source'  THEN coalesce(v.meta->>'referer', '') || chr(31) || coalesce(v.meta->>'utm_source', '') || chr(31) || coalesce(v.meta->>'utm_medium', '')
            WHEN 'country' THEN coalesce(v.country_code, '')
            WHEN 'city'    THEN coalesce(v.city, '') || chr(31) || coalesce(v.country_code, '')
            WHEN 'version' THEN v.form_version_id::text
        END)) <> ALL(sqlc.narg(seg_keys)::text[])))
GROUP BY v.last_block_id, v.submitted, p.blocks;

-- name: VisitPageDurations :many
-- Сколько проводят на страницах: гистограмма по целым секундам, медиану по ней
-- считает Go, потому что страницу из block_id выводит только он (у страницы в
-- разных версиях может быть разный первый вопрос — медианы по block_id не
-- складываются, гистограммы складываются).
--
-- page_block — первый вопрос страницы из пути; пустой — первая страница документа
-- (её открытие — created_at визита, строки пути у неё нет).
-- left_here — «ушли с этой страницы»: от её открытия до последнего бикона визита,
-- только у неотправивших. Последняя страница отправившего не входит никуда — её
-- конец не наблюдается (бикон ухода приходит уже со страницы «Спасибо»).
-- last_block — только у ушедших с первой страницы без пути: визит без пути мог быть
-- собран до 0074 на дальней странице, и отличить его Go может лишь по дальней точке.
--
-- Нулевые и отрицательные отрезки отброшены: это «доехал один бикон», а не
-- «ноль секунд» — то же правило, что у медианы длительности визита. Верх — час:
-- забытая вкладка медиану не двигает, а гистограмма остаётся короткой.
WITH path AS (
    -- Визит соединяется один раз, здесь, а не в каждой ветке ниже: иначе две ветки
    -- ходили бы в form_visits точечным чтением на каждую строку пути.
    SELECT p.visit_id, p.block_id, p.reached_at,
           v.created_at, v.updated_at, v.submitted,
           lead(p.reached_at) OVER w AS next_at,
           row_number() OVER w       AS n
    FROM form_visit_pages p
    JOIN form_visits v ON v.id = p.visit_id
    WHERE p.form_id = $1
      AND p.visit_created_at >= sqlc.arg(from_ts)::timestamptz
      AND p.visit_created_at <  sqlc.arg(to_ts)::timestamptz
      AND (sqlc.narg(seg_kinds)::text[] IS NULL OR NOT EXISTS (
            SELECT 1 FROM unnest(sqlc.narg(seg_kinds)::text[]) WITH ORDINALITY AS seg(kind, n)
            WHERE (seg.n::text || chr(30) ||
             (CASE seg.kind
                  WHEN 'ua'      THEN coalesce(v.meta->>'user_agent', '')
                  WHEN 'source'  THEN coalesce(v.meta->>'referer', '') || chr(31) || coalesce(v.meta->>'utm_source', '') || chr(31) || coalesce(v.meta->>'utm_medium', '')
                  WHEN 'country' THEN coalesce(v.country_code, '')
                  WHEN 'city'    THEN coalesce(v.city, '') || chr(31) || coalesce(v.country_code, '')
                  WHEN 'version' THEN v.form_version_id::text
              END)) <> ALL(sqlc.narg(seg_keys)::text[])))
    WINDOW w AS (PARTITION BY p.visit_id ORDER BY p.reached_at, p.block_id)
),
spans AS (
    SELECT path.block_id AS page_block, ''::text AS last_block, false AS left_here,
           path.next_at - path.reached_at AS span
    FROM path
    WHERE path.next_at IS NOT NULL
    UNION ALL
    SELECT '', '', false, path.reached_at - path.created_at
    FROM path
    WHERE path.n = 1
    UNION ALL
    SELECT path.block_id, '', true, path.updated_at - path.reached_at
    FROM path
    WHERE path.next_at IS NULL AND NOT path.submitted
    UNION ALL
    SELECT '', v.last_block_id, true, v.updated_at - v.created_at
    FROM form_visits v
    WHERE v.form_id = $1
      AND v.created_at >= sqlc.arg(from_ts)::timestamptz
      AND v.created_at <  sqlc.arg(to_ts)::timestamptz
      AND NOT v.submitted
      AND v.last_block_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM form_visit_pages x WHERE x.visit_id = v.id)
  AND (sqlc.narg(seg_kinds)::text[] IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(sqlc.narg(seg_kinds)::text[]) WITH ORDINALITY AS seg(kind, n)
        WHERE (seg.n::text || chr(30) ||
         (CASE seg.kind
              WHEN 'ua'      THEN coalesce(v.meta->>'user_agent', '')
              WHEN 'source'  THEN coalesce(v.meta->>'referer', '') || chr(31) || coalesce(v.meta->>'utm_source', '') || chr(31) || coalesce(v.meta->>'utm_medium', '')
              WHEN 'country' THEN coalesce(v.country_code, '')
              WHEN 'city'    THEN coalesce(v.city, '') || chr(31) || coalesce(v.country_code, '')
              WHEN 'version' THEN v.form_version_id::text
          END)) <> ALL(sqlc.narg(seg_keys)::text[])))
)
SELECT page_block::text AS page_block,
       last_block::text AS last_block,
       left_here::boolean AS left_here,
       least(round(extract(epoch FROM span)), 3600)::int AS sec,
       count(*)::bigint AS visits
FROM spans
WHERE span > interval '0'
GROUP BY 1, 2, 3, 4;

-- name: VisitInsights :one
-- Карточки над вкладками Insights в части визитов: сколько пришло, сколько из них
-- отправило, и медианная длительность визита (спека design/analytics-tally.md §5).
--
-- МЕДИАНА, а не среднее: вкладка, забытая открытой на сутки, сдвигает среднее на
-- порядок и делает карточку бесполезной ровно в тот день, когда такой посетитель
-- случился. Медиана переживает это без единой строки кода.
--
-- FILTER (WHERE updated_at > created_at) отбрасывает визиты, от которых доехал
-- ровно один бикон: у них updated_at = created_at, то есть «ноль секунд», и без
-- фильтра потерянный pagehide занижал бы медиану тем сильнее, чем хуже связь у
-- респондентов. Их число отдаётся отдельной колонкой (timed_visits): по ней экран
-- отличает «данных нет» от «ноль секунд» — первое рисуется прочерком.
--
-- unique_visitors — count(DISTINCT visitor_key). NULL-ключи (нет адреса, нет
-- секрета) count(DISTINCT ...) не считает вовсе — это ровно то поведение, которое
-- нужно: визит без ключа не человек и не «ещё один человек».
--
-- Ключ СУТОЧНЫЙ, поэтому за период длиннее суток число завышено: один человек,
-- заходивший три дня подряд, даёт три ключа. Граница записана в ANALYTICS.md §6 —
-- на экран она не выносится.
--
-- completion_duration_sec — та же медиана, но только по визитам, ЗАКОНЧИВШИМСЯ
-- ответом: это «сколько занимает заполнить форму», и оно всегда больше общей
-- длительности визита, в которую входят те, кто ушёл через три секунды. Считается
-- тем же сканом — отдельный запрос был бы лишним походом за числом из той же
-- выборки.
--
-- Число ответов формы за период сюда НЕ приезжает: submissions — чужой модуль и
-- второе независимое множество (ANALYTICS.md §1). Его считает свой эндпоинт.
--
-- Колонки *_prev — прошлое окно той же длины (сравнение на карточках, спека
-- design/analytics-v2.md §8), тем же сканом: выборка начинается с prev_from, окна
-- разводит FILTER. Без сравнения prev_from = from_ts, и *_prev нулевые.
-- started — начали отвечать: тронули вопрос или отправили (верх воронки без
-- ушедших сразу), нужен прошлому окну карточек «Отвалов».
SELECT
       count(*) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz)::bigint AS visits,
       count(*) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz AND submitted)::bigint AS submitted,
       count(*) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz AND (last_block_id IS NOT NULL OR submitted))::bigint AS started,
       count(DISTINCT visitor_key) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz)::bigint AS unique_visitors,
       count(*) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz AND updated_at > created_at)::bigint AS timed_visits,
       coalesce(
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM updated_at - created_at)
           ) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz AND updated_at > created_at),
       0)::float8 AS median_duration_sec,
       count(*) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz AND submitted AND updated_at > created_at)::bigint AS timed_completions,
       coalesce(
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM updated_at - created_at)
           ) FILTER (WHERE created_at >= sqlc.arg(from_ts)::timestamptz AND submitted AND updated_at > created_at),
       0)::float8 AS completion_duration_sec,
       count(*) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz)::bigint AS visits_prev,
       count(*) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz AND submitted)::bigint AS submitted_prev,
       count(*) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz AND (last_block_id IS NOT NULL OR submitted))::bigint AS started_prev,
       count(DISTINCT visitor_key) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz)::bigint AS unique_visitors_prev,
       count(*) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz AND updated_at > created_at)::bigint AS timed_visits_prev,
       coalesce(
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM updated_at - created_at)
           ) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz AND updated_at > created_at),
       0)::float8 AS median_duration_sec_prev,
       count(*) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz AND submitted AND updated_at > created_at)::bigint AS timed_completions_prev,
       coalesce(
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM updated_at - created_at)
           ) FILTER (WHERE created_at <  sqlc.arg(from_ts)::timestamptz AND submitted AND updated_at > created_at),
       0)::float8 AS completion_duration_sec_prev
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(prev_from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
  AND (sqlc.narg(seg_kinds)::text[] IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(sqlc.narg(seg_kinds)::text[]) WITH ORDINALITY AS seg(kind, n)
        WHERE (seg.n::text || chr(30) ||
         (CASE seg.kind
            WHEN 'ua'      THEN coalesce(meta->>'user_agent', '')
            WHEN 'source'  THEN coalesce(meta->>'referer', '') || chr(31) || coalesce(meta->>'utm_source', '') || chr(31) || coalesce(meta->>'utm_medium', '')
            WHEN 'country' THEN coalesce(country_code, '')
            WHEN 'city'    THEN coalesce(city, '') || chr(31) || coalesce(country_code, '')
            WHEN 'version' THEN form_version_id::text
        END)) <> ALL(sqlc.narg(seg_keys)::text[])));

-- name: VisitVersionStats :many
-- Разрез по версиям формы (спека design/analytics-v2.md §5.3): визиты, отправившие
-- и медиана длительности ЗАВЕРШЁННОГО заполнения у каждой версии за окно. Помогла ли
-- правка — видно здесь: версия, на которой человек открыл форму, у визита своя.
-- Сегмент — тем же условием, что у воронки.
SELECT form_version_id,
       count(*)::bigint                        AS visits,
       count(*) FILTER (WHERE submitted)::bigint AS submitted,
       count(*) FILTER (WHERE submitted AND updated_at > created_at)::bigint AS timed_completions,
       coalesce(
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM updated_at - created_at)
           ) FILTER (WHERE submitted AND updated_at > created_at),
       0)::float8                              AS completion_duration_sec
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
  AND (sqlc.narg(seg_kinds)::text[] IS NULL OR NOT EXISTS (
        SELECT 1 FROM unnest(sqlc.narg(seg_kinds)::text[]) WITH ORDINALITY AS seg(kind, n)
        WHERE (seg.n::text || chr(30) ||
         (CASE seg.kind
            WHEN 'ua'      THEN coalesce(meta->>'user_agent', '')
            WHEN 'source'  THEN coalesce(meta->>'referer', '') || chr(31) || coalesce(meta->>'utm_source', '') || chr(31) || coalesce(meta->>'utm_medium', '')
            WHEN 'country' THEN coalesce(country_code, '')
            WHEN 'city'    THEN coalesce(city, '') || chr(31) || coalesce(country_code, '')
            WHEN 'version' THEN form_version_id::text
        END)) <> ALL(sqlc.narg(seg_keys)::text[])))
GROUP BY form_version_id;

-- name: VisitTimeseries :many
-- Ряд визитов по времени для вкладки «Визиты» (спека design/analytics-tally.md §8).
-- Шаг корзины приходит параметром и уезжает прямо в date_trunc: выбор шага —
-- решение сервера (domain.StepFor), потому что от него зависят и запрос, и подписи
-- оси, а две копии этого выбора разъезжаются молча.
--
-- Отдаются ТОЛЬКО непустые корзины: дыры достраивает Go (domain.FillBuckets).
-- Генерировать пустые в SQL значило бы завести здесь generate_series по границам
-- периода — то есть вторую копию правила «что такое период».
SELECT date_trunc(sqlc.arg(step)::text, created_at)::timestamptz AS bucket,
       count(*)::bigint                                          AS visits,
       count(*) FILTER (WHERE submitted)::bigint                 AS submitted
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
GROUP BY bucket
ORDER BY bucket;

-- name: VisitSources :many
-- Сырьё списка источников: тройка меток и счётчик.
--
-- submitted у этого и соседних разбивок — агрегат, а не измерение группировки:
-- конверсия строки (спека design/analytics-v2.md §5.2) не увеличивает ни результат,
-- ни скан. Семантику («utm_source
-- перебивает хост referer'а», «ни того ни другого — прямой заход») знает Go
-- (domain.FoldSources) — здесь только группировка.
--
-- Различных троек у формы десятки, а не по одной на визит: разбирать их на чтении
-- дёшево, а хранить разобранное колонкой значило бы, что улучшенное правило чинит
-- только будущие визиты.
SELECT coalesce(meta->>'referer', '')::text    AS referer,
       coalesce(meta->>'utm_source', '')::text AS utm_source,
       coalesce(meta->>'utm_medium', '')::text AS utm_medium,
       count(*)::bigint                        AS visits,
       count(*) FILTER (WHERE submitted)::bigint AS submitted
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
GROUP BY 1, 2, 3;

-- name: VisitUserAgents :many
-- Сырьё списков «устройства / браузеры / ОС»: сгруппированные строки user-agent.
-- Разбор — в Go (domain.ParseUserAgent): здесь нет и не должно быть знания о том,
-- что Edge представляется Chrome'ом.
SELECT coalesce(meta->>'user_agent', '')::text AS user_agent,
       count(*)::bigint                        AS visits,
       count(*) FILTER (WHERE submitted)::bigint AS submitted
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
GROUP BY 1;

-- name: VisitCountries :many
-- Страны за период. Визиты без гео (справочника нет, приватный адрес, IPv6) сюда не
-- попадают: их число считается отдельно, из общего числа визитов, — иначе строка
-- «Не определено» конкурировала бы со странами в одном списке и притворялась местом.
SELECT country_code, coalesce(country, '')::text AS country, count(*)::bigint AS visits,
       count(*) FILTER (WHERE submitted)::bigint AS submitted
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
  AND country_code IS NOT NULL
GROUP BY country_code, country
ORDER BY visits DESC, country;

-- name: VisitCities :many
-- Города за период. Код страны едет рядом с именем: одноимённые города в разных
-- странах — обычное дело, и склеивать их в одну строку значило бы врать.
SELECT city, country_code, count(*)::bigint AS visits,
       count(*) FILTER (WHERE submitted)::bigint AS submitted
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
  AND city IS NOT NULL AND city <> ''
GROUP BY city, country_code
ORDER BY visits DESC, city;

-- name: ConversionWindows :many
-- Суточная проверка падения конверсии (спека design/analytics-v2.md §9): у каждой
-- формы с визитами за последние 35 суток — визиты и отправившие за неделю и за 28
-- суток до неё. Один групповой запрос на все формы, а не запрос на форму.
--
-- Статус формы едет наружу: у снятой с публикации повод гаснет, а не
-- проверяется. Название — внутреннее имя, иначе заголовок: так форму зовёт кабинет.
SELECT v.form_id,
       f.workspace_id,
       f.slug,
       f.status,
       coalesce(nullif(f.name, ''), f.title, '')::text AS form_name,
       count(*) FILTER (WHERE v.created_at >= sqlc.arg(recent_from)::timestamptz)::bigint AS recent_visits,
       count(*) FILTER (WHERE v.created_at >= sqlc.arg(recent_from)::timestamptz AND v.submitted)::bigint AS recent_submitted,
       count(*) FILTER (WHERE v.created_at <  sqlc.arg(recent_from)::timestamptz)::bigint AS base_visits,
       count(*) FILTER (WHERE v.created_at <  sqlc.arg(recent_from)::timestamptz AND v.submitted)::bigint AS base_submitted
FROM form_visits v
JOIN forms f ON f.id = v.form_id
WHERE v.created_at >= sqlc.arg(base_from)::timestamptz
GROUP BY v.form_id, f.workspace_id, f.slug, f.status, f.name, f.title;
