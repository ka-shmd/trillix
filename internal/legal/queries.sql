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
