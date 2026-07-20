package workspaces

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// Workspace — воркспейс пользователя (доменное представление, без утечки
// sqlc-типов в service/handler).
type Workspace struct {
	ID        uuid.UUID
	Name      string
	CreatedAt time.Time
}

// Repo — доступ к данным workspaces поверх sqlc-запросов. Методы принимают
// исполнителя (postgres.DBTX — пул или транзакция); в MVP только чтение.
type Repo struct{}

// ListByUser возвращает воркспейсы, в которых состоит пользователь (членство
// обеспечивает сам запрос — JOIN через workspace_members).
func (Repo) ListByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]Workspace, error) {
	rows, err := postgres.New(db).ListWorkspacesByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list workspaces by user: %w", err)
	}
	out := make([]Workspace, len(rows))
	for i, r := range rows {
		out[i] = Workspace{ID: r.ID, Name: r.Name, CreatedAt: r.CreatedAt.Time}
	}
	return out, nil
}
