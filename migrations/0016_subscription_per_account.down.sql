-- Откат 0016. Данные не теряются: обе колонки — производные от того, что уже
-- лежит в workspace_members и subscriptions.workspace_id.
UPDATE workspaces SET name = 'Personal' WHERE name = 'Личное пространство';

DROP INDEX idx_subscriptions_user;
ALTER TABLE subscriptions DROP COLUMN user_id;

DROP INDEX idx_workspace_members_owner;

DROP INDEX idx_workspaces_personal_user;
ALTER TABLE workspaces DROP COLUMN personal_user_id;
