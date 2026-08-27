-- 0037: подключение внешнего аккаунта переезжает с ПРОСТРАНСТВА на ЧЕЛОВЕКА
-- (ADR §10, решение владельца 2026-08-27; отменяет строку «подключение
-- принадлежит ПРОСТРАНСТВУ» из 0029).
--
-- Прежняя рамка «одно подключение на провайдера в пространстве» была не
-- ограничением, а дефектом: повторное подключение переписывало ТУ ЖЕ строку по
-- ON CONFLICT (workspace_id, provider), сохраняя её id, — все связки
-- пространства продолжали на неё ссылаться, считались рабочими и начинали
-- писать чужим токеном в таблицы, которых он не видит (scope drive.file), то
-- есть получали 404 и краснели разом.

-- 1. Схлопнуть дубли ДО смены уникальности.
--
-- Сегодня один человек, подключивший ТОТ ЖЕ аккаунт Google к двум
-- пространствам, лежит двумя строками; под новой уникальностью это одна.
-- Выживает свежайшая по connected_at. Связки переезжают на неё ПЕРВЫМИ: удали
-- мы проигравшие строки раньше, каскад FK account_id унёс бы связки вместе с
-- ними — то есть молча отключил бы живые интеграции.
UPDATE form_integrations fi
   SET account_id = w.id
  FROM integration_accounts a
  JOIN (
        SELECT DISTINCT ON (connected_by, provider, external_account_id)
               id, connected_by, provider, external_account_id
          FROM integration_accounts
         ORDER BY connected_by, provider, external_account_id, connected_at DESC, id DESC
       ) w
    ON w.connected_by        = a.connected_by
   AND w.provider            = a.provider
   AND w.external_account_id = a.external_account_id
 WHERE fi.account_id = a.id
   AND fi.account_id <> w.id;

DELETE FROM integration_accounts
 WHERE id NOT IN (
        SELECT DISTINCT ON (connected_by, provider, external_account_id) id
          FROM integration_accounts
         ORDER BY connected_by, provider, external_account_id, connected_at DESC, id DESC
       );

-- 2. Сменить владение.
--
-- connected_by переименовывается, а не дублируется новой колонкой: это ОДИН
-- факт — чьё согласие открыло доступ. Он же ключ владения, он же запись аудита
-- 152-ФЗ, он же правило «ушёл человек — ушло подключение» (FK ON DELETE CASCADE
-- на users переезжает вместе с колонкой и остаётся в силе).
DROP INDEX idx_integration_accounts_ws;
ALTER TABLE integration_accounts DROP COLUMN workspace_id;
ALTER TABLE integration_accounts RENAME COLUMN connected_by TO user_id;

-- Уникальность по ВНЕШНЕМУ аккаунту, а не по провайдеру: аккаунтов Google у
-- человека сколько угодно (личный Диск и рабочий), но повторный заход тем же
-- аккаунтом обязан обновить строку, а не завести вторую с тем же Диском. Он же
-- арбитр ON CONFLICT при переподключении.
CREATE UNIQUE INDEX idx_integration_accounts_user
    ON integration_accounts (user_id, provider, external_account_id);
