package entitlements

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// Repo — доступ к данным тарифов поверх sqlc.
type Repo struct{}

func (Repo) Entitlements(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, period time.Time) (Row, error) {
	row, err := postgres.New(db).GetEntitlements(ctx, postgres.GetEntitlementsParams{
		WorkspaceID: workspaceID,
		Period:      pgtype.Date{Time: period, Valid: true},
	})
	if err != nil {
		// pgx.ErrNoRows пробрасывается как есть (обёрнутым): «у воркспейса нет
		// подписки» разбирает сервис — это нарушенный инвариант, а не пустой ответ.
		return Row{}, fmt.Errorf("get entitlements of workspace %s: %w", workspaceID, err)
	}
	return Row{
		PlanCode:        row.PlanCode,
		PlanTitle:       row.PlanTitle,
		Limits:          row.Limits,
		SubmissionsUsed: row.SubmissionsUsed,
	}, nil
}
