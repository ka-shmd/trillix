-- Запросы модуля forms. Схема — migrations/0003_forms. Генерация: `make sqlc`.
--
-- published_version — номер (form_versions.version) текущей опубликованной версии
-- формы (NULL, пока форму не публиковали). Читающие запросы (Get/List) достают его
-- LEFT JOIN по published_version_id — тип nullable. Мутации его НЕ выбирают: сервис
-- и так знает версию (при публикации — из InsertFormVersion, иначе переносит из
-- заранее прочитанной формы), а коррелированный подзапрос в RETURNING sqlc считает
-- NOT NULL, из-за чего скан NULL (черновик) на них падал бы.

-- name: GetPersonalWorkspace :one
-- ЛИЧНОЕ пространство пользователя — то, куда попадают формы, когда пространство
-- не названо явно. С 0016 оно помечено колонкой, а не выводится из «самого
-- раннего членства»: членство в чужом пространстве старше собственной
-- регистрации невозможно сегодня, но станет возможным ошибкой в любой момент,
-- а цена такой ошибки — формы, уехавшие в чужую папку.
SELECT id
FROM workspaces
WHERE personal_user_id = $1;


-- name: CreateForm :one
INSERT INTO forms (id, workspace_id, title, slug)
VALUES ($1, $2, $3, $4)
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: CreateFormWithSchema :one
-- Как CreateForm, но с заданным именем и черновиком схемы: дубликация формы задаёт
-- name = «{база} (копия N)» и копирует draft_schema исходника; title (публичный
-- заголовок) копируется как есть. Статус — дефолтный draft (публикация не
-- переносится), поэтому published_version_id в RETURNING всегда NULL.
INSERT INTO forms (id, workspace_id, title, slug, name, draft_schema)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: GetForm :one
-- Полная форма, включая черновик схемы: GET /forms/{id} отдаёт draft_schema
-- (заглушка редактора в фазе 2, живой билдер — в фазе 3). published_version — номер
-- опубликованной версии (NULL для черновика), для шапки билдера «версия N».
SELECT f.id, f.workspace_id, f.name, f.title, f.slug, f.status, f.draft_schema, f.published_version_id,
    fv.version AS published_version,
    -- Черновик отличается от опубликованной версии → в шапке билдера бейдж «есть
    -- неопубликованные изменения». Сравнение JSONB (draft_schema и снапшот пишутся
    -- канонизированными, так что сразу после публикации они равны). Заголовок в
    -- версию не входит — переименование бейдж не поднимает. coalesce: без версии → false.
    coalesce(f.published_version_id IS NOT NULL AND f.draft_schema IS DISTINCT FROM fv.schema, false)::bool AS has_unpublished_changes,
    -- Сверхлимитные ответы (over_quota, 0014) в счётчик КАБИНЕТА не входят: карточка
    -- обязана показывать то же число, что и таблица ответов, иначе «6 ответов» на
    -- карточке против пяти в таблице читается как потеря данных. Счётчик жёсткого
    -- капа формы (GetPublicFormBySlug) считает ВСЕ строки — это другая семантика.
    (SELECT count(*) FROM submissions s WHERE s.form_id = f.id AND NOT s.over_quota) AS submission_count,
    -- Просмотры и конверсия (фаза 8.5 шаг 6). Два скалярных подзапроса — тот же
    -- идиом, что у submission_count выше; оба идут по idx_form_visits_form.
    -- Конверсия считается по визитам (submitted/total), а НЕ делением
    -- submission_count на visit_count: это разные множества (ответ мог прийти без
    -- визита), и их частное — не конверсия (ADR §10).
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id) AS visit_count,
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id AND v.submitted) AS visit_submitted_count,
    f.close_at, f.response_limit, f.closed_message, f.notify_on_submission,
    f.created_at, f.updated_at
FROM forms f
LEFT JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.id = $1;

-- name: GetFormBySlug :one
-- Та же полная форма, что GetForm, но по slug: приватный резолв формы для кабинета,
-- где URL редактора/ответов/шаринга адресуют форму коротким slug (как публичный
-- рендерер /r/{slug}), а не UUID. slug глобально уникален (UNIQUE) и стабилен
-- (nanoid, задаётся при создании, не меняется). Доступ проверяет service по
-- workspace_id строки (членство), сам slug права не даёт.
SELECT f.id, f.workspace_id, f.name, f.title, f.slug, f.status, f.draft_schema, f.published_version_id,
    fv.version AS published_version,
    coalesce(f.published_version_id IS NOT NULL AND f.draft_schema IS DISTINCT FROM fv.schema, false)::bool AS has_unpublished_changes,
    -- Сверхлимитные ответы (over_quota, 0014) в счётчик КАБИНЕТА не входят: карточка
    -- обязана показывать то же число, что и таблица ответов, иначе «6 ответов» на
    -- карточке против пяти в таблице читается как потеря данных. Счётчик жёсткого
    -- капа формы (GetPublicFormBySlug) считает ВСЕ строки — это другая семантика.
    (SELECT count(*) FROM submissions s WHERE s.form_id = f.id AND NOT s.over_quota) AS submission_count,
    -- Просмотры и конверсия (фаза 8.5 шаг 6). Два скалярных подзапроса — тот же
    -- идиом, что у submission_count выше; оба идут по idx_form_visits_form.
    -- Конверсия считается по визитам (submitted/total), а НЕ делением
    -- submission_count на visit_count: это разные множества (ответ мог прийти без
    -- визита), и их частное — не конверсия (ADR §10).
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id) AS visit_count,
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id AND v.submitted) AS visit_submitted_count,
    f.close_at, f.response_limit, f.closed_message, f.notify_on_submission,
    f.created_at, f.updated_at
FROM forms f
LEFT JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.slug = $1;

-- name: ListFormsPage :many
-- Страница списка форм воркспейса: поиск, сортировка и курсор одним запросом
-- (фаза 8.5 шаг 8). limit+1 строк — вызывающий по «лишней» строке понимает, есть
-- ли следующая страница.
--
-- ОДИН запрос на три порядка вместо шести (первая/следующая × updated/created/
-- responses) — за счёт нормализации ключа сортировки к bigint: время переводится
-- в наносекунды эпохи, число ответов уже bigint. Отсюда же неизменный формат
-- курсора «<int64>:<uuid>»: у всех трёх порядков ключ одного типа, меняется
-- только его смысл (какой именно порядок — часть курсора, см. handler).
-- extract(epoch) в PG возвращает numeric, поэтому ×1e9 точен до наносекунды и
-- совпадает с time.Time.UnixNano() на стороне Go (PG хранит микросекунды).
--
-- Цена решения: CASE в ORDER BY не даёт использовать idx_forms_workspace для
-- сортировки (индекс отбирает строки воркспейса, порядок строит sort-узел).
-- Осознанно: сортируются десятки строк одного воркспейса, а стоимость запроса и
-- так определяют счётчики ответов/визитов. Отдельный индекс под created_at по той
-- же причине не заводится — CASE им всё равно не воспользуется.
SELECT * FROM (
    SELECT f.id, f.workspace_id, f.name, f.title, f.slug, f.status, f.published_version_id,
        fv.version AS published_version,
        coalesce(f.published_version_id IS NOT NULL AND f.draft_schema IS DISTINCT FROM fv.schema, false)::bool AS has_unpublished_changes,
        c.submission_count,
        -- Просмотры и конверсия (фаза 8.5 шаг 6). Конверсия считается по визитам
        -- (submitted/total), а НЕ делением submission_count на visit_count: это
        -- разные множества (ответ мог прийти без визита), и их частное — не
        -- конверсия (ADR §10). LATERAL вместо скалярных подзапросов: счётчик
        -- нужен и в проекции, и в ключе сортировки — считаем один раз.
        v.visit_count,
        v.visit_submitted_count,
        f.created_at, f.updated_at,
        CASE sqlc.arg(sort)::text
            WHEN 'created' THEN (extract(epoch FROM f.created_at) * 1000000000)::bigint
            WHEN 'responses' THEN c.submission_count
            ELSE (extract(epoch FROM f.updated_at) * 1000000000)::bigint
        END AS sort_key
    FROM forms f
    LEFT JOIN form_versions fv ON fv.id = f.published_version_id
    LEFT JOIN LATERAL (
        SELECT count(*) AS submission_count FROM submissions s WHERE s.form_id = f.id AND NOT s.over_quota
    ) c ON true
    LEFT JOIN LATERAL (
        SELECT count(*) AS visit_count,
               count(*) FILTER (WHERE vv.submitted) AS visit_submitted_count
        FROM form_visits vv WHERE vv.form_id = f.id
    ) v ON true
    WHERE f.workspace_id = sqlc.arg(workspace_id)
      -- Поиск по ОТОБРАЖАЕМОМУ имени: кабинет показывает name, а при пустом —
      -- title, поэтому ищем ровно по тому, что человек видит на карточке.
      -- Спецсимволы LIKE экранирует вызывающий (service), иначе «50%» ищет что
      -- угодно.
      AND (sqlc.narg(search)::text IS NULL
           OR coalesce(f.name, f.title) ILIKE '%' || sqlc.narg(search)::text || '%')
) t
-- Keyset по паре (ключ сортировки, id): id разводит строки с равным ключом —
-- у сортировки по числу ответов совпадения массовые (у большинства форм 0).
WHERE sqlc.narg(cursor_key)::bigint IS NULL
   OR (t.sort_key, t.id) < (sqlc.narg(cursor_key)::bigint, sqlc.narg(cursor_id)::uuid)
ORDER BY t.sort_key DESC, t.id DESC
LIMIT sqlc.arg(page_limit);

-- name: UpdateFormName :one
-- Внутреннее имя формы (дашборд): переименование в кабинете и суффикс «(копия N)»
-- при дубле. Публичный заголовок (title) не трогает. В пределах воркспейса; 0 строк
-- (чужая/нет формы) → service трактует как 404. updated_at двигаем вручную.
UPDATE forms
SET name = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormCloseSettings :one
-- Живые настройки закрытия формы (фаза 8.5 шаг 4): дата, лимит, текст «приём
-- закрыт». Заменяют все три колонки разом (страница настроек шлёт полный набор;
-- NULL = ограничение снято) — колонки, а не JSONB-схема, т.к. настройка живая, а
-- схема снапшотится при публикации (ADR §10). В пределах воркспейса; 0 строк
-- (чужая/нет формы) → service трактует как 404. updated_at двигаем вручную.
UPDATE forms
SET close_at = $3, response_limit = $4, closed_message = $5, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormNotifyOnSubmission :one
-- Тумблер уведомлений владельцу о новом ответе (слайс D) — живая колонка. В пределах
-- воркспейса (анти-IDOR); 0 строк (чужая/нет формы) → service трактует как 404.
-- updated_at двигаем вручную. RETURNING — стандартный набор карточки: хендлер отдаёт
-- базовый formResponse, а свежее значение тумблера фронт берёт рефетчем детали.
UPDATE forms
SET notify_on_submission = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: GetSubmissionOwner :one
-- Владелец формы и её отображаемое имя — для письма-уведомления о новом ответе
-- (слайс D). Джойн forms → workspace_members(owner) → users. Название берём
-- внутреннее (name ?? title): письмо видит владелец, ему привычнее имя из кабинета.
-- Вызывается приёмом ответа по form_id (форма уже резолвнута), членство тут не
-- проверяется — это не доступ пользователя, а адресат уведомления.
SELECT u.email, coalesce(f.name, f.title) AS title
FROM forms f
JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.role = 'owner'
JOIN users u ON u.id = wm.user_id
WHERE f.id = $1;

-- name: ListFormNames :many
-- Имена и заголовки всех форм воркспейса — для нумерации копий: сервис вычисляет
-- отображаемое имя (name ?? title) каждой формы и подбирает следующий «(копия N)»
-- без коллизий. Форм на воркспейс немного, грузятся разом.
SELECT name, title FROM forms WHERE workspace_id = $1;

-- name: UpdateFormDraftSchema :one
-- Автосейв билдера с оптимистичной блокировкой: строка обновляется, только если
-- форма в воркспейсе И её updated_at совпадает с присланным клиентом. Иначе 0
-- строк — service различает «чужая/нет формы» (проверено заранее) от расхождения
-- версии (updated_at сдвинула другая вкладка → 409). updated_at двигаем вручную.
--
-- title здесь — ЗЕРКАЛО заголовка из документа (фаза 15): источник заголовка —
-- блок form_title, колонку сервер пишет производной, чтобы её пятеро потребителей
-- (<title>, og:title, тело 410, письмо, дашборд) не менялись вовсе. NULL значит
-- «документ о заголовке не высказался» (схема снята до фазы) — колонку не трогаем.
-- Одним UPDATE, а не транзакцией из двух: зеркало обязано двигаться ровно тогда,
-- когда двигается схема, и промежуточного состояния между ними быть не должно.
UPDATE forms
SET draft_schema = $3, title = COALESCE(sqlc.narg(title), title), updated_at = now()
WHERE id = $1
  AND workspace_id = $2
  AND updated_at = sqlc.arg(expected_updated_at)::timestamptz
RETURNING id, workspace_id, name, title, slug, status, draft_schema, published_version_id, created_at, updated_at;

-- name: DeleteForm :execrows
-- Удаляет только в пределах воркспейса; возвращает число удалённых строк
-- (0 → чужая/несуществующая форма).
DELETE FROM forms
WHERE id = $1 AND workspace_id = $2;

-- name: GetPublicFormBySlug :one
-- Публичная выдача формы по slug: title + схема последней опубликованной версии +
-- статус и живые настройки закрытия (фаза 8.5 шаг 4). INNER JOIN по
-- published_version_id отсекает черновик (у него версии нет) → 0 строк → 404,
-- существование приватного не раскрывается. Закрытую (снятую вручную ИЛИ по
-- дате/лимиту) строку ОТДАЁМ: вызывающий вычислит FormClosed и покажет «приём
-- закрыт» — форма была публичной (инвариант 5 распространяется только на черновик).
-- submission_count считаем ТОЛЬКО при заданном лимите (иначе 0): у форм без лимита
-- лишний скан submissions на каждом открытии не нужен. published_version_id —
-- источник ETag (иммутабелен на версию); f.id (form_id) нужен приёму ответа.
-- workspace_id — тоже приёму (фаза 17): квота тарифа считается по воркспейсу, и
-- брать его отсюда дешевле, чем отдельным запросом на горячем пути.
SELECT f.id AS form_id, f.workspace_id, f.title, fv.version, fv.schema, f.published_version_id,
    f.status, f.close_at, f.response_limit, f.closed_message, f.notify_on_submission,
    CASE WHEN f.response_limit IS NOT NULL
         THEN (SELECT count(*) FROM submissions s WHERE s.form_id = f.id)
         ELSE 0 END::bigint AS submission_count
FROM forms f
JOIN form_versions fv ON fv.id = f.published_version_id
WHERE f.slug = $1;

-- name: ListFormVersions :many
-- Все опубликованные версии формы (снапшоты схем), по возрастанию номера. Нужен
-- CSV-экспорту (фаза 6): колонки — объединение блоков по всем версиям, а подписи
-- choice-опций берутся из версии, по которой отправлен ответ. Версий на форму
-- немного — грузятся разом. form_versions иммутабельна, порядок стабилен.
SELECT version, schema
FROM form_versions
WHERE form_id = $1
ORDER BY version;

-- name: NextFormVersion :one
-- Следующий номер версии формы: max+1 (1 для первой публикации). Уникальность
-- (form_id, version) в схеме страхует от гонки двух параллельных публикаций —
-- вторая упрётся в constraint. Каст к int, чтобы sqlc вывел не-nullable тип.
SELECT (coalesce(max(version), 0) + 1)::int AS next_version
FROM form_versions
WHERE form_id = $1;

-- name: InsertFormVersion :one
-- Иммутабельный снапшот черновика при публикации. Возвращает id — им проставляется
-- forms.published_version_id в той же транзакции.
INSERT INTO form_versions (id, form_id, version, schema)
VALUES ($1, $2, $3, $4)
RETURNING id, version;

-- name: SetFormPublished :one
-- Публикация: status='published' + ссылка на свежую версию. В пределах воркспейса;
-- 0 строк (чужая/нет формы) service трактует как 404. updated_at двигаем вручную.
UPDATE forms
SET status = 'published', published_version_id = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: SetFormClosed :one
-- Снятие с публикации: status='closed'. published_version_id не трогаем — знаем,
-- какая версия была последней опубликованной. В пределах воркспейса.
UPDATE forms
SET status = 'closed', updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;
