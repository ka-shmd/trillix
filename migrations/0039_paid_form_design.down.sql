-- Откат: своё оформление снова открыто всем — состояние после 0019.
UPDATE plans
SET limits = limits || '{"form_design_custom": true}'::jsonb
WHERE code IN ('free', 'legacy_free');
