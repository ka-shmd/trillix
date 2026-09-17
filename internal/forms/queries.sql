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
    -- Дата последнего ответа: колонка «Последний ответ» в списке форм. Фильтр
    -- over_quota тот же, что у счётчика выше, — иначе дата называла бы ответ,
    -- которого в таблице ответов не видно. NULL = ответов не было ни одного.
    (SELECT max(s.created_at) FROM submissions s WHERE s.form_id = f.id AND NOT s.over_quota)::timestamptz AS last_submission_at,
    -- Просмотры и конверсия (фаза 8.5 шаг 6). Два скалярных подзапроса — тот же
    -- идиом, что у submission_count выше; оба идут по idx_form_visits_form.
    -- Конверсия считается по визитам (submitted/total), а НЕ делением
    -- submission_count на visit_count: это разные множества (ответ мог прийти без
    -- визита), и их частное — не конверсия (ADR §10).
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id) AS visit_count,
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id AND v.submitted) AS visit_submitted_count,
    f.close_at, f.response_limit, f.closed_message, f.closed_title, f.notify_on_submission, f.collect_partial,
    f.link_preview, f.branding, f.progress, f.notify_email, f.auto_jump, f.save_locally, f.allow_back,
    f.notify_respondent, f.respondent_email,
    -- password: шифротекст пароля формы (0047). Кабинету он едет ЦЕЛИКОМ, а не
    -- признаком «пароль есть»: автор видит и копирует свой пароль (решение владельца,
    -- design/form-password.md §2.1), расшифровывает его service. Публичному пути
    -- шифротекст не нужен — GetPublicFormBySlug берёт только признак.
    f.password,
    -- w.slug: КОРОТКИЙ КЛЮЧ ПРОСТРАНСТВА. Кабинет адресует пространство им (URL
    -- вида /workspaces/{slug}/…), а знать его форма обязана: попап блока «Запись»
    -- ведёт автора в расписания ЕЁ пространства, и вывод контекста из адреса здесь
    -- однажды уже увёл расписание не туда (TD-69, отчёт владельца 2026-09-03).
    w.slug AS workspace_slug,
    -- schedule_id: расписание записи на время (0050); NULL = у формы нет записи.
    -- Живая колонка, как настройки закрытия: смена расписания действует со следующего
    -- же ответа, без перепубликации (ADR §10). Выбирает его автор в блоке «Запись».
    f.schedule_id,
    f.created_at, f.updated_at
FROM forms f
JOIN workspaces w ON w.id = f.workspace_id
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
    (SELECT max(s.created_at) FROM submissions s WHERE s.form_id = f.id AND NOT s.over_quota)::timestamptz AS last_submission_at,
    -- Просмотры и конверсия (фаза 8.5 шаг 6). Два скалярных подзапроса — тот же
    -- идиом, что у submission_count выше; оба идут по idx_form_visits_form.
    -- Конверсия считается по визитам (submitted/total), а НЕ делением
    -- submission_count на visit_count: это разные множества (ответ мог прийти без
    -- визита), и их частное — не конверсия (ADR §10).
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id) AS visit_count,
    (SELECT count(*) FROM form_visits v WHERE v.form_id = f.id AND v.submitted) AS visit_submitted_count,
    f.close_at, f.response_limit, f.closed_message, f.closed_title, f.notify_on_submission, f.collect_partial,
    f.link_preview, f.branding, f.progress, f.notify_email, f.auto_jump, f.save_locally, f.allow_back,
    f.notify_respondent, f.respondent_email,
    f.password,
    -- w.slug: КОРОТКИЙ КЛЮЧ ПРОСТРАНСТВА. Кабинет адресует пространство им (URL
    -- вида /workspaces/{slug}/…), а знать его форма обязана: попап блока «Запись»
    -- ведёт автора в расписания ЕЁ пространства, и вывод контекста из адреса здесь
    -- однажды уже увёл расписание не туда (TD-69, отчёт владельца 2026-09-03).
    w.slug AS workspace_slug,
    -- schedule_id: расписание записи на время (0050); NULL = у формы нет записи.
    -- Живая колонка, как настройки закрытия: смена расписания действует со следующего
    -- же ответа, без перепубликации (ADR §10). Выбирает его автор в блоке «Запись».
    f.schedule_id,
    f.created_at, f.updated_at
FROM forms f
JOIN workspaces w ON w.id = f.workspace_id
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
        c.last_submission_at,
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
        SELECT count(*) AS submission_count, max(s.created_at)::timestamptz AS last_submission_at
        FROM submissions s WHERE s.form_id = f.id AND NOT s.over_quota
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
      -- Фильтр по статусу: сегменты «Черновики / Опубликованные / Закрытые» над
      -- списком. Фильтровать на клиенте нельзя по той же причине, что и искать:
      -- список постраничный, и отбор из подгруженного молча терял бы формы с
      -- неподгруженных страниц. Значение проверяет handler, сюда приходит
      -- разобранным либо NULL («все»).
      AND (sqlc.narg(status)::text IS NULL OR f.status = sqlc.narg(status)::text)
) t
-- Keyset по паре (ключ сортировки, id): id разводит строки с равным ключом —
-- у сортировки по числу ответов совпадения массовые (у большинства форм 0).
WHERE sqlc.narg(cursor_key)::bigint IS NULL
   OR (t.sort_key, t.id) < (sqlc.narg(cursor_key)::bigint, sqlc.narg(cursor_id)::uuid)
ORDER BY t.sort_key DESC, t.id DESC
LIMIT sqlc.arg(page_limit);

-- name: SearchFormsForUser :many
-- Поиск формы ПО ВСЕМ пространствам, где человек состоит: он не помнит, в каком
-- из них лежит форма, а экрана «все мои формы» в кабинете нет — формы адресуются
-- через пространство.
--
-- Запрос СВОЙ, а не режим списка (ListFormsPage), и это решение, а не дубль. Список
-- тянет на каждую форму счётчики ответов и визитов двумя LATERAL и строит курсор;
-- поиску не нужно ни одно из трёх — ему нужны имя, место и ссылка. Прогонять
-- тяжёлый запрос по всем пространствам ради строки результата значило бы платить за
-- то, что тут же выбрасывается.
--
-- Право доступа обеспечивает JOIN по членству — ровно тем же способом, что список
-- пространств: чужая форма не может попасть в выдачу, потому что не может пройти
-- соединение (инвариант безопасности 1).
--
-- Поиск по ОТОБРАЖАЕМОМУ имени (coalesce(name, title)) — по тому же полю и с тем же
-- экранированием LIKE, что список: искать по тому, что человек видит на карточке.
--
-- Порядок — по свежести правки: у поиска без ранжирования это единственный ответ на
-- «какая из двух похожих мне нужна», и он же ставит наверх ту, с которой работали.
SELECT f.id, f.slug, f.name, f.title, f.status, f.updated_at,
       w.slug AS workspace_slug, w.name AS workspace_name
FROM forms f
JOIN workspaces w ON w.id = f.workspace_id
JOIN workspace_members m ON m.workspace_id = f.workspace_id AND m.user_id = sqlc.arg(user_id)
WHERE coalesce(f.name, f.title) ILIKE '%' || sqlc.arg(search)::text || '%'
ORDER BY f.updated_at DESC, f.id DESC
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
SET close_at = $3, response_limit = $4, closed_message = $5, closed_title = $6, updated_at = now()
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

-- name: UpdateFormCollectPartial :one
-- Тумблер сбора незавершённых ответов (спека design/analytics-tally.md §10.0).
-- Живая колонка, как настройки закрытия: включается и выключается без
-- перепубликации. Право спрашивает service ДО этого запроса — здесь только запись.
UPDATE forms
SET collect_partial = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormBranding :one
-- Тумблер бейджа «Сделано в Trillix» (ADR §10, миграция 0038). Живая колонка, а не
-- поле схемы: намерение обязано доезжать до респондента без перепубликации. Тариф
-- здесь НЕ спрашивается — право проверяется при отдаче публичной формы, и снять
-- бейдж в кабинете вправе любой план (кабинет при этом сам держит контрол, EMBED §10).
UPDATE forms
SET branding = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormProgress :one
-- Тумблер шкалы прогресса — индикатора шагов многостраничной формы (миграция 0040).
-- Живая колонка, а не поле схемы, по тому же доводу, что у бейджа: намерение обязано
-- доезжать до респондента без перепубликации. Тариф здесь ни при чём — шкала открыта
-- всем планам.
UPDATE forms
SET progress = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormNotifyEmail :one
-- Настройка письма о новом ответе: имя отправителя, Reply-To, тема, текст (0042).
-- Живая колонка, как link_preview: правка действует со следующего же ответа, без
-- перепубликации. Кабинет шлёт настройку ЦЕЛИКОМ, поэтому здесь замена значения, а
-- не слияние JSONB; пустая нормализуется в NULL на стороне repo. Право тарифа
-- (form_notify_email) спрашивает service ДО этого запроса — здесь только запись.
UPDATE forms
SET notify_email = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormNotifyRespondent :one
-- Тумблер письма респонденту (0046) — живая колонка, зеркало
-- UpdateFormNotifyOnSubmission. Право тарифа (form_respondent_email) спрашивает
-- service ДО этого запроса: письмо респонденту платно целиком, а не только своим
-- текстом.
UPDATE forms
SET notify_respondent = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormRespondentEmail :one
-- Бланк письма респонденту: вопрос-источник адреса, имя отправителя, Reply-To, тема,
-- текст, PDF (0046). Замена значения целиком, как у UpdateFormNotifyEmail; пустая
-- настройка нормализуется в NULL на стороне repo.
UPDATE forms
SET respondent_email = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormBehavior :one
-- Раздел «Поведение» (0044, третья колонка — 0055): автопереход, хранение ответов в
-- браузере респондента и ход назад по страницам. Три колонки одним запросом — это ОДИН
-- экранный раздел, и кабинет шлёт его набором; по отдельности они не спрашиваются
-- нигде. Тарифа ни у одной нет.
UPDATE forms
SET auto_jump = $3, save_locally = $4, allow_back = $5, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormPassword :one
-- Пароль на форму (0047): шифротекст либо NULL (снять). Живая колонка, как настройки
-- закрытия: и включение, и снятие действуют немедленно, без перепубликации. Тарифа
-- здесь нет вовсе — пароль бесплатен на всех планах (решение владельца 2026-09-01).
-- Шифрует service; repo и БД видят только байты.
UPDATE forms
SET password = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: GetFormPasswordBySlug :one
-- Шифротекст пароля и id формы по slug — для публичной ручки разблокировки.
--
-- ⚠ ВИДИМОСТЬ ФОРМЫ ЗДЕСЬ ОБЯЗАНА СОВПАДАТЬ С GetPublicFormBySlug, иначе ручка
-- становится оракулом существования: она отвечала бы 401/200 там, где отдача формы
-- отвечает 404. Отсюда те же три джойна — опубликованная версия (черновик не
-- показываем, инвариант 5) и ЖИВОЙ владелец пространства (фаза 23, слайс G: форма
-- удалённого аккаунта не существует ни для кого).
SELECT f.id AS form_id, f.password
FROM forms f
JOIN form_versions fv ON fv.id = f.published_version_id
JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.role = 'owner'
JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
WHERE f.slug = $1;

-- name: UpdateFormLinkPreview :one
-- Своя карточка ссылки формы (og:site_name/title/description/image + иконка).
-- Живая колонка, как настройки закрытия: применяется без перепубликации. Окно
-- кабинета шлёт карточку ЦЕЛИКОМ (не патч по полю), поэтому здесь замена значения,
-- а не слияние JSONB; пустая карточка нормализуется в NULL на стороне repo. Тариф
-- здесь НЕ спрашивается вовсе: сохранять карточку вправе любой план, а разрешение
-- проверяется при отдаче публичной страницы. В пределах воркспейса (анти-IDOR);
-- 0 строк (чужая/нет формы) → service трактует как 404.
UPDATE forms
SET link_preview = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: GetSubmissionOwner :one
-- Владелец формы и её отображаемое имя — для письма-уведомления о новом ответе
-- (слайс D). Джойн forms → workspace_members(owner) → users. Название берём
-- внутреннее (name ?? title): письмо видит владелец, ему привычнее имя из кабинета.
-- Вызывается приёмом ответа по form_id (форма уже резолвнута), членство тут не
-- проверяется — это не доступ пользователя, а адресат уведомления.
-- respondent_email и публичный заголовок едут здесь же, а не на публичном пути
-- (0046): бланк письма нужен ТОЛЬКО когда письмо ставится, а GetPublicFormBySlug
-- отрабатывает на каждом открытии формы — лишний JSONB на самом горячем запросе
-- продукта не бесплатен. Заголовков два и они разные: `title` — внутреннее имя
-- (name ?? title), его видит владелец; `public_title` — то, как форма называется
-- для респондента, и в подвале его письма стоит именно оно. slug — адрес формы
-- для того же подвала: письма респонденту и о записи обязаны сказать, откуда
-- они взялись, а адрес известен только здесь.
SELECT u.email, coalesce(f.name, f.title) AS title, f.title AS public_title,
    f.slug, f.workspace_id, f.notify_email, f.respondent_email
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
-- Публичная выдача формы по slug ВМЕСТЕ С ДОКУМЕНТОМ. Путям, которым документ не
-- нужен, отвечает GetPublicFormRefBySlug ниже — у него те же отборы и та же мина
-- про добавленные колонки.
--
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
SELECT f.id AS form_id, f.workspace_id, f.title,
    -- cabinet_name: имя формы В КАБИНЕТЕ (name ?? title). Респонденту не
    -- отдаётся: его потребитель — уведомление кабинета о новых ответах, где
    -- форма обязана называться тем же словом, что в списке форм. Едет здесь,
    -- а не запросом владельца (GetSubmissionOwner): тот джойнит участников и
    -- пользователей ради письма, которого у формы может не быть вовсе.
    coalesce(f.name, f.title) AS cabinet_name,
    fv.version, fv.schema, f.published_version_id,
    f.status, f.close_at, f.response_limit, f.closed_message, f.closed_title, f.notify_on_submission,
    -- notify_respondent: тумблер письма респонденту (0046). Здесь едет только ФЛАГ,
    -- как и у письма владельцу; бланк приезжает с GetSubmissionOwner, то есть
    -- только когда письмо действительно ставится в очередь.
    f.notify_respondent,
    -- collect_partial: тумблер сбора незавершённых. Едет на публичном пути вместе с
    -- формой — рендереру он нужен и чтобы автосохранять, и чтобы предупредить
    -- респондента. Право тарифа поверх него спрашивает сервис (даунгрейд обязан
    -- останавливать сбор, как у бейджа).
    f.collect_partial,
    -- link_preview: своя карточка ссылки (имя площадки, заголовок, описание,
    -- картинка, иконка). Живая колонка, как collect_partial: правка карточки
    -- обязана доезжать до мессенджера без перепубликации. Право тарифа поверх неё
    -- спрашивает сервис — карточка это свойство ВЫДАЧИ, а не документа.
    f.link_preview,
    -- branding: намерение автора о бейдже «Сделано в Trillix» (0038). Живая
    -- колонка, как collect_partial: тумблер обязан доезжать до респондента без
    -- перепубликации — бейдж не часть документа, а свойство выдачи. Право тарифа
    -- поверх намерения спрашивает сервис (даунгрейд возвращает бейдж сам).
    f.branding,
    -- progress: намерение автора о шкале прогресса (0040). Живая колонка по тем же
    -- доводам, что branding, но БЕЗ тарифа: индикатор шагов открыт всем планам, и
    -- сервис поверх этого значения ничего не спрашивает.
    f.progress,
    -- auto_jump/save_locally/allow_back: как форма ведёт себя у респондента (0044,
    -- 0055). Живые колонки без тарифа, как progress: рендерер получает намерение
    -- автора как есть.
    f.auto_jump,
    f.save_locally,
    f.allow_back,
    -- password: шифротекст пароля формы (0047); NULL = пароля нет. Едет ЦЕЛИКОМ, а не
    -- признаком «пароль есть», потому что он подмешан в подпись токена разблокировки:
    -- проверяющий пересчитывает подпись по текущему шифротексту, и смена пароля тем
    -- самым гасит все выданные токены. Наружу он не отдаётся ни в одном ответе.
    --
    -- ⚠ МИНА: пароль обязан спросить КАЖДЫЙ публичный вход по slug — отдача формы,
    -- приём ответа, автосохранение, выдача слота файла. Общего middleware нет и быть
    -- не может: решение принимается по строке формы (design/form-password.md §3.3).
    f.password,
    -- schedule_id: расписание записи (0050); NULL = у формы нет записи. Публичному
    -- пути он нужен ЦЕЛИКОМ, а не признаком: по нему выдача свободного времени берёт
    -- само расписание, а вопрос о времени в форме без расписания отвечает 404.
    --
    -- ⚠ МИНА ТА ЖЕ, ЧТО У ПАРОЛЯ: публичных входов записи три (свободное время, холд
    -- и приём ответа с бронью), и каждый обязан пройти те же четыре отказа, что
    -- отдача формы (design/booking.md §7).
    f.schedule_id,
    -- metrika_counter: номер счётчика Яндекс Метрики (0067), если автор его подключил
    -- и тумблер включён; NULL — счётчика нет. Право тарифа поверх номера спрашивает
    -- сервис (MetrikaFor): счётчик, как и бейдж, свойство выдачи, а не документа.
    fc.counter AS metrika_counter,
    -- consent_revision_id/consent_enabled: текущая ревизия согласия (0069) и её
    -- тумблер. Живая настройка, как счётчик: включённое согласие обязано доезжать до
    -- респондента без перепубликации, а приём ответа без галочки — отказывать.
    f.consent_revision_id, cr.enabled AS consent_enabled,
    CASE WHEN f.response_limit IS NOT NULL
         THEN (SELECT count(*) FROM submissions s WHERE s.form_id = f.id)
         ELSE 0 END::bigint AS submission_count
FROM forms f
JOIN form_versions fv ON fv.id = f.published_version_id
-- Владелец пространства обязан быть живым (фаза 23, слайс G): удалённый аккаунт
-- не может принимать чужие персональные данные формой, которую больше некому
-- разбирать. Ноль строк → 404 — тот же ответ, что у черновика, инвариант 5 не
-- трогается. Джойн INNER и по этой же причине отправляет в 404 формы
-- осиротевшего пространства (без владельца) — они и так недостижимы (TD-53).
JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.role = 'owner'
JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
-- LEFT JOIN по UNIQUE (form_id, kind): не больше одной строки, форму не размножает.
LEFT JOIN form_counters fc ON fc.form_id = f.id AND fc.kind = 'yandex_metrika' AND fc.enabled
-- LEFT JOIN по первичному ключу ревизии: не больше одной строки.
LEFT JOIN form_consent_revisions cr ON cr.id = f.consent_revision_id
WHERE f.slug = $1;

-- name: GetPublicFormRefBySlug :one
-- ТА ЖЕ публичная форма, что у соседнего GetPublicFormBySlug, но БЕЗ её документа:
-- ни схемы версии, ни заголовка (заголовок живёт в документе — см. Service.PublicForm).
-- Отборы, джойны и смысл колонок совпадают дословно, и расходиться им нельзя: оба
-- запроса обязаны одинаково отвечать «формы нет» на черновик, на осиротевшее
-- пространство и на удалённого владельца.
--
-- Зачем отдельный запрос (TD-77). `fv.schema` — это JSONB документа формы, то есть
-- чтение из TOAST на каждый вызов. Вызовов на одного респондента десятки: бикон
-- визита шлётся на открытие, на каждый переход страницы и на каждое переключение
-- вкладки, а выдача свободного времени и холд — на каждое движение в пикере. Ни
-- одному из них схема не нужна: они решают четыре отказа (нет формы, пароль,
-- закрыта, переиздана) и работают с id. Раньше все они платили за документ, который
-- тут же выбрасывали.
--
-- ⚠ Мина: колонки, добавленные в GetPublicFormBySlug, нужно добавлять и сюда, иначе
-- узкий путь начнёт решать отказы по неполной строке. Всё, что НЕ про документ,
-- живёт в PublicFormRef и приезжает обоими запросами.
SELECT f.id AS form_id, f.workspace_id, coalesce(f.name, f.title) AS cabinet_name,
    fv.version, f.published_version_id,
    f.status, f.close_at, f.response_limit, f.closed_message, f.closed_title,
    f.notify_on_submission, f.notify_respondent, f.collect_partial, f.link_preview,
    f.branding, f.progress, f.auto_jump, f.save_locally, f.allow_back,
    f.password, f.schedule_id, fc.counter AS metrika_counter,
    f.consent_revision_id, cr.enabled AS consent_enabled,
    CASE WHEN f.response_limit IS NOT NULL
         THEN (SELECT count(*) FROM submissions s WHERE s.form_id = f.id)
         ELSE 0 END::bigint AS submission_count
FROM forms f
JOIN form_versions fv ON fv.id = f.published_version_id
JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.role = 'owner'
JOIN users u ON u.id = wm.user_id AND u.deleted_at IS NULL
LEFT JOIN form_counters fc ON fc.form_id = f.id AND fc.kind = 'yandex_metrika' AND fc.enabled
LEFT JOIN form_consent_revisions cr ON cr.id = f.consent_revision_id
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

-- name: GetFormVersionSchema :one
-- Снапшот одной версии по номеру — странице документа согласия: перечень данных в
-- типовом тексте берётся из той версии, по которой человек отправлял ответ.
SELECT schema
FROM form_versions
WHERE form_id = $1 AND version = $2;

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

-- name: SetFormReopened :one
-- Повторное открытие закрытой формы: status='published' БЕЗ новой версии.
-- published_version_id закрытие сохраняло, поэтому отдавать снова нечего — форма
-- возвращается к той же версии, которую респонденты видели до закрытия. Публикация
-- здесь была бы враньём: она подняла бы номер версии, ничего в документе не изменив.
-- Условие status='closed' — защита от гонки: черновик открывать нечего.
UPDATE forms
SET status = 'published', updated_at = now()
WHERE id = $1 AND workspace_id = $2 AND status = 'closed' AND published_version_id IS NOT NULL
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: SetFormClosed :one
-- Снятие с публикации: status='closed'. published_version_id не трогаем — знаем,
-- какая версия была последней опубликованной. В пределах воркспейса.
UPDATE forms
SET status = 'closed', updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: UpdateFormSchedule :one
-- Расписание записи у формы (0050). Живая колонка: смена действует со следующего же
-- ответа, без перепубликации. NULL снимает запись.
--
-- Проверку «расписание из ТОГО ЖЕ пространства» делает service: ключу её не выразить,
-- а без неё форма ссылалась бы на чужое расписание по угаданному id (инвариант 1).
UPDATE forms
SET schedule_id = $3, updated_at = now()
WHERE id = $1 AND workspace_id = $2
RETURNING id, workspace_id, name, title, slug, status, published_version_id, created_at, updated_at;

-- name: ScheduleInWorkspace :one
-- Есть ли такое расписание в этом пространстве. Вопрос задаёт привязка формы к
-- расписанию: id приезжает телом запроса и правом доступа не является (инвариант 1).
SELECT EXISTS (SELECT 1 FROM schedules WHERE id = $1 AND workspace_id = $2);

-- name: GetFormConsent :one
-- Текущая ревизия согласия формы (0069). Ноль строк — раздел ни разу не сохраняли.
SELECT r.id, r.enabled, r.settings, r.template, r.created_at
FROM forms f
JOIN form_consent_revisions r ON r.id = f.consent_revision_id
WHERE f.id = $1;

-- name: GetConsentRevision :one
-- Ревизия согласия ИМЕННО ЭТОЙ формы. form_id в условии обязателен: id ревизии
-- приезжает от респондента, и без него ответ одной формы мог бы сослаться на
-- согласие другой.
SELECT id, enabled, settings, template, created_at
FROM form_consent_revisions
WHERE id = $1 AND form_id = $2;

-- name: InsertConsentRevision :one
-- Новая ревизия. Строки не меняются и не удаляются по отдельности: по ним
-- восстанавливается текст, с которым соглашались (спека §3.1).
INSERT INTO form_consent_revisions (id, form_id, enabled, settings, template, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING created_at;

-- name: SetFormConsentRevision :execrows
-- Ставит текущую ревизию.
--
-- ⚠ updated_at формы НЕ трогается, в отличие от прочих живых настроек: им сверяется
-- автосохранение черновика, а раздел согласия сохраняется той же кнопкой страницы
-- настроек, что экран «Спасибо» (запись черновика). Сдвиг метки посреди пачки
-- запросов отдал бы черновику 409 на правке, которой никто не конфликтовал.
UPDATE forms
SET consent_revision_id = $3
WHERE id = $1 AND workspace_id = $2;

-- name: RememberConsentOperator :exec
-- Кладёт реквизиты в список пространства (0070). Тот же набор не дублируется, а
-- поднимается наверх подсказки.
INSERT INTO consent_operators (id, workspace_id, name, inn, address, email)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (workspace_id, fingerprint) DO UPDATE SET used_at = now();

-- name: ListConsentOperators :many
-- Свежие наборы пространства для подсказки.
SELECT id, name, inn, address, email
FROM consent_operators
WHERE workspace_id = $1
ORDER BY used_at DESC, id DESC
LIMIT $2;

-- name: GetConsentOperatorWorkspace :one
-- Пространство строки списка — для проверки права перед удалением.
SELECT workspace_id FROM consent_operators WHERE id = $1;

-- name: DeleteConsentOperator :execrows
DELETE FROM consent_operators WHERE id = $1 AND workspace_id = $2;
