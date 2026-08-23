package integrations

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

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
