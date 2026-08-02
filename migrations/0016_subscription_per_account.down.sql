-- Откат 0016: подписка возвращается на воркспейс.
--
-- Восстанавливается ровно то состояние, из которого up умеет собрать себя снова:
-- workspace_id берётся из личного пространства владельца. Строки подписок,
-- удалённые в up как сиротские, обратно не воскресают — они не описывали ничьих
-- денег (TD-53), а их воркспейсы недостижимы.
UPDATE workspaces SET name = 'Personal' WHERE name = 'Личное пространство';

ALTER TABLE subscriptions
    ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE subscriptions s
   SET workspace_id = w.id
  FROM workspaces w
 WHERE w.personal_user_id = s.user_id;

-- Подписка аккаунта без личного пространства невосстановима как воркспейс-строка:
-- такого состояния 0014 не знала, и переносить его некуда.
DELETE FROM subscriptions WHERE workspace_id IS NULL;

ALTER TABLE subscriptions ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_pkey;
ALTER TABLE subscriptions DROP COLUMN user_id;
ALTER TABLE subscriptions ADD PRIMARY KEY (workspace_id);

DROP INDEX idx_workspace_members_owner;

DROP INDEX idx_workspaces_personal_user;
ALTER TABLE workspaces DROP COLUMN personal_user_id;
