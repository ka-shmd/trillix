-- 0056: второй фактор — код на почту при входе с незнакомого устройства.
-- Отменяет TOTP (0023) целиком: аккаунтов с включённым фактором на проде нет
-- (владелец, 2026-09-08), поэтому переноса данных нет. Замысел и отвергнутые
-- альтернативы — docs/design/two-factor-email.md.

-- Флаг переезжает в users: прежде «фактор включён» означало «есть строка в
-- user_totp с непустым confirmed_at», а у кода на почту хранить на аккаунте
-- нечего, кроме самого флага.
ALTER TABLE users ADD COLUMN two_factor_enabled BOOLEAN NOT NULL DEFAULT false;

-- Активный код на аккаунт РОВНО ОДИН: PK по user_id, новый запрос переписывает
-- строку. Иначе «отправить ещё раз» копило бы валидные коды в чужом ящике.
CREATE TABLE login_codes (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- HMAC-SHA256 кода, ключ выведен из FORM_TOKEN_SECRET. Не голый SHA-256:
    -- шестизначный код это 10^6 вариантов, и обычный хеш по дампу базы
    -- перебирается мгновенно, а ключа HMAC в дампе нет.
    code_hash  BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    -- Попыток на код 5, дальше он сгорает: 10^6 вариантов за десять минут
    -- жизни означают, что без счётчика хватило бы одного темпа.
    attempts   SMALLINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Знакомое устройство = браузер, который уже предъявлял код. Строка на пару
-- «браузер + аккаунт»: токен в cookie один, а записей столько, сколько
-- аккаунтов с этой машины входило, — иначе вход вторым аккаунтом выбивал бы
-- знакомство первого.
CREATE TABLE known_devices (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 случайного токена из cookie, а не сам токен: тот же приём и тот
    -- же довод, что у sessions — утечка дампа не даёт знакомых устройств.
    token_hash BYTEA NOT NULL,
    -- «Chrome на Windows» — разбор User-Agent, чтобы человек узнал строку в
    -- списке. IP не хранится сознательно: персональные данные, а узнать свой
    -- компьютер не помогает.
    label      TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- 180 дней, дольше сессии (30 суток) сознательно: устройство, протухающее
    -- раньше сессии, спрашивало бы код на каждом втором входе со своего же ПК.
    expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE (token_hash, user_id)
);

CREATE INDEX idx_known_devices_user ON known_devices (user_id);

DROP TABLE totp_recovery_codes;
DROP TABLE user_totp;
