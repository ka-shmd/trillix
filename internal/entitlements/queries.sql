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
       coalesce(u.submissions, 0)::bigint AS submissions_used,
       coalesce(u.ai_generations, 0)::bigint AS ai_generations_used
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
-- Счётчик участников входит СЮДА, но не в GetEntitlements: снимок рисуется раз
-- на открытие страницы тарифа, а GetEntitlements стоит на горячем пути приёма
-- ответа. Без него страница показывала бы «Участников 0 из N» при полном
-- пространстве — цифра противоречила бы отказу на кнопке «Пригласить».
-- name: GetEntitlementsForUser :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used,
       coalesce(u.ai_generations, 0)::bigint AS ai_generations_used,
       (SELECT count(*) FROM workspace_members mm
          JOIN users mu ON mu.id = mm.user_id AND mu.deleted_at IS NULL
         WHERE mm.workspace_id = o.workspace_id)::bigint AS members_count,
       (SELECT coalesce(sum(f.size_bytes), 0) FROM submission_files f
         WHERE f.workspace_id = o.workspace_id)::bigint AS storage_used
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

-- То же состояние плюс счётчик участников — для гейта мест. Отдельным запросом,
-- а не колонкой в GetEntitlements: тот стоит на горячем пути приёма ответа, и
-- подсчёт участников был бы там платой за то, что нужно одному редкому
-- действию — приглашению.
-- name: GetEntitlementsWithMembers :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used,
       coalesce(u.ai_generations, 0)::bigint AS ai_generations_used,
       (SELECT count(*) FROM workspace_members m
          JOIN users mu ON mu.id = m.user_id AND mu.deleted_at IS NULL
         WHERE m.workspace_id = o.workspace_id)::bigint AS members_count
FROM workspace_members o
JOIN subscriptions s ON s.user_id = o.user_id
JOIN plans p ON p.code = s.plan_code
LEFT JOIN workspace_usage u
       ON u.workspace_id = o.workspace_id AND u.period = $2
WHERE o.workspace_id = $1 AND o.role = 'owner';

-- То же состояние плюс расход хранилища — для гейта файлов (фаза 24). Отдельным
-- запросом по тому же доводу, что и счётчик участников: сумма по submission_files
-- нужна одной операции (выдаче подписи на загрузку) и не должна ложиться на приём
-- ответа.
--
-- Считаются ВСЕ строки, включая незаявленные. Место занято с момента выдачи слота:
-- байты уже лежат в бакете и уже стоят денег, а «не состоится» разрешает чистка
-- сирот — она вернёт место в течение суток. Считать только заявленные значило бы
-- не ограничивать того, кто грузит и не отправляет, — то есть ровно того, от кого
-- квота и защищает.
-- name: GetEntitlementsWithStorage :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used,
       coalesce(u.ai_generations, 0)::bigint AS ai_generations_used,
       (SELECT coalesce(sum(f.size_bytes), 0) FROM submission_files f
         WHERE f.workspace_id = o.workspace_id)::bigint AS storage_used
FROM workspace_members o
JOIN subscriptions s ON s.user_id = o.user_id
JOIN plans p ON p.code = s.plan_code
LEFT JOIN workspace_usage u
       ON u.workspace_id = o.workspace_id AND u.period = $2
WHERE o.workspace_id = $1 AND o.role = 'owner';

-- Списание одной генерации формы (фаза 26). Отдельным утверждением, а не внутри
-- создания формы: вызов модели может не состояться, и квоту тогда списывать не за
-- что. Период приходит из решения, принятого проверкой (Decision.Period), — иначе
-- на границе месяца проверка и списание разъезжаются по разным строкам.
--
-- UPSERT по той же причине, что у ответов: строки периода может ещё не быть, и
-- «создать или увеличить» обязано быть одним утверждением, а не парой чтение-запись.
-- name: BumpAIGenerations :exec
INSERT INTO workspace_usage (workspace_id, period, ai_generations)
VALUES ($1, $2, 1)
ON CONFLICT (workspace_id, period)
DO UPDATE SET ai_generations = workspace_usage.ai_generations + 1;
