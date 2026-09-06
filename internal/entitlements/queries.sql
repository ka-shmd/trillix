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
--
-- ИСТОЧНИКОВ РАСХОДА ДВА, и это не дубль: ответы копятся в workspace_usage (объём
-- принадлежит пространству), сообщения ассистенту — в account_usage через того же
-- владельца (0053, ADR §10). Второй LEFT JOIN идёт по уже посчитанному o.user_id,
-- то есть стоит одно обращение по первичному ключу.

-- Состояние тарифа воркспейса на период — ОДНОЙ поездкой: запрос стоит на
-- горячем пути приёма ответа, и делить его на «план» и «расход» значило бы
-- удвоить эту цену. LEFT JOIN — расхода за период может ещё не быть (первый
-- ответ месяца); coalesce делает «строки нет» и «ноль» одним случаем.
-- name: GetEntitlements :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used,
       coalesce(au.ai_generations, 0)::bigint AS ai_generations_used
FROM workspace_members o
JOIN subscriptions s ON s.user_id = o.user_id
JOIN plans p ON p.code = s.plan_code
LEFT JOIN workspace_usage u
       ON u.workspace_id = o.workspace_id AND u.period = $2
LEFT JOIN account_usage au
       ON au.user_id = o.user_id AND au.period = $2
WHERE o.workspace_id = $1 AND o.role = 'owner';

-- То же состояние, но для КАБИНЕТА: доступ обеспечивает сам запрос — JOIN по
-- членству СПРАШИВАЮЩЕГО (инвариант 1: id воркспейса из URL правом доступа не
-- является). Не член → 0 строк → 404, существование чужого воркспейса не
-- раскрывается. Расход ОТВЕТОВ считается на воркспейс: объём принадлежит
-- пространству, и умножить его лимит несколькими пространствами нельзя — на Pro
-- лимита ответов нет вовсе. Расход АССИСТЕНТА считается на аккаунт (0053): там
-- лимит конечен на обоих планах, и воркспейсный счётчик умножал его кнопкой
-- «Новое пространство» — ADR §10.
-- Счётчик участников входит СЮДА, но не в GetEntitlements: снимок рисуется раз
-- на открытие страницы тарифа, а GetEntitlements стоит на горячем пути приёма
-- ответа. Без него страница показывала бы «Участников 0 из N» при полном
-- пространстве — цифра противоречила бы отказу на кнопке «Пригласить».
-- name: GetEntitlementsForUser :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used,
       coalesce(au.ai_generations, 0)::bigint AS ai_generations_used,
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
LEFT JOIN account_usage au
       ON au.user_id = o.user_id AND au.period = $2
WHERE o.workspace_id = $1 AND o.role = 'owner';

-- Состояние тарифа АККАУНТА: план человека и оба его собственных счётчика.
--
-- Счётчики здесь разной природы, и это видно по способу счёта. «Сколько
-- пространств держу» — число строк владения ЗДЕСЬ И СЕЙЧАС (подзапрос), периода у
-- него нет: удалил пространство — место освободилось. «Сколько сообщений
-- израсходовал» — накопленное ЗА ПЕРИОД (account_usage), обнуляется первым числом.
-- Запрос обслуживает и CheckAccount, и снимок страницы тарифа: лишний LEFT JOIN
-- по первичному ключу дешевле второго почти такого же запроса (TD-68).
-- name: GetAccountEntitlements :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(au.ai_generations, 0)::bigint AS ai_generations_used,
       (SELECT count(*) FROM workspace_members m
         WHERE m.user_id = s.user_id AND m.role = 'owner')::bigint AS workspaces_owned
FROM subscriptions s
JOIN plans p ON p.code = s.plan_code
LEFT JOIN account_usage au ON au.user_id = s.user_id AND au.period = $2
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
       coalesce(au.ai_generations, 0)::bigint AS ai_generations_used,
       (SELECT count(*) FROM workspace_members m
          JOIN users mu ON mu.id = m.user_id AND mu.deleted_at IS NULL
         WHERE m.workspace_id = o.workspace_id)::bigint AS members_count
FROM workspace_members o
JOIN subscriptions s ON s.user_id = o.user_id
JOIN plans p ON p.code = s.plan_code
LEFT JOIN workspace_usage u
       ON u.workspace_id = o.workspace_id AND u.period = $2
LEFT JOIN account_usage au
       ON au.user_id = o.user_id AND au.period = $2
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
       coalesce(au.ai_generations, 0)::bigint AS ai_generations_used,
       (SELECT coalesce(sum(f.size_bytes), 0) FROM submission_files f
         WHERE f.workspace_id = o.workspace_id)::bigint AS storage_used
FROM workspace_members o
JOIN subscriptions s ON s.user_id = o.user_id
JOIN plans p ON p.code = s.plan_code
LEFT JOIN workspace_usage u
       ON u.workspace_id = o.workspace_id AND u.period = $2
LEFT JOIN account_usage au
       ON au.user_id = o.user_id AND au.period = $2
WHERE o.workspace_id = $1 AND o.role = 'owner';

-- Списание одного сообщения ассистенту (фаза 26; счётчик переехал на аккаунт в
-- 0053). Отдельным утверждением, а не внутри создания формы: вызов модели может не
-- состояться, и квоту тогда списывать не за что. Период приходит из решения,
-- принятого проверкой (Decision.Period), — иначе на границе месяца проверка и
-- списание разъезжаются по разным строкам.
--
-- Списывается с ВЛАДЕЛЬЦА пространства, а не со спрашивающего: платит владелец, и
-- его же лимит прочитала проверка. Резолв владельца — SELECT'ом внутри того же
-- утверждения, а не вторым запросом: пара «прочитать владельца, потом списать»
-- разъезжается при передаче владения между ними.
--
-- UPSERT по той же причине, что у ответов: строки периода может ещё не быть, и
-- «создать или увеличить» обязано быть одним утверждением, а не парой чтение-запись.
-- name: BumpAIGenerations :exec
INSERT INTO account_usage (user_id, period, ai_generations)
SELECT o.user_id, $2, 1
  FROM workspace_members o
 WHERE o.workspace_id = $1 AND o.role = 'owner'
ON CONFLICT (user_id, period)
DO UPDATE SET ai_generations = account_usage.ai_generations + 1;

-- То же состояние плюс счётчик расписаний — для гейта записи на время (фаза 27).
-- Отдельным запросом по тому же доводу, что счётчики участников и хранилища: он
-- нужен одной редкой операции (заведению расписания) и не должен ложиться на приём
-- ответа.
-- name: GetEntitlementsWithSchedules :one
SELECT p.code AS plan_code,
       p.title AS plan_title,
       p.limits,
       coalesce(u.submissions, 0)::bigint AS submissions_used,
       coalesce(au.ai_generations, 0)::bigint AS ai_generations_used,
       (SELECT count(*) FROM schedules sc
         WHERE sc.workspace_id = o.workspace_id)::bigint AS schedules_count
FROM workspace_members o
JOIN subscriptions s ON s.user_id = o.user_id
JOIN plans p ON p.code = s.plan_code
LEFT JOIN workspace_usage u
       ON u.workspace_id = o.workspace_id AND u.period = $2
LEFT JOIN account_usage au
       ON au.user_id = o.user_id AND au.period = $2
WHERE o.workspace_id = $1 AND o.role = 'owner';

-- Расход воркспейс-квот по КАЖДОМУ пространству аккаунта — для аккаунтной страницы
-- тарифа (ADR §10, 2026-09-06). Ответы, места, файлы и расписания принадлежат
-- пространству и на аккаунт не сводятся, поэтому страница показывает их строкой на
-- пространство, а не прячет.
--
-- Берутся только пространства, которыми аккаунт ВЛАДЕЕТ: тариф видит владелец
-- (`billing.view` в матрице ролей), и членство в чужом пространстве права смотреть
-- чужой план не даёт. Право обеспечивает сам запрос — id спрашивающего стоит в
-- WHERE, а не проверяется отдельно (тот же приём, что у GetEntitlementsForUser).
--
-- Подзапросов три на строку, и это осознанно: страница открывается редко и одним
-- запросом, а альтернатива — четыре поездки на пространство (N+1).
--
-- Личное пространство идёт первым: оно есть у всех и не удаляется, поэтому служит
-- якорем списка. Дальше — по времени создания, тай-брейк по id ради устойчивости.
-- name: ListOwnedWorkspaceUsage :many
SELECT w.id,
       w.slug,
       w.name,
       (w.personal_user_id IS NOT NULL)::boolean AS is_personal,
       coalesce(u.submissions, 0)::bigint AS submissions_used,
       (SELECT count(*) FROM workspace_members m
          JOIN users mu ON mu.id = m.user_id AND mu.deleted_at IS NULL
         WHERE m.workspace_id = w.id)::bigint AS members_count,
       (SELECT coalesce(sum(f.size_bytes), 0) FROM submission_files f
         WHERE f.workspace_id = w.id)::bigint AS storage_used,
       (SELECT count(*) FROM schedules sc
         WHERE sc.workspace_id = w.id)::bigint AS schedules_count
FROM workspace_members o
JOIN workspaces w ON w.id = o.workspace_id
LEFT JOIN workspace_usage u
       ON u.workspace_id = w.id AND u.period = $2
WHERE o.user_id = $1 AND o.role = 'owner'
ORDER BY w.personal_user_id IS NULL, w.created_at, w.id;
