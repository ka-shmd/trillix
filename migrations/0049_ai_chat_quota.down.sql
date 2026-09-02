-- Откат возвращает числа «одна генерация = одна форма» (0048).
UPDATE plans SET limits = jsonb_set(limits, '{ai_generations}', '100'::jsonb);
UPDATE plans SET limits = jsonb_set(limits, '{ai_generations}', '10'::jsonb)
 WHERE code IN ('free', 'legacy_free');
