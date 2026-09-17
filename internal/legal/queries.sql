-- Запросы модуля legal. Схема — migrations/0071 (legal_documents).
-- Генерация: `make sqlc`.

-- name: InsertLegalDocument :execrows
-- Заведение редакции при старте API. Уже записанная редакция не трогается: ноль строк
-- означает «есть в базе», и дальше её сверяет сервис.
INSERT INTO legal_documents (id, kind, version, title, body, sha256, effective_at, requires_reacceptance, draft)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (kind, version) DO NOTHING;

-- name: GetLegalDocument :one
SELECT id, kind, version, title, body, sha256, effective_at, requires_reacceptance, draft, created_at
FROM legal_documents
WHERE kind = $1 AND version = $2;

-- name: RewriteDraftLegalDocument :execrows
-- Перезапись черновика из файла. `AND draft` в условии — последний рубеж: опубликованная
-- редакция этим запросом не меняется никогда, что бы ни решил сервис.
UPDATE legal_documents
SET title = $3, body = $4, sha256 = $5, effective_at = $6, requires_reacceptance = $7, draft = $8
WHERE kind = $1 AND version = $2 AND draft;

-- name: ListCurrentLegalDocuments :many
-- Действующая редакция каждого документа: последняя из вступивших в силу. Порядок
-- внутри DISTINCT ON — дата вступления, при равенстве — дата редакции.
SELECT DISTINCT ON (kind) id, kind, version, title, body, sha256, effective_at, requires_reacceptance, draft, created_at
FROM legal_documents
WHERE effective_at <= sqlc.arg(now)
ORDER BY kind, effective_at DESC, version DESC;

-- name: GetCurrentLegalDocument :one
SELECT id, kind, version, title, body, sha256, effective_at, requires_reacceptance, draft, created_at
FROM legal_documents
WHERE kind = sqlc.arg(kind) AND effective_at <= sqlc.arg(now)
ORDER BY effective_at DESC, version DESC
LIMIT 1;

-- name: GetEffectiveLegalDocument :one
-- Редакция по версии — только вступившая в силу: будущая публично не существует.
SELECT id, kind, version, title, body, sha256, effective_at, requires_reacceptance, draft, created_at
FROM legal_documents
WHERE kind = sqlc.arg(kind) AND version = sqlc.arg(version) AND effective_at <= sqlc.arg(now);

-- name: ListLegalDocumentVersions :many
-- Архив редакций документа, свежие первыми.
SELECT version, effective_at
FROM legal_documents
WHERE kind = sqlc.arg(kind) AND effective_at <= sqlc.arg(now)
ORDER BY effective_at DESC, version DESC;

-- name: TermsAcceptanceMissing :one
-- Гейт кабинета (спека §3.2): у человека нет принятия редакции соглашения не старше
-- последней существенной (requires_reacceptance). Существенной ещё не было — годится
-- принятие любой. Ни одна редакция не вступила в силу — гейта нет: принять было бы нечего.
SELECT (
    EXISTS (SELECT 1 FROM legal_documents t WHERE t.kind = 'terms' AND t.effective_at <= sqlc.arg(now))
    AND NOT EXISTS (
        SELECT 1
        FROM consent_events e
        JOIN legal_documents d ON d.id = e.document_id
        WHERE e.user_id = sqlc.arg(user_id)
          AND d.kind = 'terms'
          AND e.action = 'accepted'
          AND d.effective_at >= COALESCE(
              (SELECT max(r.effective_at) FROM legal_documents r
               WHERE r.kind = 'terms' AND r.requires_reacceptance AND r.effective_at <= sqlc.arg(now)),
              '-infinity'::timestamptz)
    )
)::boolean AS missing;

-- name: InsertConsentEvent :exec
INSERT INTO consent_events (id, user_id, document_id, action, source, checkbox_text, email, user_agent)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: LatestConsentEvents :many
-- Последнее событие по каждому виду документа — текущее состояние согласий. id (UUIDv7)
-- разводит события с одинаковым created_at.
SELECT DISTINCT ON (d.kind) d.kind, e.document_id, d.version, e.action, e.created_at
FROM consent_events e
JOIN legal_documents d ON d.id = e.document_id
WHERE e.user_id = $1
ORDER BY d.kind, e.created_at DESC, e.id DESC;

-- name: ListConsentHistory :many
-- История согласий для «Правовой информации», свежие первыми.
SELECT e.id, d.kind, d.version, d.title, e.action, e.source, e.created_at
FROM consent_events e
JOIN legal_documents d ON d.id = e.document_id
WHERE e.user_id = $1
ORDER BY e.created_at DESC, e.id DESC
LIMIT 200;
