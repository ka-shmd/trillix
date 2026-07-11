package forms

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trierra/internal/postgres"
)

// Form — представление формы внутри модуля (без утечки sqlc-типов в service и
// handler). DraftSchema заполняется только Get'ом (списку схема не нужна и не
// тянется); в списке и после создания она nil.
type Form struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	Title       string
	Slug        string
	Status      string
	DraftSchema json.RawMessage
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Repo — доступ к данным forms поверх sqlc-запросов. Методы принимают исполнителя
// (postgres.DBTX: пул или транзакция); транзакций сам не открывает.
type Repo struct{}

// GetPersonalWorkspace возвращает id личного воркспейса пользователя.
func (Repo) GetPersonalWorkspace(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (uuid.UUID, error) {
	wsID, err := postgres.New(db).GetPersonalWorkspace(ctx, userID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("get personal workspace: %w", err)
	}
	return wsID, nil
}

// IsWorkspaceMember сообщает, состоит ли пользователь в воркспейсе (анти-IDOR).
func (Repo) IsWorkspaceMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (bool, error) {
	ok, err := postgres.New(db).IsWorkspaceMember(ctx, postgres.IsWorkspaceMemberParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if err != nil {
		return false, fmt.Errorf("is workspace member: %w", err)
	}
	return ok, nil
}

func (Repo) CreateForm(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, title, slug string) (Form, error) {
	row, err := postgres.New(db).CreateForm(ctx, postgres.CreateFormParams{
		ID:          id,
		WorkspaceID: workspaceID,
		Title:       title,
		Slug:        slug,
	})
	if err != nil {
		return Form{}, fmt.Errorf("create form: %w", err)
	}
	return Form{
		ID:          row.ID,
		WorkspaceID: row.WorkspaceID,
		Title:       row.Title,
		Slug:        row.Slug,
		Status:      row.Status,
		CreatedAt:   row.CreatedAt.Time,
		UpdatedAt:   row.UpdatedAt.Time,
	}, nil
}

// GetForm возвращает форму по id вместе с draft_schema. pgx.ErrNoRows пробрасывается
// (обёрнутым) — service трактует его как domain.ErrNotFound.
func (Repo) GetForm(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Form, error) {
	row, err := postgres.New(db).GetForm(ctx, id)
	if err != nil {
		return Form{}, fmt.Errorf("get form: %w", err)
	}
	return Form{
		ID:          row.ID,
		WorkspaceID: row.WorkspaceID,
		Title:       row.Title,
		Slug:        row.Slug,
		Status:      row.Status,
		DraftSchema: json.RawMessage(row.DraftSchema),
		CreatedAt:   row.CreatedAt.Time,
		UpdatedAt:   row.UpdatedAt.Time,
	}, nil
}

// ListForms — первая страница списка форм воркспейса (свежие правки сверху).
func (Repo) ListForms(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, limit int32) ([]Form, error) {
	rows, err := postgres.New(db).ListFormsFirstPage(ctx, postgres.ListFormsFirstPageParams{
		WorkspaceID: workspaceID,
		Limit:       limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list forms: %w", err)
	}
	out := make([]Form, len(rows))
	for i, r := range rows {
		out[i] = Form{
			ID:          r.ID,
			WorkspaceID: r.WorkspaceID,
			Title:       r.Title,
			Slug:        r.Slug,
			Status:      r.Status,
			CreatedAt:   r.CreatedAt.Time,
			UpdatedAt:   r.UpdatedAt.Time,
		}
	}
	return out, nil
}

// ListFormsAfter — следующая страница составным курсором (updatedAt, id).
func (Repo) ListFormsAfter(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, cursorUpdatedAt time.Time, cursorID uuid.UUID, limit int32) ([]Form, error) {
	rows, err := postgres.New(db).ListFormsAfter(ctx, postgres.ListFormsAfterParams{
		WorkspaceID:     workspaceID,
		CursorUpdatedAt: pgtype.Timestamptz{Time: cursorUpdatedAt, Valid: true},
		CursorID:        cursorID,
		Limit:           limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list forms after cursor: %w", err)
	}
	out := make([]Form, len(rows))
	for i, r := range rows {
		out[i] = Form{
			ID:          r.ID,
			WorkspaceID: r.WorkspaceID,
			Title:       r.Title,
			Slug:        r.Slug,
			Status:      r.Status,
			CreatedAt:   r.CreatedAt.Time,
			UpdatedAt:   r.UpdatedAt.Time,
		}
	}
	return out, nil
}

// UpdateFormTitle меняет title в пределах воркспейса. pgx.ErrNoRows (форма чужая
// или отсутствует) пробрасывается обёрнутым — service вернёт domain.ErrNotFound.
func (Repo) UpdateFormTitle(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, title string) (Form, error) {
	row, err := postgres.New(db).UpdateFormTitle(ctx, postgres.UpdateFormTitleParams{
		ID:          id,
		WorkspaceID: workspaceID,
		Title:       title,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form title: %w", err)
	}
	return Form{
		ID:          row.ID,
		WorkspaceID: row.WorkspaceID,
		Title:       row.Title,
		Slug:        row.Slug,
		Status:      row.Status,
		CreatedAt:   row.CreatedAt.Time,
		UpdatedAt:   row.UpdatedAt.Time,
	}, nil
}

// DeleteForm удаляет форму в пределах воркспейса; возвращает число удалённых строк.
func (Repo) DeleteForm(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteForm(ctx, postgres.DeleteFormParams{ID: id, WorkspaceID: workspaceID})
	if err != nil {
		return 0, fmt.Errorf("delete form: %w", err)
	}
	return n, nil
}
