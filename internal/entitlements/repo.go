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

// EntitlementsForUser — то же, но с проверкой членства внутри запроса: не член
// получает pgx.ErrNoRows, а сервис превращает его в 404 (инвариант 1).
func (Repo) EntitlementsForUser(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID, period time.Time) (Row, error) {
	row, err := postgres.New(db).GetEntitlementsForUser(ctx, postgres.GetEntitlementsForUserParams{
		WorkspaceID: workspaceID,
		Period:      pgtype.Date{Time: period, Valid: true},
		UserID:      userID,
	})
	if err != nil {
		return Row{}, fmt.Errorf("get entitlements of workspace %s for user %s: %w", workspaceID, userID, err)
	}
	return Row{
		PlanCode:        row.PlanCode,
		PlanTitle:       row.PlanTitle,
		Limits:          row.Limits,
		SubmissionsUsed: row.SubmissionsUsed,
		MembersCount:    row.MembersCount,
		StorageUsed:     row.StorageUsed,
	}, nil
}

// AccountEntitlements — план аккаунта и его счётчики (сколько пространств уже
// держит). pgx.ErrNoRows пробрасывается: «у аккаунта нет подписки» — нарушенный
// инвариант регистрации, а не пустой ответ.
func (Repo) AccountEntitlements(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (Row, error) {
	row, err := postgres.New(db).GetAccountEntitlements(ctx, userID)
	if err != nil {
		return Row{}, fmt.Errorf("get entitlements of account %s: %w", userID, err)
	}
	return Row{
		PlanCode:        row.PlanCode,
		PlanTitle:       row.PlanTitle,
		Limits:          row.Limits,
		WorkspacesOwned: row.WorkspacesOwned,
	}, nil
}

// EntitlementsWithMembers — состояние тарифа плюс счётчик участников (гейт мест).
func (Repo) EntitlementsWithMembers(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, period time.Time) (Row, error) {
	row, err := postgres.New(db).GetEntitlementsWithMembers(ctx, postgres.GetEntitlementsWithMembersParams{
		WorkspaceID: workspaceID,
		Period:      pgtype.Date{Time: period, Valid: true},
	})
	if err != nil {
		return Row{}, fmt.Errorf("get entitlements with members of workspace %s: %w", workspaceID, err)
	}
	return Row{
		PlanCode:        row.PlanCode,
		PlanTitle:       row.PlanTitle,
		Limits:          row.Limits,
		SubmissionsUsed: row.SubmissionsUsed,
		MembersCount:    row.MembersCount,
	}, nil
}

// EntitlementsWithStorage — состояние тарифа плюс расход хранилища (гейт файлов).
func (Repo) EntitlementsWithStorage(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, period time.Time) (Row, error) {
	row, err := postgres.New(db).GetEntitlementsWithStorage(ctx, postgres.GetEntitlementsWithStorageParams{
		WorkspaceID: workspaceID,
		Period:      pgtype.Date{Time: period, Valid: true},
	})
	if err != nil {
		return Row{}, fmt.Errorf("get entitlements with storage of workspace %s: %w", workspaceID, err)
	}
	return Row{
		PlanCode:        row.PlanCode,
		PlanTitle:       row.PlanTitle,
		Limits:          row.Limits,
		SubmissionsUsed: row.SubmissionsUsed,
		StorageUsed:     row.StorageUsed,
	}, nil
}
