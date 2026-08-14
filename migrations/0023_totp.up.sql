-- 0023: второй фактор — TOTP (фаза 23 DEV-PLAN, слайс F). Замысел и отвергнутые
-- альтернативы (в том числе почему не коды на email) — docs/design/account-settings.md §6.

CREATE TABLE user_totp (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- Шифротекст AES-256-GCM (nonce впереди), а не сам секрет: дамп базы не
    -- должен давать возможность генерировать коды. Ключ выводится HKDF от
    -- FORM_TOKEN_SECRET с отдельной меткой — своей env-переменной нет
    -- сознательно, ценой того, что ротация FORM_TOKEN_SECRET обнулит все
    -- включённые вторые факторы (записано в раннбук).
    secret     BYTEA NOT NULL,
    -- NULL = настройка начата, но код ни разу не подтверждён: фактор НЕ включён.
    -- Строка при этом уже есть, потому что секрет показан человеку и он мог
    -- завести его в приложении.
    confirmed_at TIMESTAMPTZ,
    -- Номер временного шага последнего принятого кода. Без него перехваченный
    -- код работает все свои полминуты: повторное предъявление того же кода
    -- отвергается сравнением с этим числом.
    last_step  BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Резервные коды: единственный путь в аккаунт при потерянном телефоне. В БД —
-- SHA-256 (энтропии 80 бит, перебирать нечего; argon2id на каждую из десяти
-- проверок был бы подарком тому, кто ищет, чем занять память сервера).
CREATE TABLE totp_recovery_codes (
    code_hash BYTEA PRIMARY KEY,
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at   TIMESTAMPTZ,  -- NULL = не использован; код одноразовый
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_totp_recovery_codes_user ON totp_recovery_codes (user_id);
