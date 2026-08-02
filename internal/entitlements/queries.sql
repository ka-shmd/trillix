-- Запросы модуля entitlements. Схема — migrations/0014_billing и 0016.
-- Генерация: `make sqlc`.
--
-- С 0016 подписка принадлежит АККАУНТУ, а воркспейс работает по плану своего
-- владельца — единственного участника с role='owner' (ADR §10). Отсюда лишний
-- JOIN в обоих запросах: колонки-копии владельца в workspaces нет намеренно, она
-- разъезжалась бы при передаче владения. Цена джойна нулевая — workspace_id
-- является префиксом первичного ключа workspace_members.
--
-- role='owner' здесь — резолв ПЛАТЕЛЬЩИКА, а не решение о доступе: правило
-- «право спрашивается по действию, а не по роли» (internal/CLAUDE.md) касается
-- Go-кода авторизации и этих запросов не затрагивает.

-- Состояние тарифа воркспейса на период — ОДНОЙ поездкой: запрос стоит на
-- горячем пути приёма ответа, и делить его на «план» и «расход» значило бы
-- удвоить эту цену. LEFT JOIN — расхода за период может ещё не быть (первый
-- ответ месяца); coalesce делает «строки нет» и «ноль» одним случаем.
-- name: GetEntitlements :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used
FROM workspace_members o
JOIN subscriptions s ON s.user_id = o.user_id
JOIN plans p ON p.code = s.plan_code
LEFT JOIN workspace_usage u
       ON u.workspace_id = o.workspace_id AND u.period = $2
WHERE o.workspace_id = $1 AND o.role = 'owner';

-- То же состояние, но для КАБИНЕТА: доступ обеспечивает сам запрос — JOIN по
-- членству СПРАШИВАЮЩЕГО (инвариант 1: id воркспейса из URL правом доступа не
-- является). Не член → 0 строк → 404, существование чужого воркспейса не
-- раскрывается. Расход по-прежнему считается на воркспейс, а не на аккаунт:
-- умножить лимит несколькими пространствами нельзя (на Pro лимита ответов нет,
-- на Free воркспейс ровно один) — ADR §10.
-- name: GetEntitlementsForUser :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used
FROM workspace_members o
JOIN subscriptions s ON s.user_id = o.user_id
JOIN plans p ON p.code = s.plan_code
JOIN workspace_members me ON me.workspace_id = o.workspace_id AND me.user_id = $3
LEFT JOIN workspace_usage u
       ON u.workspace_id = o.workspace_id AND u.period = $2
WHERE o.workspace_id = $1 AND o.role = 'owner';

-- Состояние тарифа АККАУНТА: то, у чего нет воркспейса-владельца, потому что
-- воркспейса ещё нет (единственный такой ключ сегодня — сколько пространств
-- можно завести). Расход считается здесь же подзапросом: «сколько уже держу» —
-- это число строк владения, а не накопленное за период, поэтому workspace_usage
-- в этом запросе не участвует вовсе.
-- name: GetAccountEntitlements :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       (SELECT count(*) FROM workspace_members m
         WHERE m.user_id = s.user_id AND m.role = 'owner')::bigint AS workspaces_owned
FROM subscriptions s
JOIN plans p ON p.code = s.plan_code
WHERE s.user_id = $1;
