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
	ID uuid.UUID
	// Slug — короткий публичный ключ пространства (nanoid(10), domain.NewSlug),
	// тот же приём, что forms.slug: адресом кабинета работает он, а PK остаётся
	// UUIDv7, потому что на него ссылаются семь таблиц.
	Slug string
	Name string
	// IsPersonal — личное пространство СПРАШИВАЮЩЕГО: создано его регистрацией,
	// не удаляется, не покидается и не замораживается при даунгрейде (ADR §10).
	IsPersonal bool
	CreatedAt  time.Time
	// FormCount — сколько форм в пространстве; заполняется только списком
	// (ListByUser), где его считает тот же запрос. У создания и переименования
	// он ноль: их ответ — сама вывеска, а не сводка, и список кабинет перечитает.
	FormCount int64
	// Frozen — пространство закрыто ДЛЯ СПРАШИВАЮЩЕГО: тариф владельца больше не
	// покрывает столько пространств либо столько участников (ADR §10). Считает
	// сервис (ListForUser), а не запрос: лимиты знает только entitlements.
	//
	// Заморозка — состояние ПАРЫ «пространство и человек», а не пространства:
	// лишними мёрзнут именно участники сверх мест, и владелец не мёрзнет никогда.
	// Поэтому поле живёт в списке, который и так строится под конкретного
	// спрашивающего, — как и IsPersonal рядом.
	Frozen bool
}

// WorkspaceAccess — строка списка вместе с тем, по чему решается заморозка.
// Отдельный тип, а не поля в Workspace: ранги нужны одному расчёту в сервисе и
// наружу не отдаются, а в DTO попадает только его результат.
type WorkspaceAccess struct {
	Workspace
	// OwnerID — чей это тариф. Лимит пространств спрашивается у ВЛАДЕЛЬЦА, а не
	// у спрашивающего: пространство работает по плану своего владельца.
	OwnerID uuid.UUID
	// TeamRank — какое это по счёту НЕЛИЧНОЕ пространство владельца (1-based).
	TeamRank int64
	// MemberRank — какой по счёту участник этого пространства спрашивает
	// (1-based; владелец всегда первый).
	MemberRank int64
}

// Repo — доступ к данным workspaces поверх sqlc-запросов. Методы принимают
// исполнителя (postgres.DBTX — пул или транзакция).
type Repo struct{}

// ListByUser возвращает воркспейсы, в которых состоит пользователь (членство
// обеспечивает сам запрос — JOIN через workspace_members).
func (Repo) ListByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]WorkspaceAccess, error) {
	rows, err := postgres.New(db).ListWorkspacesByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list workspaces by user: %w", err)
	}
	out := make([]WorkspaceAccess, len(rows))
	for i, r := range rows {
		out[i] = WorkspaceAccess{
			Workspace: Workspace{
				ID: r.ID, Slug: r.Slug, Name: r.Name, IsPersonal: r.IsPersonal,
				CreatedAt: r.CreatedAt.Time, FormCount: r.FormCount,
			},
			OwnerID: r.OwnerID, TeamRank: r.TeamRank, MemberRank: r.MemberRank,
		}
	}
	return out, nil
}

// Create заводит пространство (без пометки личного): личное создаёт только
// транзакция регистрации, и оно у аккаунта ровно одно.
func (Repo) Create(ctx context.Context, db postgres.DBTX, id uuid.UUID, slug, name string) (Workspace, error) {
	row, err := postgres.New(db).CreateWorkspace(ctx, postgres.CreateWorkspaceParams{ID: id, Slug: slug, Name: name})
	if err != nil {
		return Workspace{}, fmt.Errorf("create workspace: %w", err)
	}
	return Workspace{ID: row.ID, Slug: row.Slug, Name: row.Name, CreatedAt: row.CreatedAt.Time}, nil
}

// Rename меняет название пространства. Право спрашивает сервис: repo логики не
// содержит, а id из URL сам по себе правом не является.
func (Repo) Rename(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string) (Workspace, error) {
	row, err := postgres.New(db).RenameWorkspace(ctx, postgres.RenameWorkspaceParams{ID: id, Name: name})
	if err != nil {
		return Workspace{}, fmt.Errorf("rename workspace %s: %w", id, err)
	}
	return Workspace{ID: row.ID, Slug: row.Slug, Name: row.Name, IsPersonal: row.IsPersonal, CreatedAt: row.CreatedAt.Time}, nil
}

// Delete сносит пространство со всем содержимым (каскад по FK). Личное не
// удаляется — сторож стоит в самом запросе; ноль строк означает «не удалили», и
// разбирает это сервис.
func (Repo) Delete(ctx context.Context, db postgres.DBTX, id uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteWorkspace(ctx, id)
	if err != nil {
		return 0, fmt.Errorf("delete workspace %s: %w", id, err)
	}
	return n, nil
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
	return Workspace{ID: row.ID, Slug: row.Slug, Name: row.Name, IsPersonal: row.IsPersonal, CreatedAt: row.CreatedAt.Time}, nil
}

// UserIDByEmail — pgx.ErrNoRows означает «такого аккаунта ещё нет», и это
// AddMember добавляет участника с указанной ролью (вход по ссылке).
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

// DemoteOwner и PromoteToOwner — две половины передачи владения. Порознь ни одна
// не имеет смысла: между ними пространство остаётся либо без владельца, либо с
// двумя. Вызываются ТОЛЬКО из TransferOwnership, в одной транзакции и в этом
// порядке — частичный уникальный индекс (0016) проверяется на каждом операторе.
//
// Оба возвращают число строк: ноль — не ошибка БД, а несостоявшееся условие
// («он уже не владелец», «его нет в пространстве»), и разбирает его сервис.
func (Repo) DemoteOwner(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DemoteOwner(ctx, postgres.DemoteOwnerParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if err != nil {
		return 0, fmt.Errorf("demote owner of %s: %w", workspaceID, err)
	}
	return n, nil
}

func (Repo) PromoteToOwner(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).PromoteToOwner(ctx, postgres.PromoteToOwnerParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if err != nil {
		return 0, fmt.Errorf("promote %s to owner of %s: %w", userID, workspaceID, err)
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

// --- Ссылки-приглашения (0058) ---
//
// Токен здесь СЫРОЙ, а не хеш: единственное такое место в продукте, довод — в
// ADR §10 и в шапке миграции.

func (Repo) CreateJoinLink(ctx context.Context, db postgres.DBTX, token string, workspaceID uuid.UUID, role string, createdBy uuid.UUID, expiresAt time.Time) error {
	if err := postgres.New(db).CreateJoinLink(ctx, postgres.CreateJoinLinkParams{
		Token:       token,
		WorkspaceID: workspaceID,
		Role:        role,
		CreatedBy:   createdBy,
		ExpiresAt:   pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return fmt.Errorf("create join link: %w", err)
	}
	return nil
}

// RevokeJoinLink возвращает число погашенных строк: 0 означает «живой ссылки не
// было», и это законный исход, а не ошибка.
func (Repo) RevokeJoinLink(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).RevokeJoinLink(ctx, workspaceID)
	if err != nil {
		return 0, fmt.Errorf("revoke join link of %s: %w", workspaceID, err)
	}
	return n, nil
}

// ActiveJoinLink отдаёт живую ссылку пространства, ВКЛЮЧАЯ истёкшую: срок
// разбирает сервис — кабинету надо сказать «истекла», а не «её нет».
func (Repo) ActiveJoinLink(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) (JoinLink, error) {
	row, err := postgres.New(db).GetActiveJoinLink(ctx, workspaceID)
	if err != nil {
		return JoinLink{}, fmt.Errorf("get active join link of %s: %w", workspaceID, err)
	}
	return JoinLink{
		Token: row.Token, WorkspaceID: row.WorkspaceID,
		Role: Role(row.Role), ExpiresAt: row.ExpiresAt.Time,
	}, nil
}

func (Repo) JoinLinkByToken(ctx context.Context, db postgres.DBTX, token string) (JoinLink, error) {
	row, err := postgres.New(db).GetJoinLinkByToken(ctx, token)
	if err != nil {
		return JoinLink{}, fmt.Errorf("get join link by token: %w", err)
	}
	return JoinLink{
		Token: row.Token, WorkspaceID: row.WorkspaceID, WorkspaceName: row.WorkspaceName,
		Role: Role(row.Role), ExpiresAt: row.ExpiresAt.Time,
	}, nil
}

func (Repo) PurgeExpiredJoinLinks(ctx context.Context, db postgres.DBTX) (int64, error) {
	n, err := postgres.New(db).PurgeExpiredJoinLinks(ctx)
	if err != nil {
		return 0, fmt.Errorf("purge expired join links: %w", err)
	}
	return n, nil
}
