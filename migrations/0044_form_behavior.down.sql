-- Откат снимает обе колонки: форма снова листается только кнопкой, а ответы живут в
-- sessionStorage (переживают перезагрузку, но не закрытие вкладки) — поведение до 0044.
ALTER TABLE forms
    DROP COLUMN auto_jump,
    DROP COLUMN save_locally;
