-- Запросы модуля entitlements. Схема — migrations/0014_billing. Генерация: `make sqlc`.

-- Состояние тарифа воркспейса на период — ОДНОЙ поездкой: запрос стоит на
-- горячем пути приёма ответа, и делить его на «план» и «расход» значило бы
-- удвоить эту цену. LEFT JOIN — расхода за период может ещё не быть (первый
-- ответ месяца); coalesce делает «строки нет» и «ноль» одним случаем.
-- name: GetEntitlements :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used
FROM subscriptions s
JOIN plans p ON p.code = s.plan_code
LEFT JOIN workspace_usage u
       ON u.workspace_id = s.workspace_id AND u.period = $2
WHERE s.workspace_id = $1;
