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
SELECT last_block_id, submitted, count(*) AS visits
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
GROUP BY last_block_id, submitted;

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
-- респондентов. Их число отдаётся отдельной колонкой (timed_visits) — экран обязан
-- отличать «данных нет» от «ноль секунд», а знаменатель метрики надо показывать.
--
-- unique_visitors — count(DISTINCT visitor_key). NULL-ключи (нет адреса, нет
-- секрета) count(DISTINCT ...) не считает вовсе — это ровно то поведение, которое
-- нужно: визит без ключа не человек и не «ещё один человек».
--
-- Ключ СУТОЧНЫЙ, поэтому за период длиннее суток число завышено: один человек,
-- заходивший три дня подряд, даёт три ключа. Оговорка стоит на экране рядом с
-- числом — метрика косвенная, и её граница есть часть показания.
--
-- Число ответов формы за период сюда НЕ приезжает: submissions — чужой модуль и
-- второе независимое множество (ANALYTICS.md §1). Его считает свой эндпоинт.
SELECT count(*)::bigint                                        AS visits,
       count(*) FILTER (WHERE submitted)::bigint               AS submitted,
       count(DISTINCT visitor_key)::bigint                     AS unique_visitors,
       count(*) FILTER (WHERE updated_at > created_at)::bigint AS timed_visits,
       coalesce(
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM updated_at - created_at)
           ) FILTER (WHERE updated_at > created_at),
       0)::float8                                              AS median_duration_sec
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz;

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
-- Сырьё списка источников: тройка меток и счётчик. Семантику («utm_source
-- перебивает хост referer'а», «ни того ни другого — прямой заход») знает Go
-- (domain.FoldSources) — здесь только группировка.
--
-- Различных троек у формы десятки, а не по одной на визит: разбирать их на чтении
-- дёшево, а хранить разобранное колонкой значило бы, что улучшенное правило чинит
-- только будущие визиты.
SELECT coalesce(meta->>'referer', '')::text    AS referer,
       coalesce(meta->>'utm_source', '')::text AS utm_source,
       coalesce(meta->>'utm_medium', '')::text AS utm_medium,
       count(*)::bigint                        AS visits
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
       count(*)::bigint                        AS visits
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
GROUP BY 1;

-- name: VisitCountries :many
-- Страны за период. Визиты без гео (справочника нет, приватный адрес, IPv6) сюда не
-- попадают: их число считается отдельно, из общего числа визитов, — иначе строка
-- «Не определено» конкурировала бы со странами в одном списке и притворялась местом.
SELECT country_code, coalesce(country, '')::text AS country, count(*)::bigint AS visits
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
SELECT city, country_code, count(*)::bigint AS visits
FROM form_visits
WHERE form_id = $1
  AND created_at >= sqlc.arg(from_ts)::timestamptz
  AND created_at <  sqlc.arg(to_ts)::timestamptz
  AND city IS NOT NULL AND city <> ''
GROUP BY city, country_code
ORDER BY visits DESC, city;
