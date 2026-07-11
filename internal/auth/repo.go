package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trierra/internal/postgres"
)

// User — представление пользователя внутри модуля auth (без утечки sqlc-типов
// в service/handler). PasswordHash нужен service'у для Login и наружу не отдаётся.
type User struct {
	ID           uuid.UUID
	Email        string
	PasswordHash string
	CreatedAt    time.Time
}

// Workspace — личный воркспейс пользователя.
type Workspace struct {
	ID        uuid.UUID
	Name      string
	CreatedAt time.Time
}

// Repo — доступ к данным auth поверх sqlc-запросов. Методы принимают исполнителя
// (postgres.DBTX — пул или транзакция); транзакции открывает service через
// postgres.WithTx, сам repo их не заводит.
type Repo struct{}

func (Repo) CreateUser(ctx context.Context, db postgres.DBTX, id uuid.UUID, email, passwordHash string) (User, error) {
	row, err := postgres.New(db).CreateUser(ctx, postgres.CreateUserParams{
		ID:           id,
		Email:        email,
		PasswordHash: passwordHash,
	})
	if err != nil {
		return User{}, fmt.Errorf("create user: %w", err)
	}
	return userFromRow(row), nil
}

func (Repo) GetUserByEmail(ctx context.Context, db postgres.DBTX, email string) (User, error) {
	row, err := postgres.New(db).GetUserByEmail(ctx, email)
	if err != nil {
		return User{}, fmt.Errorf("get user by email: %w", err)
	}
	return userFromRow(row), nil
}

func (Repo) CreateWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string) (Workspace, error) {
	row, err := postgres.New(db).CreateWorkspace(ctx, postgres.CreateWorkspaceParams{ID: id, Name: name})
	if err != nil {
		return Workspace{}, fmt.Errorf("create workspace: %w", err)
	}
	return Workspace{ID: row.ID, Name: row.Name, CreatedAt: row.CreatedAt.Time}, nil
}

func (Repo) AddWorkspaceMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID, role string) error {
	if err := postgres.New(db).CreateWorkspaceMember(ctx, postgres.CreateWorkspaceMemberParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
		Role:        role,
	}); err != nil {
		return fmt.Errorf("add workspace member: %w", err)
	}
	return nil
}

func (Repo) CreateSession(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, expiresAt time.Time) error {
	if err := postgres.New(db).CreateSession(ctx, postgres.CreateSessionParams{
		TokenHash: tokenHash,
		UserID:    userID,
		ExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return fmt.Errorf("create session: %w", err)
	}
	return nil
}

// GetSessionUser возвращает пользователя по живой (не истёкшей) сессии.
func (Repo) GetSessionUser(ctx context.Context, db postgres.DBTX, tokenHash []byte) (User, error) {
	row, err := postgres.New(db).GetSessionUser(ctx, tokenHash)
	if err != nil {
		return User{}, fmt.Errorf("get session user: %w", err)
	}
	return userFromRow(row), nil
}

func (Repo) DeleteSession(ctx context.Context, db postgres.DBTX, tokenHash []byte) error {
	if err := postgres.New(db).DeleteSession(ctx, tokenHash); err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	return nil
}

// DeleteExpiredSessions удаляет протухшие сессии; возвращает число удалённых
// строк (для лога фоновой чистки — шаг 6).
func (Repo) DeleteExpiredSessions(ctx context.Context, db postgres.DBTX) (int64, error) {
	n, err := postgres.New(db).DeleteExpiredSessions(ctx)
	if err != nil {
		return 0, fmt.Errorf("delete expired sessions: %w", err)
	}
	return n, nil
}

func userFromRow(u postgres.User) User {
	return User{
		ID:           u.ID,
		Email:        u.Email,
		PasswordHash: u.PasswordHash,
		CreatedAt:    u.CreatedAt.Time,
	}
}
