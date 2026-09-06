-- Откат возвращает счётчик в workspace_usage. Разложить аккаунтный расход обратно
-- по пространствам нечем — деления в данных больше нет, — поэтому он целиком
-- кладётся в ЛИЧНОЕ пространство владельца: единственное, которое у аккаунта есть
-- всегда. Аккаунт без личного пространства (сирота, TD-53) теряет расход; откат —
-- не способ хранения (тот же довод, что у 0048).
ALTER TABLE workspace_usage ADD COLUMN ai_generations BIGINT NOT NULL DEFAULT 0
    CHECK (ai_generations >= 0);

INSERT INTO workspace_usage (workspace_id, period, ai_generations)
SELECT w.id, a.period, a.ai_generations
  FROM account_usage a
  JOIN workspaces w ON w.personal_user_id = a.user_id
    ON CONFLICT (workspace_id, period)
    DO UPDATE SET ai_generations = EXCLUDED.ai_generations;

DROP TABLE account_usage;
