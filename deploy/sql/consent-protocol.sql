-- Протокол согласия: всё, что человек принимал и отзывал, с текстами тех самых редакций —
-- для спора и запроса Роскомнадзора (docs/design/signup-consent.md §3.5). Только чтение.
-- Запуск на сервере — deploy/README.md, «Протокол согласия». Адрес — переменная psql :email.
-- Запрос исполняет интеграционный тест internal/legal (consent_protocol_integration_test.go):
-- правка схемы, ломающая протокол, краснеет там, а не в день спора.

-- События журнала — по адресу аккаунта или по адресу на момент события.
SELECT e.created_at    AS "когда",
       e.action        AS "действие",
       e.source        AS "где",
       e.checkbox_text AS "подпись галочки",
       e.email         AS "адрес в событии",
       e.user_agent    AS "браузер",
       d.kind          AS "документ",
       d.version       AS "редакция"
FROM consent_events e
JOIN legal_documents d ON d.id = e.document_id
JOIN users u ON u.id = e.user_id
WHERE u.email = lower(:'email') OR e.email = lower(:'email')
ORDER BY e.created_at, e.id;

-- Тексты редакций, с которыми человек соглашался, и сверка отпечатка: false в «текст цел»
-- значит, что тело редакции в базе правили мимо API.
SELECT DISTINCT d.kind         AS "документ",
                d.version      AS "редакция",
                d.effective_at AS "действует с",
                d.sha256       AS "отпечаток",
                encode(sha256(convert_to(d.body, 'UTF8')), 'hex') = d.sha256 AS "текст цел",
                d.body         AS "текст"
FROM consent_events e
JOIN legal_documents d ON d.id = e.document_id
JOIN users u ON u.id = e.user_id
WHERE u.email = lower(:'email') OR e.email = lower(:'email')
ORDER BY d.kind, d.version;
