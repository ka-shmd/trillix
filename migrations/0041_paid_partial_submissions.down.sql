-- Откат: сбор незавершённых снова открыт всем — состояние после 0033.
UPDATE plans
SET limits = limits || '{"submissions_partial": true}'::jsonb
WHERE code IN ('free', 'legacy_free');
