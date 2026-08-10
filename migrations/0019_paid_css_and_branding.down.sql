-- Откат: обе возможности снова открыты всем — состояние после 0018.
UPDATE plans
SET limits = limits || '{"form_custom_css": true, "form_branding": true}'::jsonb
WHERE code IN ('free', 'legacy_free');
