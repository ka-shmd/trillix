-- Запросы модуля integrations. Схема — migrations/0029_integrations. Генерация: `make sqlc`.

-- name: UpsertIntegrationAccount :exec
-- Подключение аккаунта. Повторное подключение (сменил аккаунт Google, отозвал
-- доступ, переподключается после ротации ключа) ЗАМЕНЯЕТ строку, а не плодит
-- вторую: одно подключение на провайдера в пространстве — рамка MVP, и она же
-- уникальный индекс, служащий здесь арбитром ON CONFLICT.
INSERT INTO integration_accounts (
    id, workspace_id, provider, external_account_id, external_email, refresh_token, scopes, connected_by
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (workspace_id, provider) DO UPDATE SET
    external_account_id = EXCLUDED.external_account_id,
    external_email      = EXCLUDED.external_email,
    refresh_token       = EXCLUDED.refresh_token,
    scopes              = EXCLUDED.scopes,
    connected_by        = EXCLUDED.connected_by,
    connected_at        = now();

-- name: GetIntegrationAccount :one
-- Подключение пространства. refresh_token едет шифротекстом и наружу модуля не
-- выходит: расшифровывает его только сервис, и только чтобы сходить к провайдеру.
SELECT id, workspace_id, provider, external_account_id, external_email, refresh_token, scopes, connected_by, connected_at
FROM integration_accounts
WHERE workspace_id = $1 AND provider = $2;

-- name: DeleteIntegrationAccount :one
-- Отключение. RETURNING отдаёт токен на отзыв у провайдера: прочитать его
-- отдельным запросом ДО удаления значит открыть окно, в котором строка уже
-- прочитана, но ещё жива. Формы, привязанные к этому аккаунту, уносит каскад.
DELETE FROM integration_accounts
WHERE workspace_id = $1 AND provider = $2
RETURNING refresh_token;
