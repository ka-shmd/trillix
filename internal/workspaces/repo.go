package workspaces

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

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

// Create заводит пространство (без пометки личного): личное создаёт только
// транзакция регистрации, и оно у аккаунта ровно одно.
func (Repo) Create(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string) (Workspace, error) {
	row, err := postgres.New(db).CreateWorkspace(ctx, postgres.CreateWorkspaceParams{ID: id, Name: name})
	if err != nil {
		return Workspace{}, fmt.Errorf("create workspace: %w", err)
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

// GetWorkspace — пространство по id. is_personal здесь означает «личное вообще»
// (у кого-то), а не «личное для спрашивающего»: у этого запроса спрашивающего
// нет — он обслуживает письмо приглашения и ответ на принятие.
func (Repo) GetWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Workspace, error) {
	row, err := postgres.New(db).GetWorkspaceByID(ctx, id)
	if err != nil {
		return Workspace{}, fmt.Errorf("get workspace %s: %w", id, err)
	}
	return Workspace{ID: row.ID, Name: row.Name, IsPersonal: row.IsPersonal, CreatedAt: row.CreatedAt.Time}, nil
}

func (Repo) EmailByUserID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (string, error) {
	email, err := postgres.New(db).GetEmailByUserID(ctx, id)
	if err != nil {
		return "", fmt.Errorf("get email of user %s: %w", id, err)
	}
	return email, nil
}

// UserIDByEmail — pgx.ErrNoRows означает «такого аккаунта ещё нет», и это
// законный случай: приглашают и тех, кто не зарегистрирован.
func (Repo) UserIDByEmail(ctx context.Context, db postgres.DBTX, email string) (uuid.UUID, error) {
	id, err := postgres.New(db).GetUserIDByEmail(ctx, email)
	if err != nil {
		return uuid.Nil, fmt.Errorf("get user by email: %w", err)
	}
	return id, nil
}

func (Repo) CreateInvitation(ctx context.Context, db postgres.DBTX, tokenHash []byte, workspaceID uuid.UUID, email, role string, invitedBy uuid.UUID, expiresAt time.Time) error {
	if err := postgres.New(db).CreateInvitation(ctx, postgres.CreateInvitationParams{
		TokenHash:   tokenHash,
		WorkspaceID: workspaceID,
		Email:       email,
		Role:        role,
		InvitedBy:   invitedBy,
		ExpiresAt:   pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return fmt.Errorf("create invitation: %w", err)
	}
	return nil
}

func (Repo) DeletePendingInvitation(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, email string) error {
	if err := postgres.New(db).DeletePendingInvitation(ctx, postgres.DeletePendingInvitationParams{
		WorkspaceID: workspaceID,
		Lower:       email,
	}); err != nil {
		return fmt.Errorf("delete pending invitation: %w", err)
	}
	return nil
}

func (Repo) GetInvitation(ctx context.Context, db postgres.DBTX, tokenHash []byte) (Invitation, error) {
	row, err := postgres.New(db).GetInvitation(ctx, tokenHash)
	if err != nil {
		return Invitation{}, fmt.Errorf("get invitation: %w", err)
	}
	inv := Invitation{
		WorkspaceID:   row.WorkspaceID,
		WorkspaceName: row.WorkspaceName,
		Email:         row.Email,
		Role:          Role(row.Role),
		ExpiresAt:     row.ExpiresAt.Time,
	}
	if row.UsedAt.Valid {
		t := row.UsedAt.Time
		inv.UsedAt = &t
	}
	return inv, nil
}

// ConsumeInvitation — атомарное потребление токена: 0 строк означает «уже
// использовано или протухло», и различать эти случаи в ответе незачем.
func (Repo) ConsumeInvitation(ctx context.Context, db postgres.DBTX, tokenHash []byte) (Invitation, error) {
	row, err := postgres.New(db).ConsumeInvitation(ctx, tokenHash)
	if err != nil {
		return Invitation{}, fmt.Errorf("consume invitation: %w", err)
	}
	return Invitation{WorkspaceID: row.WorkspaceID, Email: row.Email, Role: Role(row.Role)}, nil
}

// AddMember добавляет участника с указанной ролью (приглашение принято).
func (Repo) AddMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID, role string) error {
	if err := postgres.New(db).CreateWorkspaceMember(ctx, postgres.CreateWorkspaceMemberParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
		Role:        role,
	}); err != nil {
		return fmt.Errorf("add workspace member: %w", err)
	}
	return nil
}

func (Repo) ListMembers(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]Member, error) {
	rows, err := postgres.New(db).ListWorkspaceMembers(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list members of %s: %w", workspaceID, err)
	}
	out := make([]Member, len(rows))
	for i, r := range rows {
		out[i] = Member{
			UserID: r.UserID, Email: r.Email,
			FirstName: r.FirstName.String, LastName: r.LastName.String, AvatarKey: r.AvatarKey.String,
			Role: Role(r.Role), JoinedAt: r.CreatedAt.Time,
		}
	}
	return out, nil
}

// ListOwnedTeamsWithMembers — имена командных пространств, где пользователь
// владелец и есть кто-то ещё (нужен удалению аккаунта, фаза 23, слайс G).
func (Repo) ListOwnedTeamsWithMembers(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]string, error) {
	names, err := postgres.New(db).ListOwnedTeamsWithMembers(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list owned teams with members of %s: %w", userID, err)
	}
	return names, nil
}

func (Repo) ListPendingInvites(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]PendingInvite, error) {
	rows, err := postgres.New(db).ListPendingInvitations(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list pending invitations of %s: %w", workspaceID, err)
	}
	out := make([]PendingInvite, len(rows))
	for i, r := range rows {
		out[i] = PendingInvite{Email: r.Email, Role: Role(r.Role), ExpiresAt: r.ExpiresAt.Time}
	}
	return out, nil
}

// DeleteMember возвращает число снятых строк: 0 означает «нет такого участника
// или это владелец» (владельца запрос не трогает — сторож на уровне SQL).
func (Repo) DeleteMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteMember(ctx, postgres.DeleteMemberParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if err != nil {
		return 0, fmt.Errorf("delete member: %w", err)
	}
	return n, nil
}

// AccessContext — данные для решения о доступе (роль + признаки заморозки).
type AccessContext struct {
	WorkspaceID uuid.UUID
	Role        string
	IsPersonal  bool
	OwnerID     uuid.UUID
	// TeamRank — какое это по счёту НЕЛИЧНОЕ пространство владельца (1-based).
	TeamRank int64
	// MemberRank — какой по счёту участник этого пространства спрашивает
	// (1-based; владелец всегда первый).
	MemberRank int64
}

func (Repo) AccessContext(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (AccessContext, error) {
	row, err := postgres.New(db).GetAccessContext(ctx, postgres.GetAccessContextParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if err != nil {
		return AccessContext{}, fmt.Errorf("access context of %s in %s: %w", userID, workspaceID, err)
	}
	return AccessContext{
		WorkspaceID: workspaceID,
		Role:        row.Role,
		IsPersonal:  row.IsPersonal,
		OwnerID:     row.OwnerID,
		TeamRank:    row.TeamRank,
		MemberRank:  row.MemberRank,
	}, nil
}

func (Repo) PurgeExpiredInvitations(ctx context.Context, db postgres.DBTX) (int64, error) {
	n, err := postgres.New(db).PurgeExpiredInvitations(ctx)
	if err != nil {
		return 0, fmt.Errorf("purge expired invitations: %w", err)
	}
	return n, nil
}
