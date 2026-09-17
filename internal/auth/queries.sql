-- Запросы модуля auth. Схема — migrations/0002_auth. Генерация: `make sqlc`.

-- name: CreateUser :one
INSERT INTO users (id, email, password_hash)
VALUES ($1, $2, $3)
RETURNING id, email, password_hash, created_at, email_verified_at, first_name, last_name, deleted_at, avatar_key, two_factor_enabled, is_admin, signup_completed_at;

-- Четыре запроса ниже (GetUserByID, GetUserByEmail, GetSessionUser,
-- GetUserByIdentity) — ВСЕ пути, которыми код узнаёт пользователя, и у каждого
-- стоит `deleted_at IS NULL` (фаза 23, слайс G). Забытое условие в любом из них
-- означает дверь в удалённый аккаунт: вход паролем, вход провайдером, живая
-- сессия и второй шаг входа — четыре разные двери в одну комнату.
--
-- Занятость адреса спрашивается ОТДЕЛЬНЫМ запросом (EmailTaken): помеченный
-- аккаунт продолжает занимать email, и слепота к нему здесь — не забывчивость,
-- а разные вопросы («кто это» и «свободен ли адрес»).
--
-- Сама колонка deleted_at при этом стоит в СПИСКАХ выдачи всех запросов по
-- users, хотя доменному User не нужна: набор колонок, совпадающий с таблицей,
-- заставляет sqlc отдавать общий тип postgres.User вместо семи однотипных
-- структур GetUserByEmailRow, GetSessionUserRow и так далее. Порядок в списке
-- обязан повторять ФИЗИЧЕСКИЙ порядок колонок таблицы — поэтому avatar_key
-- (0028) стоит после deleted_at, хотя по смыслу он рядом с именем: переставишь
-- — и общий тип развалится обратно на семь, а userFromRow перестанет собираться.
--
-- Отсюда мина для КАЖДОЙ новой колонки users: не дописать её в эти списки —
-- значит уронить сборку восемью ошибками разом. Так и приехал `is_admin`
-- (0059), доменному User не нужный вовсе.

-- name: GetUserByID :one
-- Пользователь по идентификатору. Нужен второму шагу входа (фаза 23, слайс F):
-- кто входит, называет подписанная cookie, а не сессия — сессии ещё нет.
SELECT id, email, password_hash, created_at, email_verified_at, first_name, last_name, deleted_at, avatar_key, two_factor_enabled, is_admin, signup_completed_at
FROM users
WHERE id = $1 AND deleted_at IS NULL;

-- name: IsUserAdmin :one
-- Администратор ли пользователь (0059). Отдельным запросом, а не полем в User:
-- спрашивает его одна ручка — заведение публичного шаблона, — и таскать флаг
-- через каждый путь входа ради неё незачем.
SELECT is_admin
FROM users
WHERE id = $1 AND deleted_at IS NULL;

-- name: GetUserByEmail :one
SELECT id, email, password_hash, created_at, email_verified_at, first_name, last_name, deleted_at, avatar_key, two_factor_enabled, is_admin, signup_completed_at
FROM users
WHERE email = $1 AND deleted_at IS NULL;

-- name: EmailTaken :one
-- Занят ли адрес — вопрос ДРУГОЙ, чем «есть ли такой пользователь»: удалённый
-- аккаунт продолжает держать свой email (UNIQUE никуда не делся, освободить его
-- нечем до реальной чистки по 152-ФЗ). Без этого запроса подтверждение смены
-- адреса на занятый удалённым падало бы на UNIQUE пятисоткой вместо 409.
SELECT EXISTS (SELECT 1 FROM users WHERE email = $1) AS taken;

-- Личное пространство регистрации: personal_user_id — и пометка «личное», и
-- ответ на «чьё» (0016). Командные пространства заводит другой запрос, с NULL.
-- name: CreatePersonalWorkspace :one
INSERT INTO workspaces (id, name, personal_user_id, slug)
VALUES ($1, $2, $3, $4)
RETURNING id, name, created_at;

-- name: CreateWorkspaceMember :exec
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ($1, $2, $3);

-- Подписка АККАУНТА — четвёртая строка транзакции регистрации (0014, фаза 17;
-- субъект переехал на аккаунт в 0016). Аккаунта без подписки не бывает: иначе
-- каждая проверка лимита обрастает веткой «а если строки нет».
-- name: CreateSubscription :exec
INSERT INTO subscriptions (user_id, plan_code)
VALUES ($1, $2);

-- name: CreateSession :exec
INSERT INTO sessions (token_hash, user_id, expires_at)
VALUES ($1, $2, $3);

-- name: GetSessionUser :one
-- Пользователь по живой (не истёкшей) сессии — для RequireAuth и /auth/me.
SELECT u.id, u.email, u.password_hash, u.created_at, u.email_verified_at, u.first_name, u.last_name, u.deleted_at, u.avatar_key, u.two_factor_enabled, u.is_admin, u.signup_completed_at
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = $1 AND s.expires_at > now() AND u.deleted_at IS NULL;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = $1;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at <= now();

-- name: GetUserByIdentity :one
-- Пользователь по привязке к провайдеру (миграция 0009). Ключ — пара
-- (провайдер, идентификатор у провайдера), а не email: адрес у провайдера
-- сменить можно, идентификатор — нет.
SELECT u.id, u.email, u.password_hash, u.created_at, u.email_verified_at, u.first_name, u.last_name, u.deleted_at, u.avatar_key, u.two_factor_enabled, u.is_admin, u.signup_completed_at
FROM user_identities i
JOIN users u ON u.id = i.user_id
WHERE i.provider = $1 AND i.provider_user_id = $2 AND u.deleted_at IS NULL;

-- name: CreateIdentity :exec
INSERT INTO user_identities (provider, provider_user_id, user_id, provider_email)
VALUES ($1, $2, $3, $4);

-- name: SetIdentityEmail :exec
-- Адрес аккаунта У ПРОВАЙДЕРА обновляется на каждом входе (фаза 23, слайс E):
-- иначе карточка «Яндекс · ivan@yandex.ru» показывала бы адрес двухлетней
-- давности. Спросить его вне потока входа нечем — токен провайдера одноразовый.
UPDATE user_identities SET provider_email = $3
WHERE provider = $1 AND provider_user_id = $2;

-- name: ListIdentities :many
-- Способы входа через провайдеров у аккаунта — экран настроек. Порядок по дате
-- привязки: он же порядок появления карточек, и он стабилен.
SELECT provider, provider_user_id, provider_email, created_at
FROM user_identities
WHERE user_id = $1
ORDER BY created_at;

-- name: LockIdentities :many
-- Привязки аккаунта под блокировкой — гейт отвязки «останется ли способ войти».
--
-- Мина: FOR UPDATE здесь несущий, а не украшение. Гейт читает состав и решает
-- по нему, поэтому без блокировки две одновременные отвязки разных провайдеров
-- обе видят «привязок две», обе проходят проверку и обе удаляют — аккаунт без
-- пароля остаётся без единого способа войти, и чинится это только руками в БД.
-- Под блокировкой второй запрос ждёт первого и перечитывает состав уже без
-- удалённой строки.
--
-- count(*) вместо списка не годится: агрегат с FOR UPDATE Postgres не
-- принимает, а считать строки в Go — ровно та же цена при одном-двух
-- провайдерах. ORDER BY — детерминированный порядок захвата.
SELECT provider FROM user_identities WHERE user_id = $1 ORDER BY provider FOR UPDATE;

-- name: DeleteIdentity :execrows
-- Отвязка. Ноль строк — привязки не было (повторный клик), и это не авария.
DELETE FROM user_identities WHERE user_id = $1 AND provider = $2;

-- name: UpdateUserProfile :one
-- Имя и фамилия целиком, а не по одному полю: экран настроек шлёт обе строки
-- разом, и «обновить только непустое» здесь означало бы, что стереть имя
-- нельзя. Пустое приезжает как NULL — приведение делает repo (pgText).
UPDATE users SET first_name = $2, last_name = $3
WHERE id = $1
RETURNING id, email, password_hash, created_at, email_verified_at, first_name, last_name, deleted_at, avatar_key, two_factor_enabled, is_admin, signup_completed_at;

-- name: SetUserAvatarKey :one
-- Ключ аватара целиком: значение — поставить, NULL — снять. Отдельным запросом,
-- а не полем UpdateUserProfile: имя правится формой с кнопкой «Сохранить», а
-- картинка — загрузкой файла, и общий запрос заставил бы каждую из двух ручек
-- слать чужое поле, чтобы его не затереть.
UPDATE users SET avatar_key = $2
WHERE id = $1
RETURNING id, email, password_hash, created_at, email_verified_at, first_name, last_name, deleted_at, avatar_key, two_factor_enabled, is_admin, signup_completed_at;

-- name: FillEmptyProfile :one
-- Дозаполнение профиля данными провайдера (фаза 23, слайс B). COALESCE, а не
-- присваивание: заполненное поле остаётся как есть, иначе каждый вход через
-- Яндекс затирал бы имя, введённое в кабинете руками. NULL в аргументе означает
-- «этого поля провайдер не дал» и тоже ничего не трогает.
UPDATE users
   SET first_name = COALESCE(first_name, $2),
       last_name  = COALESCE(last_name,  $3)
WHERE id = $1
RETURNING id, email, password_hash, created_at, email_verified_at, first_name, last_name, deleted_at, avatar_key, two_factor_enabled, is_admin, signup_completed_at;

-- name: SetUserPassword :exec
-- Ставит новый argon2id-хеш (сброс пароля). Для provider-only аккаунта переводит
-- password_hash из NULL в значение — так закрывается TD-34 (аккаунт становится
-- достижим паролем, вход через провайдера при этом сохраняется).
UPDATE users SET password_hash = $2 WHERE id = $1;

-- name: DeleteSessionsByUser :exec
-- Рвёт все сессии пользователя — обязательный шаг сброса пароля (кто угодно,
-- знавший старый пароль или укравший сессию, разлогинивается).
DELETE FROM sessions WHERE user_id = $1;

-- name: DeleteSessionsByUserExcept :exec
-- То же, но щадит одну сессию — ту, из которой человек нажал «забыть
-- устройства». Кнопку жмут, когда подозревают чужого, а чужой сидит в живой
-- сессии, которой второй фактор уже не мешает: забыть устройства и оставить
-- его работать ещё до тридцати суток значит не сделать ничего.
DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2;

-- name: CreatePasswordResetToken :exec
-- Кладёт одноразовый токен сброса (в БД — только SHA-256 сырого токена).
INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
VALUES ($1, $2, $3);

-- name: ConsumePasswordResetToken :one
-- Атомарно потребляет токен: помечает использованным и возвращает user_id ровно
-- при условии «не использован и не истёк». Одним UPDATE, а не SELECT+UPDATE, —
-- второе использование той же ссылки (гонка, двойной клик) получает 0 строк.
UPDATE password_reset_tokens
SET used_at = now()
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING user_id;

-- name: DeleteExpiredPasswordResetTokens :execrows
-- Фоновая чистка истёкших токенов (использованные тоже истекают за 30 минут).
DELETE FROM password_reset_tokens WHERE expires_at <= now();

-- name: CreateEmailVerificationToken :exec
-- Кладёт одноразовый токен подтверждения email (в БД — только SHA-256).
INSERT INTO email_verification_tokens (token_hash, user_id, expires_at)
VALUES ($1, $2, $3);

-- name: ConsumeEmailVerificationToken :one
-- Атомарно потребляет токен подтверждения (по образцу ConsumePasswordResetToken):
-- помечает использованным и возвращает user_id при «не использован и не истёк».
UPDATE email_verification_tokens
SET used_at = now()
WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
RETURNING user_id;

-- name: MarkEmailVerified :exec
-- Проставляет отметку подтверждения. Идемпотентно по смыслу: повторное
-- подтверждение просто переставит время (но токен одноразовый — не дойдёт).
UPDATE users SET email_verified_at = now() WHERE id = $1;

-- name: DeleteExpiredEmailVerificationTokens :execrows
-- Фоновая чистка истёкших токенов подтверждения (использованные истекают за 24 часа).
DELETE FROM email_verification_tokens WHERE expires_at <= now();

-- name: SetTwoFactorEnabled :exec
-- Включение и выключение второго фактора (код на почту, 0056). Отдельного
-- состояния «настройка начата» больше нет: настраивать нечего, адрес у аккаунта
-- уже есть.
UPDATE users SET two_factor_enabled = $2 WHERE id = $1;

-- name: UpsertLoginCode :exec
-- Активный код на аккаунт ровно один: новый запрос переписывает строку и
-- обнуляет счётчик попыток. Иначе «отправить ещё раз» копило бы валидные коды
-- в чужом ящике.
INSERT INTO login_codes (user_id, code_hash, expires_at) VALUES ($1, $2, $3)
ON CONFLICT (user_id) DO UPDATE
SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = now();

-- name: ConsumeLoginCodeAttempt :one
-- Списывает попытку и отдаёт хеш для сверки — ОДНИМ запросом и ДО сверки.
--
-- Мина: порядок обязателен именно такой. Сверять первым значило бы, что верный
-- код обходит исчерпанный счётчик, и перебор стоил бы ровно столько же, сколько
-- без счётчика. Тот же приём, что у пароля формы (ARCHITECTURE §10).
--
-- Ноль строк — кода нет, он просрочен или попытки кончились; снаружи это один
-- ответ, потому что различать их значит рассказывать перебирающему, где он
-- оказался ближе.
UPDATE login_codes SET attempts = attempts + 1
WHERE user_id = $1 AND attempts < $2 AND expires_at > now()
RETURNING code_hash;

-- name: DeleteLoginCode :exec
DELETE FROM login_codes WHERE user_id = $1;

-- name: DeleteExpiredLoginCodes :execrows
DELETE FROM login_codes WHERE expires_at <= now();

-- name: CreateKnownDevice :exec
-- Строка заводится ТОЛЬКО после принятого кода. Конфликт по паре
-- «токен + аккаунт» — тот же браузер входит повторно после того, как его
-- знакомство истекло: продлеваем, а не заводим вторую строку.
INSERT INTO known_devices (id, user_id, token_hash, label, expires_at)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (token_hash, user_id) DO UPDATE
SET label = EXCLUDED.label, expires_at = EXCLUDED.expires_at, last_seen_at = now();

-- name: TouchKnownDevice :execrows
-- «Знаком ли этот браузер аккаунту» и «отметить, что заходил» — один запрос:
-- ноль строк означает незнакомое устройство, и второй ходки за ответом не
-- нужно. Просроченное знакомство не считается: expires_at проверяется здесь,
-- а не уборщиком, — уборщик только чистит место.
UPDATE known_devices SET last_seen_at = now()
WHERE token_hash = $1 AND user_id = $2 AND expires_at > now();

-- name: ListKnownDevices :many
-- token_hash в выдаче нужен экрану настроек, чтобы пометить текущее устройство
-- (сервис сравнивает его с хешем cookie); наружу он не отдаётся.
SELECT id, token_hash, label, created_at, last_seen_at
FROM known_devices
WHERE user_id = $1 AND expires_at > now()
ORDER BY last_seen_at DESC;

-- name: DeleteKnownDevice :execrows
-- user_id в условии — не лишний: id из URL не является доказательством права
-- на строку.
DELETE FROM known_devices WHERE id = $1 AND user_id = $2;

-- name: DeleteKnownDevicesByUser :exec
DELETE FROM known_devices WHERE user_id = $1;

-- name: DeleteExpiredKnownDevices :execrows
DELETE FROM known_devices WHERE expires_at <= now();

-- name: MarkUserDeleted :execrows
-- Удаление аккаунта пометкой (фаза 23, слайс G). Условие deleted_at IS NULL —
-- не осторожность, а идемпотентность: повторный вызов (две вкладки) даёт ноль
-- строк, а не переставляет дату удаления на новую.
UPDATE users SET deleted_at = now()
WHERE id = $1 AND deleted_at IS NULL;

-- name: MarkSignupCompleted :exec
-- Отметка о завершении регистрации (0071). Ставится той же транзакцией, что и первое
-- принятие соглашения (internal/legal); уже стоящую не двигает.
UPDATE users SET signup_completed_at = now()
WHERE id = $1 AND signup_completed_at IS NULL;

-- name: GetSignupProfile :one
-- Анкета аккаунта для страницы «Аккаунт»: человек правит и очищает то, что указал при
-- регистрации (ст. 14 152-ФЗ — право на уточнение своих данных).
SELECT kind, purpose, referral, full_name, occupation, profession, company_name, industry, job_position
FROM signup_profiles
WHERE user_id = $1;

-- name: UpsertSignupProfile :exec
-- Анкета регистрации: повторная отправка перезаписывает ответы целиком.
INSERT INTO signup_profiles (user_id, kind, purpose, referral, full_name, occupation, profession, company_name, industry, job_position)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (user_id) DO UPDATE
SET kind = EXCLUDED.kind, purpose = EXCLUDED.purpose, referral = EXCLUDED.referral,
    full_name = EXCLUDED.full_name, occupation = EXCLUDED.occupation, profession = EXCLUDED.profession,
    company_name = EXCLUDED.company_name, industry = EXCLUDED.industry, job_position = EXCLUDED.job_position,
    updated_at = now();

-- name: DeleteAbandonedSignups :execrows
-- Незавершённые регистрации старше срока — удалением строки, а не пометкой deleted_at:
-- users.email уникален, и пометка держала бы адрес занятым навсегда. Каскад уносит личное
-- пространство, подписку, привязки и сессии. consent_events ссылается на users с RESTRICT:
-- событие у незавершённой регистрации — нарушение инварианта «первое принятие ставит
-- отметку», и тогда запрос падает, а не удаляет доказательство.
DELETE FROM users
WHERE signup_completed_at IS NULL AND created_at < $1;
