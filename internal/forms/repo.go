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
//
// PublishedVersionID/PublishedVersion — id и номер текущей опубликованной версии
// (оба nil, пока форму не публиковали). Номер версии читающие запросы (Get/List)
// достают LEFT JOIN'ом; мутации его не выбирают — там сервис проставляет его сам
// (см. queries.sql), поэтому у результатов мутаций PublishedVersion может быть nil.
type Form struct {
	ID                 uuid.UUID
	WorkspaceID        uuid.UUID
	Title              string
	Slug               string
	Status             string
	DraftSchema        json.RawMessage
	PublishedVersionID *uuid.UUID
	PublishedVersion   *int32
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// PublicForm — публичная проекция опубликованной формы для рендерера: title и схема
// опубликованной версии. VersionID (id этой версии) иммутабелен и служит ETag'ом.
type PublicForm struct {
	Title     string
	Version   int32
	Schema    json.RawMessage
	VersionID uuid.UUID
}

// ptrUUID переводит nullable uuid из sqlc (pgtype.UUID) в *uuid.UUID: NULL → nil.
func ptrUUID(v pgtype.UUID) *uuid.UUID {
	if !v.Valid {
		return nil
	}
	id := uuid.UUID(v.Bytes)
	return &id
}

// ptrInt32 переводит nullable int из sqlc (pgtype.Int4) в *int32: NULL → nil.
func ptrInt32(v pgtype.Int4) *int32 {
	if !v.Valid {
		return nil
	}
	n := v.Int32
	return &n
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
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// GetForm возвращает форму по id вместе с draft_schema и номером опубликованной
// версии. pgx.ErrNoRows пробрасывается (обёрнутым) — service трактует его как
// domain.ErrNotFound.
func (Repo) GetForm(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Form, error) {
	row, err := postgres.New(db).GetForm(ctx, id)
	if err != nil {
		return Form{}, fmt.Errorf("get form: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		DraftSchema:        json.RawMessage(row.DraftSchema),
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		PublishedVersion:   ptrInt32(row.PublishedVersion),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
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
			ID:                 r.ID,
			WorkspaceID:        r.WorkspaceID,
			Title:              r.Title,
			Slug:               r.Slug,
			Status:             r.Status,
			PublishedVersionID: ptrUUID(r.PublishedVersionID),
			PublishedVersion:   ptrInt32(r.PublishedVersion),
			CreatedAt:          r.CreatedAt.Time,
			UpdatedAt:          r.UpdatedAt.Time,
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
			ID:                 r.ID,
			WorkspaceID:        r.WorkspaceID,
			Title:              r.Title,
			Slug:               r.Slug,
			Status:             r.Status,
			PublishedVersionID: ptrUUID(r.PublishedVersionID),
			PublishedVersion:   ptrInt32(r.PublishedVersion),
			CreatedAt:          r.CreatedAt.Time,
			UpdatedAt:          r.UpdatedAt.Time,
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
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// UpdateFormDraftSchema сохраняет черновик схемы с оптимистичной блокировкой:
// UPDATE проходит, только если updated_at совпадает с expectedUpdatedAt. Расхождение
// (или удалённая параллельно форма) → 0 строк → pgx.ErrNoRows, которую service
// трактует как конфликт (доступ он проверяет заранее отдельным чтением).
func (Repo) UpdateFormDraftSchema(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, schema json.RawMessage, expectedUpdatedAt time.Time) (Form, error) {
	row, err := postgres.New(db).UpdateFormDraftSchema(ctx, postgres.UpdateFormDraftSchemaParams{
		ID:                id,
		WorkspaceID:       workspaceID,
		DraftSchema:       schema,
		ExpectedUpdatedAt: pgtype.Timestamptz{Time: expectedUpdatedAt, Valid: true},
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form draft schema: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		DraftSchema:        json.RawMessage(row.DraftSchema),
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
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

// GetPublishedFormBySlug возвращает опубликованную форму по slug. pgx.ErrNoRows
// (черновик/закрытая/нет формы) пробрасывается обёрнутым — service вернёт 404.
func (Repo) GetPublishedFormBySlug(ctx context.Context, db postgres.DBTX, slug string) (PublicForm, error) {
	row, err := postgres.New(db).GetPublishedFormBySlug(ctx, slug)
	if err != nil {
		return PublicForm{}, fmt.Errorf("get published form by slug: %w", err)
	}
	// published_version_id — ключ INNER JOIN, всегда валиден на вернувшейся строке.
	return PublicForm{
		Title:     row.Title,
		Version:   row.Version,
		Schema:    json.RawMessage(row.Schema),
		VersionID: uuid.UUID(row.PublishedVersionID.Bytes),
	}, nil
}

// NextFormVersion возвращает номер следующей версии формы (1 для первой публикации).
func (Repo) NextFormVersion(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int32, error) {
	n, err := postgres.New(db).NextFormVersion(ctx, formID)
	if err != nil {
		return 0, fmt.Errorf("next form version: %w", err)
	}
	return n, nil
}

// InsertFormVersion пишет иммутабельный снапшот схемы; возвращает id новой строки
// form_versions (им service проставляет published_version_id в той же транзакции).
func (Repo) InsertFormVersion(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, version int32, schema json.RawMessage) (uuid.UUID, error) {
	row, err := postgres.New(db).InsertFormVersion(ctx, postgres.InsertFormVersionParams{
		ID:      id,
		FormID:  formID,
		Version: version,
		Schema:  schema,
	})
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert form version: %w", err)
	}
	return row.ID, nil
}

// SetFormPublished переводит форму в published и привязывает опубликованную версию.
// В пределах воркспейса; pgx.ErrNoRows (чужая/нет формы) пробрасывается обёрнутым.
func (Repo) SetFormPublished(ctx context.Context, db postgres.DBTX, id, workspaceID, versionID uuid.UUID) (Form, error) {
	row, err := postgres.New(db).SetFormPublished(ctx, postgres.SetFormPublishedParams{
		ID:                 id,
		WorkspaceID:        workspaceID,
		PublishedVersionID: pgtype.UUID{Bytes: versionID, Valid: true},
	})
	if err != nil {
		return Form{}, fmt.Errorf("set form published: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// SetFormClosed переводит форму в closed (published_version_id не трогает).
// В пределах воркспейса; pgx.ErrNoRows (чужая/нет формы) пробрасывается обёрнутым.
func (Repo) SetFormClosed(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (Form, error) {
	row, err := postgres.New(db).SetFormClosed(ctx, postgres.SetFormClosedParams{
		ID:          id,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		return Form{}, fmt.Errorf("set form closed: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}
