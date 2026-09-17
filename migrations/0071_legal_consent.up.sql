-- 0071: документы Trillix, журнал согласий, анкета регистрации и отметка о завершении
-- регистрации (docs/design/signup-consent.md).

-- Редакции собственных документов сервиса. Строка на редакцию; опубликованная (draft =
-- false) не меняется — сверку с файлом в репозитории делает API при старте. Черновик
-- перезаписывается из файла, пока его не опубликовали.
CREATE TABLE legal_documents (
    id                    UUID PRIMARY KEY,
    kind                  TEXT NOT NULL CHECK (kind IN ('terms', 'privacy', 'marketing')),
    -- Дата редакции: она же имя файла и значение ?version= публичной ручки.
    version               TEXT NOT NULL CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
    title                 TEXT NOT NULL,
    body                  TEXT NOT NULL,
    -- SHA-256 тела в hex: сверка с файлом и отпечаток в протоколе для спора.
    sha256                TEXT NOT NULL,
    effective_at          TIMESTAMPTZ NOT NULL,
    requires_reacceptance BOOLEAN NOT NULL,
    draft                 BOOLEAN NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kind, version)
);

-- Журнал согласий: только добавление. Текущее состояние — последнее событие по виду
-- документа.
CREATE TABLE consent_events (
    id            UUID PRIMARY KEY,
    -- RESTRICT, а не CASCADE: удаление аккаунта не должно молча унести доказательство
    -- согласия (спека §3.5). Незавершённые регистрации, которые чистит API, событий не
    -- имеют.
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    document_id   UUID NOT NULL REFERENCES legal_documents(id) ON DELETE RESTRICT,
    action        TEXT NOT NULL CHECK (action IN ('accepted', 'withdrawn')),
    source        TEXT NOT NULL CHECK (source IN
        ('signup_password', 'signup_yandex', 'update_screen', 'settings', 'seed')),
    -- Подпись галочки (или тумблера), как её видел человек.
    checkbox_text TEXT NOT NULL,
    -- Адрес аккаунта на момент события.
    email         TEXT NOT NULL,
    user_agent    TEXT NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Гейт и история: события человека, свежие первыми.
CREATE INDEX idx_consent_events_user ON consent_events (user_id, created_at DESC);

-- Анкета при регистрации. Каждый ответ необязателен.
CREATE TABLE signup_profiles (
    user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT CHECK (kind IN ('person', 'company')),
    purpose    TEXT CHECK (purpose IN
        ('research', 'leads', 'events', 'booking', 'feedback', 'quizzes', 'other')),
    referral   TEXT CHECK (referral IN
        ('search', 'ads', 'social', 'recommendation', 'article', 'other')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NULL — регистрация не завершена: условия ни разу не приняты. Существующим аккаунтам
-- отметка ставится датой создания: они зарегистрированы по прежним правилам, и очистка
-- незавершённых регистраций их не касается. Согласий им не записывается — условия они
-- примут на экране новой редакции.
ALTER TABLE users ADD COLUMN signup_completed_at TIMESTAMPTZ;
UPDATE users SET signup_completed_at = created_at;
