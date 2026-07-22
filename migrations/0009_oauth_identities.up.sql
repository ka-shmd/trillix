-- 0009: вход через внешних провайдеров — Яндекс ID и VK ID (фаза 11, шаг 2).
-- Решения и отвергнутые альтернативы — docs/ARCHITECTURE.md §10 (ADR).

-- Пароль перестаёт быть обязательным: у аккаунта, заведённого через провайдера,
-- его нет вовсе. Вход по паролю при этом остаётся равноправным способом —
-- password_hash IS NULL означает ровно «войти паролем нельзя», а не «аккаунт
-- неполноценный».
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Отдельная таблица, а не колонки yandex_id/vk_id в users: к одному аккаунту
-- привязываются оба провайдера сразу, и добавление третьего не требует миграции
-- users. users.email остаётся UNIQUE — аккаунт на адрес один, способов входа
-- в него несколько.
--
-- PK по паре (provider, provider_user_id): один и тот же аккаунт у провайдера
-- не может вести в два разных аккаунта у нас. Идентификатор хранится как TEXT:
-- у Яндекса это строка, у VK — число, общего типа нет и приводить к BIGINT
-- значит закладываться на формат конкретных провайдеров.
CREATE TABLE user_identities (
    provider         TEXT NOT NULL,   -- yandex | vk
    provider_user_id TEXT NOT NULL,   -- идентификатор аккаунта у провайдера
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_user_id)
);

-- Обратное направление: «какие способы входа есть у этого пользователя» —
-- нужно экрану аккаунта и проверке «остался ли хоть один способ войти».
CREATE INDEX idx_user_identities_user ON user_identities (user_id);
