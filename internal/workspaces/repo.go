package workspaces

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// Workspace — пространство пользователя (доменное представление, без утечки
// sqlc-типов в service/handler).
type Workspace struct {
	ID   uuid.UUID
	Name string
	// IsPersonal — личное пространство СПРАШИВАЮЩЕГО: создано его регистрацией,
	// не удаляется, не покидается и не замораживается при даунгрейде (ADR §10).
	IsPersonal bool
	CreatedAt  time.Time
}

// Repo — доступ к данным workspaces поверх sqlc-запросов. Методы принимают
// исполнителя (postgres.DBTX — пул или транзакция).
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
		out[i] = Workspace{ID: r.ID, Name: r.Name, IsPersonal: r.IsPersonal, CreatedAt: r.CreatedAt.Time}
	}
	return out, nil
}

// CreateTeam заводит КОМАНДНОЕ пространство (без пометки личного): личное
// создаёт только транзакция регистрации, и оно у аккаунта ровно одно.
func (Repo) CreateTeam(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string) (Workspace, error) {
	row, err := postgres.New(db).CreateTeamWorkspace(ctx, postgres.CreateTeamWorkspaceParams{ID: id, Name: name})
	if err != nil {
		return Workspace{}, fmt.Errorf("create team workspace: %w", err)
	}
	return Workspace{ID: row.ID, Name: row.Name, CreatedAt: row.CreatedAt.Time}, nil
}

// AddOwner делает пользователя владельцем пространства. Владелец ровно один —
// «не больше одного» держит уникальный индекс (0016), поэтому повторный вызов
// на том же пространстве вернёт ошибку БД, а не создаст второго плательщика.
func (Repo) AddOwner(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) error {
	if err := postgres.New(db).CreateWorkspaceMember(ctx, postgres.CreateWorkspaceMemberParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
		Role:        string(RoleOwner),
	}); err != nil {
		return fmt.Errorf("add workspace owner: %w", err)
	}
	return nil
}

// MemberRole возвращает роль участника в пространстве. pgx.ErrNoRows означает
// «не участник» и пробрасывается как есть: разбирает его Can — не член получает
// 404, а не 403 (существование чужого пространства не раскрывается).
func (Repo) MemberRole(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (string, error) {
	role, err := postgres.New(db).GetMemberRole(ctx, postgres.GetMemberRoleParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if err != nil {
		return "", fmt.Errorf("get member role of %s in %s: %w", userID, workspaceID, err)
	}
	return role, nil
}
