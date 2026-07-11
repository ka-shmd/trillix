-- Откат 0002: удаляем таблицы в обратном порядке зависимостей (FK).
-- sessions и workspace_members ссылаются на users/workspaces, поэтому уходят первыми.

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS workspace_members;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS users;
