package integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Connection — подключённый аккаунт, как он лежит у нас.
//
// RefreshSealed — ШИФРОТЕКСТ и остаётся им везде выше repo: расшифровка живёт в
// одном месте (Service.accessToken), и ни один DTO транспорта этого поля не
// содержит. Мина: добавите его в ответ API — отдадите наружу ключ от чужого Диска.
type Connection struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	Provider      string
	ExternalID    string
	Email         string
	RefreshSealed []byte
	Scopes        string
	ConnectedBy   uuid.UUID
	ConnectedAt   time.Time
}

// NewConnection — что нужно записать при подключении.
type NewConnection struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	Provider      string
	ExternalID    string
	Email         string
	RefreshSealed []byte
	Scopes        string
	ConnectedBy   uuid.UUID
}

// Repo — доступ к данным интеграций поверх sqlc. Методы принимают исполнителя
// (пул или транзакция) и логики не содержат.
type Repo struct{}

func (Repo) Upsert(ctx context.Context, db postgres.DBTX, c NewConnection) error {
	err := postgres.New(db).UpsertIntegrationAccount(ctx, postgres.UpsertIntegrationAccountParams{
		ID:                c.ID,
		WorkspaceID:       c.WorkspaceID,
		Provider:          c.Provider,
		ExternalAccountID: c.ExternalID,
		ExternalEmail:     c.Email,
		RefreshToken:      c.RefreshSealed,
		Scopes:            c.Scopes,
		ConnectedBy:       c.ConnectedBy,
	})
	if err != nil {
		return fmt.Errorf("upsert integration account: %w", err)
	}
	return nil
}

func (Repo) Get(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, provider string) (Connection, error) {
	row, err := postgres.New(db).GetIntegrationAccount(ctx, postgres.GetIntegrationAccountParams{
		WorkspaceID: workspaceID,
		Provider:    provider,
	})
	if err != nil {
		// pgx.ErrNoRows пробрасывается как есть: «нет подключения» — не ошибка
		// уровня repo, и решает это вызывающий (для экрана это штатное состояние).
		return Connection{}, err
	}
	return Connection{
		ID:            row.ID,
		WorkspaceID:   row.WorkspaceID,
		Provider:      row.Provider,
		ExternalID:    row.ExternalAccountID,
		Email:         row.ExternalEmail,
		RefreshSealed: row.RefreshToken,
		Scopes:        row.Scopes,
		ConnectedBy:   row.ConnectedBy,
		ConnectedAt:   row.ConnectedAt.Time,
	}, nil
}

// Delete удаляет подключение и отдаёт шифротекст токена — на отзыв у провайдера.
func (Repo) Delete(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, provider string) ([]byte, error) {
	sealed, err := postgres.New(db).DeleteIntegrationAccount(ctx, postgres.DeleteIntegrationAccountParams{
		WorkspaceID: workspaceID,
		Provider:    provider,
	})
	if err != nil {
		return nil, err
	}
	return sealed, nil
}

// FormLink — привязка формы к таблице (с полями аккаунта, нужными экрану и
// доставке: за ними иначе пришлось бы ехать вторым запросом).
type FormLink struct {
	ID              uuid.UUID
	FormID          uuid.UUID
	AccountID       uuid.UUID
	WorkspaceID     uuid.UUID
	AccountEmail    string
	SpreadsheetID   string
	SpreadsheetURL  string
	SheetID         int32
	SheetTitle      string
	Columns         []domain.SheetColumn
	Status          string
	BackfillBefore  time.Time
	LastError       string
	LastDeliveredAt time.Time
}

// NewFormLink — что нужно записать при привязке.
type NewFormLink struct {
	ID             uuid.UUID
	FormID         uuid.UUID
	AccountID      uuid.UUID
	SpreadsheetID  string
	SpreadsheetURL string
	SheetID        int32
	SheetTitle     string
	Columns        []domain.SheetColumn
	Status         string
}

func (Repo) InsertLink(ctx context.Context, db postgres.DBTX, l NewFormLink) error {
	columns, err := json.Marshal(l.Columns)
	if err != nil {
		return fmt.Errorf("marshal columns: %w", err)
	}
	err = postgres.New(db).InsertFormIntegration(ctx, postgres.InsertFormIntegrationParams{
		ID:             l.ID,
		FormID:         l.FormID,
		AccountID:      l.AccountID,
		SpreadsheetID:  l.SpreadsheetID,
		SpreadsheetUrl: l.SpreadsheetURL,
		SheetID:        l.SheetID,
		SheetTitle:     l.SheetTitle,
		Columns:        columns,
		Status:         l.Status,
	})
	if err != nil {
		return fmt.Errorf("insert form integration: %w", err)
	}
	return nil
}

func (Repo) GetLink(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (FormLink, error) {
	row, err := postgres.New(db).GetFormIntegration(ctx, formID)
	if err != nil {
		// pgx.ErrNoRows — «форма не привязана», штатное состояние экрана.
		return FormLink{}, err
	}
	return toFormLink(formIntegrationRow{
		ID: row.ID, FormID: row.FormID, AccountID: row.AccountID, WorkspaceID: row.WorkspaceID,
		ExternalEmail: row.ExternalEmail, SpreadsheetID: row.SpreadsheetID, SpreadsheetUrl: row.SpreadsheetUrl,
		SheetID: row.SheetID, SheetTitle: row.SheetTitle, Columns: row.Columns, Status: row.Status,
		BackfillBefore: row.BackfillBefore.Time, LastError: row.LastError.String,
		LastDeliveredAt: row.LastDeliveredAt.Time,
	})
}

func (Repo) DeleteLink(ctx context.Context, db postgres.DBTX, formID uuid.UUID) error {
	if err := postgres.New(db).DeleteFormIntegration(ctx, formID); err != nil {
		return fmt.Errorf("delete form integration: %w", err)
	}
	return nil
}

func (Repo) GetLinkByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (FormLink, error) {
	row, err := postgres.New(db).GetFormIntegrationByID(ctx, id)
	if err != nil {
		return FormLink{}, err
	}
	return toFormLink(formIntegrationRow{
		ID: row.ID, FormID: row.FormID, AccountID: row.AccountID, WorkspaceID: row.WorkspaceID,
		ExternalEmail: row.ExternalEmail, SpreadsheetID: row.SpreadsheetID, SpreadsheetUrl: row.SpreadsheetUrl,
		SheetID: row.SheetID, SheetTitle: row.SheetTitle, Columns: row.Columns, Status: row.Status,
		BackfillBefore: row.BackfillBefore.Time, LastError: row.LastError.String,
		LastDeliveredAt: row.LastDeliveredAt.Time,
	})
}

func (Repo) GetAccountByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Connection, error) {
	row, err := postgres.New(db).GetIntegrationAccountByID(ctx, id)
	if err != nil {
		return Connection{}, err
	}
	return Connection{
		ID:            row.ID,
		WorkspaceID:   row.WorkspaceID,
		Provider:      row.Provider,
		ExternalID:    row.ExternalAccountID,
		Email:         row.ExternalEmail,
		RefreshSealed: row.RefreshToken,
		Scopes:        row.Scopes,
		ConnectedBy:   row.ConnectedBy,
		ConnectedAt:   row.ConnectedAt.Time,
	}, nil
}

func (Repo) UpdateLinkColumns(ctx context.Context, db postgres.DBTX, id uuid.UUID, columns []domain.SheetColumn) error {
	raw, err := json.Marshal(columns)
	if err != nil {
		return fmt.Errorf("marshal columns: %w", err)
	}
	if err := postgres.New(db).UpdateFormIntegrationColumns(ctx, postgres.UpdateFormIntegrationColumnsParams{
		ID:      id,
		Columns: raw,
	}); err != nil {
		return fmt.Errorf("update form integration columns: %w", err)
	}
	return nil
}

func (Repo) MarkDelivered(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).MarkFormIntegrationDelivered(ctx, id); err != nil {
		return fmt.Errorf("mark form integration delivered: %w", err)
	}
	return nil
}

func (Repo) MarkBroken(ctx context.Context, db postgres.DBTX, id uuid.UUID, cause string) error {
	err := postgres.New(db).MarkFormIntegrationBroken(ctx, postgres.MarkFormIntegrationBrokenParams{
		ID:        id,
		LastError: pgtype.Text{String: cause, Valid: cause != ""},
	})
	if err != nil {
		return fmt.Errorf("mark form integration broken: %w", err)
	}
	return nil
}

// formIntegrationRow — общий вид строки привязки для двух запросов (по форме и
// по id): sqlc генерирует им разные типы, а собирается FormLink из них одинаково.
type formIntegrationRow struct {
	ID, FormID, AccountID, WorkspaceID uuid.UUID
	ExternalEmail                      string
	SpreadsheetID, SpreadsheetUrl      string
	SheetID                            int32
	SheetTitle, Status, LastError      string
	Columns                            []byte
	BackfillBefore, LastDeliveredAt    time.Time
}

func toFormLink(row formIntegrationRow) (FormLink, error) {
	var columns []domain.SheetColumn
	if err := json.Unmarshal(row.Columns, &columns); err != nil {
		return FormLink{}, fmt.Errorf("unmarshal columns of form %s: %w", row.FormID, err)
	}
	return FormLink{
		ID:              row.ID,
		FormID:          row.FormID,
		AccountID:       row.AccountID,
		WorkspaceID:     row.WorkspaceID,
		AccountEmail:    row.ExternalEmail,
		SpreadsheetID:   row.SpreadsheetID,
		SpreadsheetURL:  row.SpreadsheetUrl,
		SheetID:         row.SheetID,
		SheetTitle:      row.SheetTitle,
		Columns:         columns,
		Status:          row.Status,
		BackfillBefore:  row.BackfillBefore,
		LastError:       row.LastError,
		LastDeliveredAt: row.LastDeliveredAt,
	}, nil
}

func (Repo) StartBackfill(ctx context.Context, db postgres.DBTX, id uuid.UUID, before time.Time) error {
	err := postgres.New(db).StartFormIntegrationBackfill(ctx, postgres.StartFormIntegrationBackfillParams{
		ID:             id,
		BackfillBefore: pgtype.Timestamptz{Time: before, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("start backfill: %w", err)
	}
	return nil
}

func (Repo) FinishBackfill(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).FinishFormIntegrationBackfill(ctx, id); err != nil {
		return fmt.Errorf("finish backfill: %w", err)
	}
	return nil
}
