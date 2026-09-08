package auth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
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
	// AvatarKey — ключ картинки аватара в объектном хранилище (0028), не URL:
	// адрес собирается из MEDIA_BASE_URL (docs/S3.md §5). nil = аватара нет,
	// кабинет рисует кружок с инициалами.
	AvatarKey *string
	// TwoFactorEnabled — включён ли второй фактор (0056). Едет в самом User, а не
	// отдельным запросом: его спрашивает КАЖДЫЙ путь входа (sessionOrChallenge).
	TwoFactorEnabled bool
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

// IsAdmin — администратор ли пользователь (0059). Отдельный запрос вместо поля
// в User: флаг спрашивает одна ручка — заведение публичного шаблона, — и
// таскать его через каждый путь входа ради неё незачем.
func (Repo) IsAdmin(ctx context.Context, db postgres.DBTX, id uuid.UUID) (bool, error) {
	admin, err := postgres.New(db).IsUserAdmin(ctx, id)
	if err != nil {
		return false, fmt.Errorf("is user admin: %w", err)
	}
	return admin, nil
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
func (Repo) CreateWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID, slug, name string, personalUserID uuid.UUID) (Workspace, error) {
	row, err := postgres.New(db).CreatePersonalWorkspace(ctx, postgres.CreatePersonalWorkspaceParams{
		ID:   id,
		Name: name,
		// МИНА: slug пустым оставить нельзя — колонка UNIQUE (0035), и вторая
		// регистрация упала бы на дубле пустой строки. Компилятор этого не ловит:
		// незаполненное поле параметров — валидный нулевой string.
		Slug:           slug,
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

// LockIdentities — привязки аккаунта под блокировкой до конца транзакции (гейт
// «останется ли способ войти»). Вызывать только с tx: на пуле блокировка снимется
// тем же запросом, и гейт снова станет решением по устаревшему снимку.
func (Repo) LockIdentities(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]string, error) {
	providers, err := postgres.New(db).LockIdentities(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("lock identities: %w", err)
	}
	return providers, nil
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

// SetAvatarKey ставит ключ картинки аватара; nil — снять (NULL в БД).
func (Repo) SetAvatarKey(ctx context.Context, db postgres.DBTX, userID uuid.UUID, key *string) (User, error) {
	row, err := postgres.New(db).SetUserAvatarKey(ctx, postgres.SetUserAvatarKeyParams{
		ID:        userID,
		AvatarKey: pgText(key),
	})
	if err != nil {
		return User{}, fmt.Errorf("set avatar key: %w", err)
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

// EmailTaken — занят ли адрес кем угодно, ВКЛЮЧАЯ удалённые аккаунты (слайс G).
func (Repo) EmailTaken(ctx context.Context, db postgres.DBTX, email string) (bool, error) {
	taken, err := postgres.New(db).EmailTaken(ctx, email)
	if err != nil {
		return false, fmt.Errorf("email taken: %w", err)
	}
	return taken, nil
}

// MarkUserDeleted помечает аккаунт удалённым; false — пометка уже стояла.
func (Repo) MarkUserDeleted(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (bool, error) {
	n, err := postgres.New(db).MarkUserDeleted(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("mark user deleted: %w", err)
	}
	return n > 0, nil
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
		ID:               u.ID,
		Email:            u.Email,
		PasswordHash:     ptrStr(u.PasswordHash),
		CreatedAt:        u.CreatedAt.Time,
		EmailVerifiedAt:  ptrTime(u.EmailVerifiedAt),
		FirstName:        ptrStr(u.FirstName),
		LastName:         ptrStr(u.LastName),
		AvatarKey:        ptrStr(u.AvatarKey),
		TwoFactorEnabled: u.TwoFactorEnabled,
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

// KnownDevice — браузер, который уже предъявлял код входа. TokenHash наружу не
// отдаётся: экран настроек сравнивает его с хешем своей cookie, чтобы пометить
// текущую строку.
type KnownDevice struct {
	ID         uuid.UUID
	TokenHash  []byte
	Label      string
	CreatedAt  time.Time
	LastSeenAt time.Time
}

func (Repo) SetTwoFactorEnabled(ctx context.Context, db postgres.DBTX, userID uuid.UUID, enabled bool) error {
	if err := postgres.New(db).SetTwoFactorEnabled(ctx, postgres.SetTwoFactorEnabledParams{
		ID: userID, TwoFactorEnabled: enabled,
	}); err != nil {
		return fmt.Errorf("set two factor enabled: %w", err)
	}
	return nil
}

func (Repo) UpsertLoginCode(ctx context.Context, db postgres.DBTX, userID uuid.UUID, codeHash []byte, expiresAt time.Time) error {
	if err := postgres.New(db).UpsertLoginCode(ctx, postgres.UpsertLoginCodeParams{
		UserID:    userID,
		CodeHash:  codeHash,
		ExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return fmt.Errorf("upsert login code: %w", err)
	}
	return nil
}

// ConsumeLoginCodeAttempt списывает попытку и отдаёт хеш для сверки.
// pgx.ErrNoRows — кода нет, он просрочен или попытки кончились; звонящий
// обязан отвечать на все три одинаково.
func (Repo) ConsumeLoginCodeAttempt(ctx context.Context, db postgres.DBTX, userID uuid.UUID, maxAttempts int16) ([]byte, error) {
	hash, err := postgres.New(db).ConsumeLoginCodeAttempt(ctx, postgres.ConsumeLoginCodeAttemptParams{
		UserID: userID, Attempts: maxAttempts,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		return nil, fmt.Errorf("consume login code attempt: %w", err)
	}
	return hash, nil
}

func (Repo) DeleteLoginCode(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error {
	if err := postgres.New(db).DeleteLoginCode(ctx, userID); err != nil {
		return fmt.Errorf("delete login code: %w", err)
	}
	return nil
}

// DeleteExpiredLoginCodes — уборщик; возвращает число удалённых строк для лога.
func (Repo) DeleteExpiredLoginCodes(ctx context.Context, db postgres.DBTX) (int64, error) {
	n, err := postgres.New(db).DeleteExpiredLoginCodes(ctx)
	if err != nil {
		return 0, fmt.Errorf("delete expired login codes: %w", err)
	}
	return n, nil
}

func (Repo) CreateKnownDevice(ctx context.Context, db postgres.DBTX, id, userID uuid.UUID, tokenHash []byte, label string, expiresAt time.Time) error {
	if err := postgres.New(db).CreateKnownDevice(ctx, postgres.CreateKnownDeviceParams{
		ID:        id,
		UserID:    userID,
		TokenHash: tokenHash,
		Label:     label,
		ExpiresAt: pgtype.Timestamptz{Time: expiresAt, Valid: true},
	}); err != nil {
		return fmt.Errorf("create known device: %w", err)
	}
	return nil
}

// TouchKnownDevice отмечает вход с этого браузера; false — устройство незнакомо
// или знакомство истекло, то есть нужен код.
func (Repo) TouchKnownDevice(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID) (bool, error) {
	n, err := postgres.New(db).TouchKnownDevice(ctx, postgres.TouchKnownDeviceParams{
		TokenHash: tokenHash, UserID: userID,
	})
	if err != nil {
		return false, fmt.Errorf("touch known device: %w", err)
	}
	return n > 0, nil
}

func (Repo) ListKnownDevices(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]KnownDevice, error) {
	rows, err := postgres.New(db).ListKnownDevices(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list known devices: %w", err)
	}
	out := make([]KnownDevice, 0, len(rows))
	for _, r := range rows {
		out = append(out, KnownDevice{
			ID:         r.ID,
			TokenHash:  r.TokenHash,
			Label:      r.Label,
			CreatedAt:  r.CreatedAt.Time,
			LastSeenAt: r.LastSeenAt.Time,
		})
	}
	return out, nil
}

// DeleteKnownDevice забывает одно устройство; false — строки не было (повторный
// клик из двух вкладок), и это не авария.
func (Repo) DeleteKnownDevice(ctx context.Context, db postgres.DBTX, id, userID uuid.UUID) (bool, error) {
	n, err := postgres.New(db).DeleteKnownDevice(ctx, postgres.DeleteKnownDeviceParams{ID: id, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("delete known device: %w", err)
	}
	return n > 0, nil
}

func (Repo) DeleteKnownDevicesByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error {
	if err := postgres.New(db).DeleteKnownDevicesByUser(ctx, userID); err != nil {
		return fmt.Errorf("delete known devices: %w", err)
	}
	return nil
}

func (Repo) DeleteExpiredKnownDevices(ctx context.Context, db postgres.DBTX) (int64, error) {
	n, err := postgres.New(db).DeleteExpiredKnownDevices(ctx)
	if err != nil {
		return 0, fmt.Errorf("delete expired known devices: %w", err)
	}
	return n, nil
}

// DeleteSessionsByUserExcept рвёт все сессии, кроме одной — той, из которой
// нажали «забыть устройства».
func (Repo) DeleteSessionsByUserExcept(ctx context.Context, db postgres.DBTX, userID uuid.UUID, tokenHash []byte) error {
	if err := postgres.New(db).DeleteSessionsByUserExcept(ctx, postgres.DeleteSessionsByUserExceptParams{
		UserID: userID, TokenHash: tokenHash,
	}); err != nil {
		return fmt.Errorf("delete sessions except current: %w", err)
	}
	return nil
}
