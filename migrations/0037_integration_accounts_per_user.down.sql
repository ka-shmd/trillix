-- Откат 0037: подключение возвращается ПРОСТРАНСТВУ.
--
-- ⚠ Откат неполон по существу, а не по недосмотру: после 0037 подключение
-- пространства не помнит, и восстанавливать его нечем. Берём пространство,
-- которым человек ВЛАДЕЕТ, старейшее — для одиночки это ровно его личное, и
-- модель сходится; для участника чужой команды догадка неверна, но других
-- данных в схеме нет. Строки, которым пространство не нашлось, и вторые
-- подключения одного пространства УДАЛЯЮТСЯ: старая уникальность их не
-- вмещает. Отсюда правило migrations/CLAUDE.md — этот цикл не гоняют по
-- dev-базе руками, а make migrate-down спросит подтверждение.

DROP INDEX idx_integration_accounts_user;
ALTER TABLE integration_accounts RENAME COLUMN user_id TO connected_by;
ALTER TABLE integration_accounts
    ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

UPDATE integration_accounts a
   SET workspace_id = (
        SELECT m.workspace_id
          FROM workspace_members m
         WHERE m.user_id = a.connected_by
           AND m.role    = 'owner'
         ORDER BY m.created_at, m.workspace_id
         LIMIT 1
       );

DELETE FROM integration_accounts WHERE workspace_id IS NULL;

DELETE FROM integration_accounts
 WHERE id NOT IN (
        SELECT DISTINCT ON (workspace_id, provider) id
          FROM integration_accounts
         ORDER BY workspace_id, provider, connected_at DESC, id DESC
       );

ALTER TABLE integration_accounts ALTER COLUMN workspace_id SET NOT NULL;
CREATE UNIQUE INDEX idx_integration_accounts_ws ON integration_accounts (workspace_id, provider);
