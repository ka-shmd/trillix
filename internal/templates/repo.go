package templates

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// Visibility — кому виден шаблон. Значения совпадают с CHECK таблицы (0059) и с
// тем, что уезжает в JSON кабинету: белый список, произвольная строка в SQL не
// попадает.
type Visibility string

const (
	// VisibilityPrivate — шаблон пространства: виден его участникам, живёт в
	// вкладке «Мои».
	VisibilityPrivate Visibility = "private"
	// VisibilityPublic — витрина сервиса: виден всем, пространству не принадлежит.
	VisibilityPublic Visibility = "public"
)

// Template — шаблон формы (доменное представление, без утечки sqlc-типов выше
// репозитория).
type Template struct {
	ID uuid.UUID
	// WorkspaceID — пространство-владелец; uuid.Nil у публичного (в базе NULL).
	WorkspaceID uuid.UUID
	// AuthorID — кто сохранил; uuid.Nil, если автор ушёл из продукта (ON DELETE
	// SET NULL) либо шаблон завела админская ручка от имени сервиса.
	AuthorID    uuid.UUID
	Title       string
	Description string
	// Schema — документ формы целиком. Сырым JSON, а не разобранной структурой:
	// галерее он нужен как есть (плитка рисует его теми же кирпичами, что
	// публичная страница), а разбирает его тот, кто копирует.
	Schema     json.RawMessage
	Visibility Visibility
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Repo — доступ к данным templates поверх sqlc-запросов. Методы принимают
// исполнителя (postgres.DBTX — пул или транзакция).
type Repo struct{}

func (Repo) ListByWorkspace(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]Template, error) {
	rows, err := postgres.New(db).ListWorkspaceTemplates(ctx, pgtype.UUID{Bytes: workspaceID, Valid: true})
	if err != nil {
		return nil, fmt.Errorf("list workspace templates %s: %w", workspaceID, err)
	}
	return toTemplates(rows), nil
}

func (Repo) ListPublic(ctx context.Context, db postgres.DBTX) ([]Template, error) {
	rows, err := postgres.New(db).ListPublicTemplates(ctx)
	if err != nil {
		return nil, fmt.Errorf("list public templates: %w", err)
	}
	return toTemplates(rows), nil
}

// Get отдаёт шаблон вместе с тем, по чему решается доступ. Права спрашивает
// сервис: id из URL правом не является.
func (Repo) Get(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Template, error) {
	row, err := postgres.New(db).GetFormTemplate(ctx, id)
	if err != nil {
		// pgx.ErrNoRows пробрасывается как есть — «нет строки» и «сломалась база»
		// различает сервис, как и в forms.
		return Template{}, err
	}
	return toTemplate(row), nil
}

func (Repo) Create(ctx context.Context, db postgres.DBTX, t Template) (Template, error) {
	row, err := postgres.New(db).CreateFormTemplate(ctx, postgres.CreateFormTemplateParams{
		ID:          t.ID,
		WorkspaceID: pgUUID(t.WorkspaceID),
		AuthorID:    pgUUID(t.AuthorID),
		Title:       t.Title,
		Description: t.Description,
		Schema:      t.Schema,
		Visibility:  string(t.Visibility),
	})
	if err != nil {
		return Template{}, fmt.Errorf("create form template: %w", err)
	}
	return toTemplate(row), nil
}

// DeleteInWorkspace удаляет шаблон пространства. Ноль строк означает «не
// удалили» (чужой id, публичный шаблон) — разбирает это сервис.
func (Repo) DeleteInWorkspace(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteWorkspaceTemplate(ctx, postgres.DeleteWorkspaceTemplateParams{
		ID:          id,
		WorkspaceID: pgtype.UUID{Bytes: workspaceID, Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("delete form template %s: %w", id, err)
	}
	return n, nil
}

// pgUUID — nil-совместимое приведение: uuid.Nil означает NULL в базе. Ровно два
// поля таблицы такие, и оба по делу — публичный шаблон ничей, автор может уйти.
func pgUUID(id uuid.UUID) pgtype.UUID {
	if id == uuid.Nil {
		return pgtype.UUID{}
	}
	return pgtype.UUID{Bytes: id, Valid: true}
}

func toTemplates(rows []postgres.FormTemplate) []Template {
	out := make([]Template, len(rows))
	for i, r := range rows {
		out[i] = toTemplate(r)
	}
	return out
}

func toTemplate(r postgres.FormTemplate) Template {
	t := Template{
		ID:          r.ID,
		Title:       r.Title,
		Description: r.Description,
		Schema:      r.Schema,
		Visibility:  Visibility(r.Visibility),
		CreatedAt:   r.CreatedAt.Time,
		UpdatedAt:   r.UpdatedAt.Time,
	}
	if r.WorkspaceID.Valid {
		t.WorkspaceID = r.WorkspaceID.Bytes
	}
	if r.AuthorID.Valid {
		t.AuthorID = r.AuthorID.Bytes
	}
	return t
}
