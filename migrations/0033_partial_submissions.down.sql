-- Откат 0033: частичных ответов снова не существует. УНОСИТ ДАННЫЕ — таблица
-- черновиков удаляется целиком (make migrate-down спросит подтверждение), вместе с
-- тумблерами сбора у форм.
DROP TABLE partial_submissions;
ALTER TABLE forms DROP COLUMN collect_partial;

-- Ключ из планов тоже убираем: план с ключом, которого нет в каталоге, — такая же
-- ошибка конфигурации, как план без известного ключа.
UPDATE plans SET limits = limits - 'submissions_partial';
