-- Откат снимает счётчик расхода и ключ квоты. Накопленный расход теряется: это
-- осознанно, откат — не способ хранения (тот же довод, что у 0010).
UPDATE plans SET limits = limits - 'ai_generations';
ALTER TABLE workspace_usage DROP COLUMN ai_generations;
