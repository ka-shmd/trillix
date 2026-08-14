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
	// FirstName/LastName — имя человека (0021). nil = не указано: кабинет тогда
	// показывает email. Ничего не гейтят и обязательными не становятся.
	FirstName *string
	LastName  *string
}

// Identity — способ входа через провайдера, как его видит экран настроек.
// ProviderUserID наружу не отдаётся: человеку он ничего не говорит, а карточку
// подписывает адрес.
type Identity struct {
	Provider      string
	ProviderEmail *string // nil — привязка старше 0021, адрес приедет на ближайшем входе
	CreatedAt     time.Time
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

// GetUserByID — пользователь по id (второй шаг входа: сессии ещё нет).
func (Repo) GetUserByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (User, error) {
	row, err := postgres.New(db).GetUserByID(ctx, id)
	if err != nil {
		return User{}, fmt.Errorf("get user by id: %w", err)
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

// CreateWorkspace заводит ЛИЧНОЕ пространство: personal_user_id заполнен всегда
// (регистрация — единственный вызывающий). Командные пространства заводит
// workspaces со своим запросом и NULL в этой колонке.
func (Repo) CreateWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string, personalUserID uuid.UUID) (Workspace, error) {
	row, err := postgres.New(db).CreatePersonalWorkspace(ctx, postgres.CreatePersonalWorkspaceParams{
		ID:             id,
		Name:           name,
		PersonalUserID: pgtype.UUID{Bytes: personalUserID, Valid: true},
	})
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

// CreateSubscription заводит подписку АККАУНТА (0016): субъект тарифа —
// пользователь, воркспейс работает по плану своего владельца.
func (Repo) CreateSubscription(ctx context.Context, db postgres.DBTX, userID uuid.UUID, planCode string) error {
	if err := postgres.New(db).CreateSubscription(ctx, postgres.CreateSubscriptionParams{
		UserID:   userID,
		PlanCode: planCode,
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

// CreateIdentity привязывает аккаунт провайдера к пользователю. providerEmail —
// адрес у провайдера (подпись под карточкой); пустой означает NULL.
func (Repo) CreateIdentity(ctx context.Context, db postgres.DBTX, provider, providerUserID string, userID uuid.UUID, providerEmail string) error {
	err := postgres.New(db).CreateIdentity(ctx, postgres.CreateIdentityParams{
		Provider:       provider,
		ProviderUserID: providerUserID,
		UserID:         userID,
		ProviderEmail:  pgTextOrNull(providerEmail),
	})
	if err != nil {
		return fmt.Errorf("create identity: %w", err)
	}
	return nil
}

// SetIdentityEmail обновляет адрес у провайдера (на каждом входе).
func (Repo) SetIdentityEmail(ctx context.Context, db postgres.DBTX, provider, providerUserID, providerEmail string) error {
	err := postgres.New(db).SetIdentityEmail(ctx, postgres.SetIdentityEmailParams{
		Provider:       provider,
		ProviderUserID: providerUserID,
		ProviderEmail:  pgTextOrNull(providerEmail),
	})
	if err != nil {
		return fmt.Errorf("set identity email: %w", err)
	}
	return nil
}

// ListIdentities — способы входа через провайдеров у аккаунта.
func (Repo) ListIdentities(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]Identity, error) {
	rows, err := postgres.New(db).ListIdentities(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list identities: %w", err)
	}
	out := make([]Identity, 0, len(rows))
	for _, r := range rows {
		out = append(out, Identity{
			Provider:      r.Provider,
			ProviderEmail: ptrStr(r.ProviderEmail),
			CreatedAt:     r.CreatedAt.Time,
		})
	}
	return out, nil
}

// CountIdentities — сколько привязок у аккаунта (гейт «останется ли способ войти»).
func (Repo) CountIdentities(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).CountIdentities(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("count identities: %w", err)
	}
	return n, nil
}

// DeleteIdentity отвязывает провайдера; возвращает число удалённых строк (ноль —
// привязки не было).
func (Repo) DeleteIdentity(ctx context.Context, db postgres.DBTX, userID uuid.UUID, provider string) (int64, error) {
	n, err := postgres.New(db).DeleteIdentity(ctx, postgres.DeleteIdentityParams{UserID: userID, Provider: provider})
	if err != nil {
		return 0, fmt.Errorf("delete identity: %w", err)
	}
	return n, nil
}

// UpdateProfile ставит имя и фамилию целиком; nil — стереть (NULL в БД).
func (Repo) UpdateProfile(ctx context.Context, db postgres.DBTX, userID uuid.UUID, firstName, lastName *string) (User, error) {
	row, err := postgres.New(db).UpdateUserProfile(ctx, postgres.UpdateUserProfileParams{
		ID:        userID,
		FirstName: pgText(firstName),
		LastName:  pgText(lastName),
	})
	if err != nil {
		return User{}, fmt.Errorf("update profile: %w", err)
	}
	return userFromRow(row), nil
}

// FillEmptyProfile заполняет ПУСТЫЕ имя и фамилию (данные провайдера); уже
// заполненное не трогает.
func (Repo) FillEmptyProfile(ctx context.Context, db postgres.DBTX, userID uuid.UUID, firstName, lastName *string) (User, error) {
	row, err := postgres.New(db).FillEmptyProfile(ctx, postgres.FillEmptyProfileParams{
		ID:        userID,
		FirstName: pgText(firstName),
		LastName:  pgText(lastName),
	})
	if err != nil {
		return User{}, fmt.Errorf("fill empty profile: %w", err)
	}
	return userFromRow(row), nil
}

// CreateEmailChangeToken кладёт одноразовый токен смены адреса.
func (Repo) CreateEmailChangeToken(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, newEmail string, expiresAt time.Time) error {
	if err := postgres.New(db).CreateEmailChangeToken(ctx, postgres.CreateEmailChangeTokenParams{
		TokenHash: tokenHash,
		UserID:    userID,
		NewEmail:  newEmail,
		ExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return fmt.Errorf("create email change token: %w", err)
	}
	return nil
}

// ConsumeEmailChangeToken атомарно потребляет токен и отдаёт, чей он и на какой
// адрес. ErrNoRows — нет/использован/истёк (снаружи это один ответ).
func (Repo) ConsumeEmailChangeToken(ctx context.Context, db postgres.DBTX, tokenHash []byte) (uuid.UUID, string, error) {
	row, err := postgres.New(db).ConsumeEmailChangeToken(ctx, tokenHash)
	if err != nil {
		return uuid.Nil, "", err
	}
	return row.UserID, row.NewEmail, nil
}

// UpdateUserEmail переносит адрес аккаунта и помечает его подтверждённым.
func (Repo) UpdateUserEmail(ctx context.Context, db postgres.DBTX, userID uuid.UUID, email string) (User, error) {
	row, err := postgres.New(db).UpdateUserEmail(ctx, postgres.UpdateUserEmailParams{ID: userID, Email: email})
	if err != nil {
		return User{}, fmt.Errorf("update user email: %w", err)
	}
	return userFromRow(row), nil
}

// DeleteExpiredEmailChangeTokens — фоновая чистка (periodic).
func (Repo) DeleteExpiredEmailChangeTokens(ctx context.Context, db postgres.DBTX) (int64, error) {
	n, err := postgres.New(db).DeleteExpiredEmailChangeTokens(ctx)
	if err != nil {
		return 0, fmt.Errorf("delete expired email change tokens: %w", err)
	}
	return n, nil
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
		FirstName:       ptrStr(u.FirstName),
		LastName:        ptrStr(u.LastName),
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

// pgTextOrNull переводит строку в pgtype.Text, считая ПУСТУЮ строку за NULL:
// «провайдер адреса не дал» и «адрес пустой» — одно и то же состояние, и двух
// его представлений в колонке быть не должно.
func pgTextOrNull(s string) pgtype.Text {
	if s == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: s, Valid: true}
}

// pgText переводит *string в pgtype.Text для параметров запроса: nil → NULL.
func pgText(s *string) pgtype.Text {
	if s == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *s, Valid: true}
}

// TOTPState — состояние второго фактора у аккаунта. Secret — шифротекст;
// расшифровывает его сервис, репозиторий про ключ не знает.
type TOTPState struct {
	Secret      []byte
	ConfirmedAt *time.Time // nil = настройка начата, но фактор НЕ включён
	LastStep    *int64     // номер израсходованного шага (защита от повтора кода)
}

// UpsertTOTPSecret кладёт свежий секрет, сбрасывая подтверждение: перезапуск
// настройки обязан обнулять и отметку, и израсходованный шаг.
func (Repo) UpsertTOTPSecret(ctx context.Context, db postgres.DBTX, userID uuid.UUID, secret []byte) error {
	if err := postgres.New(db).UpsertTOTPSecret(ctx, postgres.UpsertTOTPSecretParams{UserID: userID, Secret: secret}); err != nil {
		return fmt.Errorf("upsert totp secret: %w", err)
	}
	return nil
}

func (Repo) GetTOTP(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (TOTPState, error) {
	row, err := postgres.New(db).GetTOTP(ctx, userID)
	if err != nil {
		return TOTPState{}, err
	}
	st := TOTPState{Secret: row.Secret, ConfirmedAt: ptrTime(row.ConfirmedAt)}
	if row.LastStep.Valid {
		v := row.LastStep.Int64
		st.LastStep = &v
	}
	return st, nil
}

func (Repo) ConfirmTOTP(ctx context.Context, db postgres.DBTX, userID uuid.UUID, step int64) error {
	if err := postgres.New(db).ConfirmTOTP(ctx, postgres.ConfirmTOTPParams{
		UserID:   userID,
		LastStep: pgtype.Int8{Int64: step, Valid: true},
	}); err != nil {
		return fmt.Errorf("confirm totp: %w", err)
	}
	return nil
}

// MarkTOTPStep помечает шаг израсходованным; false — тот же шаг уже отмечен
// (повторное предъявление кода).
func (Repo) MarkTOTPStep(ctx context.Context, db postgres.DBTX, userID uuid.UUID, step int64) (bool, error) {
	n, err := postgres.New(db).MarkTOTPStep(ctx, postgres.MarkTOTPStepParams{
		UserID:   userID,
		LastStep: pgtype.Int8{Int64: step, Valid: true},
	})
	if err != nil {
		return false, fmt.Errorf("mark totp step: %w", err)
	}
	return n > 0, nil
}

func (Repo) DeleteTOTP(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error {
	if err := postgres.New(db).DeleteTOTP(ctx, userID); err != nil {
		return fmt.Errorf("delete totp: %w", err)
	}
	return nil
}

func (Repo) CreateRecoveryCode(ctx context.Context, db postgres.DBTX, codeHash []byte, userID uuid.UUID) error {
	if err := postgres.New(db).CreateRecoveryCode(ctx, postgres.CreateRecoveryCodeParams{CodeHash: codeHash, UserID: userID}); err != nil {
		return fmt.Errorf("create recovery code: %w", err)
	}
	return nil
}

// ConsumeRecoveryCode атомарно гасит код; false — кода нет или он уже сгорел.
func (Repo) ConsumeRecoveryCode(ctx context.Context, db postgres.DBTX, codeHash []byte, userID uuid.UUID) (bool, error) {
	n, err := postgres.New(db).ConsumeRecoveryCode(ctx, postgres.ConsumeRecoveryCodeParams{CodeHash: codeHash, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("consume recovery code: %w", err)
	}
	return n > 0, nil
}

func (Repo) DeleteRecoveryCodes(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error {
	if err := postgres.New(db).DeleteRecoveryCodes(ctx, userID); err != nil {
		return fmt.Errorf("delete recovery codes: %w", err)
	}
	return nil
}
