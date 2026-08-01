package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// User — представление пользователя внутри модуля auth (без утечки sqlc-типов
// в service/handler). PasswordHash нужен service'у для Login и наружу не отдаётся;
// nil — у аккаунта нет пароля (заведён через провайдера, миграция 0009), войти
// паролем в него нельзя.
type User struct {
	ID              uuid.UUID
	Email           string
	PasswordHash    *string
	CreatedAt       time.Time
	EmailVerifiedAt *time.Time // nil = email не подтверждён (баннер в кабинете)
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

// CreateUser заводит пользователя. passwordHash == nil — аккаунт без пароля
// (вход только через провайдера).
func (Repo) CreateUser(ctx context.Context, db postgres.DBTX, id uuid.UUID, email string, passwordHash *string) (User, error) {
	row, err := postgres.New(db).CreateUser(ctx, postgres.CreateUserParams{
		ID:           id,
		Email:        email,
		PasswordHash: pgText(passwordHash),
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

func (Repo) CreateSubscription(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, planCode string) error {
	if err := postgres.New(db).CreateSubscription(ctx, postgres.CreateSubscriptionParams{
		WorkspaceID: workspaceID,
		PlanCode:    planCode,
	}); err != nil {
		return fmt.Errorf("create subscription: %w", err)
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

// GetUserByIdentity — пользователь по привязке к провайдеру.
func (Repo) GetUserByIdentity(ctx context.Context, db postgres.DBTX, provider, providerUserID string) (User, error) {
	row, err := postgres.New(db).GetUserByIdentity(ctx, postgres.GetUserByIdentityParams{
		Provider:       provider,
		ProviderUserID: providerUserID,
	})
	if err != nil {
		return User{}, fmt.Errorf("get user by identity: %w", err)
	}
	return userFromRow(row), nil
}

// CreateIdentity привязывает аккаунт провайдера к пользователю.
func (Repo) CreateIdentity(ctx context.Context, db postgres.DBTX, provider, providerUserID string, userID uuid.UUID) error {
	err := postgres.New(db).CreateIdentity(ctx, postgres.CreateIdentityParams{
		Provider:       provider,
		ProviderUserID: providerUserID,
		UserID:         userID,
	})
	if err != nil {
		return fmt.Errorf("create identity: %w", err)
	}
	return nil
}

// SetUserPassword ставит новый хеш пароля (сброс). hash непустой — nil-семантики
// «убрать пароль» тут нет.
func (Repo) SetUserPassword(ctx context.Context, db postgres.DBTX, userID uuid.UUID, hash string) error {
	if err := postgres.New(db).SetUserPassword(ctx, postgres.SetUserPasswordParams{
		ID:           userID,
		PasswordHash: pgtype.Text{String: hash, Valid: true},
	}); err != nil {
		return fmt.Errorf("set user password: %w", err)
	}
	return nil
}

// DeleteSessionsByUser рвёт все сессии пользователя (шаг сброса пароля).
func (Repo) DeleteSessionsByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error {
	if err := postgres.New(db).DeleteSessionsByUser(ctx, userID); err != nil {
		return fmt.Errorf("delete sessions by user: %w", err)
	}
	return nil
}

// CreatePasswordResetToken кладёт одноразовый токен сброса.
func (Repo) CreatePasswordResetToken(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, expiresAt time.Time) error {
	if err := postgres.New(db).CreatePasswordResetToken(ctx, postgres.CreatePasswordResetTokenParams{
		TokenHash: tokenHash,
		UserID:    userID,
		ExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return fmt.Errorf("create password reset token: %w", err)
	}
	return nil
}

// ConsumePasswordResetToken атомарно потребляет токен и возвращает user_id.
// Токен не найден / использован / истёк → pgx.ErrNoRows (сервис маппит в ошибку).
func (Repo) ConsumePasswordResetToken(ctx context.Context, db postgres.DBTX, tokenHash []byte) (uuid.UUID, error) {
	userID, err := postgres.New(db).ConsumePasswordResetToken(ctx, tokenHash)
	if err != nil {
		return uuid.Nil, err // включая pgx.ErrNoRows — различает вызывающий
	}
	return userID, nil
}

// DeleteExpiredPasswordResetTokens удаляет истёкшие токены; возвращает число строк.
func (Repo) DeleteExpiredPasswordResetTokens(ctx context.Context, db postgres.DBTX) (int64, error) {
	n, err := postgres.New(db).DeleteExpiredPasswordResetTokens(ctx)
	if err != nil {
		return 0, fmt.Errorf("delete expired password reset tokens: %w", err)
	}
	return n, nil
}

// CreateEmailVerificationToken кладёт одноразовый токен подтверждения email.
func (Repo) CreateEmailVerificationToken(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, expiresAt time.Time) error {
	if err := postgres.New(db).CreateEmailVerificationToken(ctx, postgres.CreateEmailVerificationTokenParams{
		TokenHash: tokenHash,
		UserID:    userID,
		ExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return fmt.Errorf("create email verification token: %w", err)
	}
	return nil
}

// ConsumeEmailVerificationToken атомарно потребляет токен и возвращает user_id.
// Токен не найден / использован / истёк → pgx.ErrNoRows (сервис маппит в ошибку).
func (Repo) ConsumeEmailVerificationToken(ctx context.Context, db postgres.DBTX, tokenHash []byte) (uuid.UUID, error) {
	userID, err := postgres.New(db).ConsumeEmailVerificationToken(ctx, tokenHash)
	if err != nil {
		return uuid.Nil, err // включая pgx.ErrNoRows — различает вызывающий
	}
	return userID, nil
}

// MarkEmailVerified проставляет отметку подтверждения email пользователю.
func (Repo) MarkEmailVerified(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error {
	if err := postgres.New(db).MarkEmailVerified(ctx, userID); err != nil {
		return fmt.Errorf("mark email verified: %w", err)
	}
	return nil
}

// DeleteExpiredEmailVerificationTokens удаляет истёкшие токены; возвращает число строк.
func (Repo) DeleteExpiredEmailVerificationTokens(ctx context.Context, db postgres.DBTX) (int64, error) {
	n, err := postgres.New(db).DeleteExpiredEmailVerificationTokens(ctx)
	if err != nil {
		return 0, fmt.Errorf("delete expired email verification tokens: %w", err)
	}
	return n, nil
}

func userFromRow(u postgres.User) User {
	return User{
		ID:              u.ID,
		Email:           u.Email,
		PasswordHash:    ptrStr(u.PasswordHash),
		CreatedAt:       u.CreatedAt.Time,
		EmailVerifiedAt: ptrTime(u.EmailVerifiedAt),
	}
}

// ptrTime переводит nullable timestamptz из sqlc в *time.Time: NULL → nil.
func ptrTime(v pgtype.Timestamptz) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time
	return &t
}

// ptrStr переводит nullable text из sqlc (pgtype.Text) в *string: NULL → nil.
func ptrStr(v pgtype.Text) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

// pgText переводит *string в pgtype.Text для параметров запроса: nil → NULL.
func pgText(s *string) pgtype.Text {
	if s == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *s, Valid: true}
}
