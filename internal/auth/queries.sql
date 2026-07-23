-- Запросы модуля auth. Схема — migrations/0002_auth. Генерация: `make sqlc`.

-- name: CreateUser :one
INSERT INTO users (id, email, password_hash)
VALUES ($1, $2, $3)
RETURNING id, email, password_hash, created_at;

-- name: GetUserByEmail :one
SELECT id, email, password_hash, created_at
FROM users
WHERE email = $1;

-- name: CreateWorkspace :one
INSERT INTO workspaces (id, name)
VALUES ($1, $2)
RETURNING id, name, created_at;

-- name: CreateWorkspaceMember :exec
INSERT INTO workspace_members (workspace_id, user_id, role)
VALUES ($1, $2, $3);

-- name: CreateSession :exec
INSERT INTO sessions (token_hash, user_id, expires_at)
VALUES ($1, $2, $3);

-- name: GetSessionUser :one
-- Пользователь по живой (не истёкшей) сессии — для RequireAuth и /auth/me.
SELECT u.id, u.email, u.password_hash, u.created_at
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = $1 AND s.expires_at > now();

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = $1;

-- name: DeleteExpiredSessions :execrows
DELETE FROM sessions WHERE expires_at <= now();

-- name: GetUserByIdentity :one
-- Пользователь по привязке к провайдеру (миграция 0009). Ключ — пара
-- (провайдер, идентификатор у провайдера), а не email: адрес у провайдера
-- сменить можно, идентификатор — нет.
SELECT u.id, u.email, u.password_hash, u.created_at
FROM user_identities i
JOIN users u ON u.id = i.user_id
WHERE i.provider = $1 AND i.provider_user_id = $2;

-- name: CreateIdentity :exec
INSERT INTO user_identities (provider, provider_user_id, user_id)
VALUES ($1, $2, $3);

-- name: SetUserPassword :exec
-- Ставит новый argon2id-хеш (сброс пароля). Для provider-only аккаунта переводит
-- password_hash из NULL в значение — так закрывается TD-34 (аккаунт становится
-- достижим паролем, вход через провайдера при этом сохраняется).
UPDATE users SET password_hash = $2 WHERE id = $1;

-- name: DeleteSessionsByUser :exec
-- Рвёт все сессии пользователя — обязательный шаг сброса пароля (кто угодно,
-- знавший старый пароль или укравший сессию, разлогинивается).
DELETE FROM sessions WHERE user_id = $1;

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
