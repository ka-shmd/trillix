-- Откат 0006: убрать внутреннее имя формы (дашборд снова показывает title).
ALTER TABLE forms DROP COLUMN name;
