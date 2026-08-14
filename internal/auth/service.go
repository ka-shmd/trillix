package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	netmail "net/mail"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/postgres"
)

const (
	personalWorkspaceName = "Личное пространство"
	roleOwner             = "owner"

	// defaultPlanCode — план личного воркспейса при регистрации (0014, фаза 17).
	// Уже существовавшие на момент миграции воркспейсы сидят на legacy_free —
	// грандфазеринг делается миграцией, а не этой константой.
	defaultPlanCode = "free"

	minPasswordLen = 8
	maxPasswordLen = 128

	sessionTokenBytes   = 32 // 256 бит энтропии
	uniqueViolationCode = "23505"

	// DefaultSessionTTL — время жизни сессии (и cookie). Пока константа; станет
	// конфигом при появлении .env.prod-local (фаза 7).
	DefaultSessionTTL = 30 * 24 * time.Hour

	// passwordResetTTL — время жизни ссылки сброса пароля. Короткое: ссылка даёт
	// смену пароля, дольше жить ей незачем.
	passwordResetTTL = 30 * time.Minute
	// resetTokenBytes — энтропия сырого токена сброса (256 бит, как у сессии).
	resetTokenBytes = 32
	// emailVerificationTTL — окно жизни ссылки подтверждения email. Длиннее
	// сброса: подтверждение не срочно, письмо могут открыть не сразу.
	emailVerificationTTL = 24 * time.Hour
)

// Store — интерфейс доступа к данным auth, объявленный на стороне потребителя
// (сервиса). Реализация — Repo; в тестах подменяется фейком. Методы принимают
// исполнителя (postgres.DBTX: пул или транзакция).
type Store interface {
	CreateUser(ctx context.Context, db postgres.DBTX, id uuid.UUID, email string, passwordHash *string) (User, error)
	GetUserByIdentity(ctx context.Context, db postgres.DBTX, provider, providerUserID string) (User, error)
	CreateIdentity(ctx context.Context, db postgres.DBTX, provider, providerUserID string, userID uuid.UUID, providerEmail string) error
	SetIdentityEmail(ctx context.Context, db postgres.DBTX, provider, providerUserID, providerEmail string) error
	ListIdentities(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]Identity, error)
	LockIdentities(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]string, error)
	DeleteIdentity(ctx context.Context, db postgres.DBTX, userID uuid.UUID, provider string) (int64, error)
	GetUserByEmail(ctx context.Context, db postgres.DBTX, email string) (User, error)
	GetUserByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (User, error)
	EmailTaken(ctx context.Context, db postgres.DBTX, email string) (bool, error)
	MarkUserDeleted(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (bool, error)
	CreateWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string, personalUserID uuid.UUID) (Workspace, error)
	AddWorkspaceMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID, role string) error
	CreateSubscription(ctx context.Context, db postgres.DBTX, userID uuid.UUID, planCode string) error
	CreateSession(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, expiresAt time.Time) error
	GetSessionUser(ctx context.Context, db postgres.DBTX, tokenHash []byte) (User, error)
	DeleteSession(ctx context.Context, db postgres.DBTX, tokenHash []byte) error
	DeleteSessionsByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error
	DeleteExpiredSessions(ctx context.Context, db postgres.DBTX) (int64, error)
	UpdateProfile(ctx context.Context, db postgres.DBTX, userID uuid.UUID, firstName, lastName *string) (User, error)
	FillEmptyProfile(ctx context.Context, db postgres.DBTX, userID uuid.UUID, firstName, lastName *string) (User, error)
	SetUserPassword(ctx context.Context, db postgres.DBTX, userID uuid.UUID, hash string) error
	CreatePasswordResetToken(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, expiresAt time.Time) error
	ConsumePasswordResetToken(ctx context.Context, db postgres.DBTX, tokenHash []byte) (uuid.UUID, error)
	DeleteExpiredPasswordResetTokens(ctx context.Context, db postgres.DBTX) (int64, error)
	CreateEmailVerificationToken(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, expiresAt time.Time) error
	ConsumeEmailVerificationToken(ctx context.Context, db postgres.DBTX, tokenHash []byte) (uuid.UUID, error)
	MarkEmailVerified(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error
	CreateEmailChangeToken(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, newEmail string, expiresAt time.Time) error
	ConsumeEmailChangeToken(ctx context.Context, db postgres.DBTX, tokenHash []byte) (uuid.UUID, string, error)
	UpdateUserEmail(ctx context.Context, db postgres.DBTX, userID uuid.UUID, email string) (User, error)
	DeleteExpiredEmailChangeTokens(ctx context.Context, db postgres.DBTX) (int64, error)
	DeleteExpiredEmailVerificationTokens(ctx context.Context, db postgres.DBTX) (int64, error)
	UpsertTOTPSecret(ctx context.Context, db postgres.DBTX, userID uuid.UUID, secret []byte) error
	GetTOTP(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (TOTPState, error)
	ConfirmTOTP(ctx context.Context, db postgres.DBTX, userID uuid.UUID, step int64) error
	MarkTOTPStep(ctx context.Context, db postgres.DBTX, userID uuid.UUID, step int64) (bool, error)
	DeleteTOTP(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error
	CreateRecoveryCode(ctx context.Context, db postgres.DBTX, codeHash []byte, userID uuid.UUID) error
	ConsumeRecoveryCode(ctx context.Context, db postgres.DBTX, codeHash []byte, userID uuid.UUID) (bool, error)
	DeleteRecoveryCodes(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error
}

var _ Store = Repo{}

// mailEnqueuer — узкая зависимость от почтового модуля: положить письмо в outbox
// (объявлена на стороне потребителя; реализация — *mail.Service). Принимает
// исполнителя, чтобы письмо писалось в той же транзакции, что и токен сброса
// (transactional outbox).
type mailEnqueuer interface {
	EnqueueEmail(ctx context.Context, db postgres.DBTX, msg mail.EmailMessage) error
}

// Transactor открывает транзакцию (без знания о конкретном пуле). Реализация —
// postgres.TxRunner; в тестах — фейк, выполняющий fn без реальной БД.
type Transactor interface {
	WithTx(ctx context.Context, fn func(pgx.Tx) error) error
}

// Service — бизнес-логика аутентификации.
type Service struct {
	db         postgres.DBTX // пул: для нетранзакционных операций (чтение, сессии)
	tx         Transactor    // для атомарных многошаговых операций (регистрация)
	repo       Store
	mail       mailEnqueuer
	sessionTTL time.Duration
	// appBaseURL — origin кабинета, из которого строится ссылка сброса в письме
	// (${appBaseURL}/reset-password?token=…). Совпадает с cfg.AppOrigin.
	appBaseURL string
	// totpSecretKey — сырой секрет окружения (FORM_TOKEN_SECRET), из которого
	// HKDF выводит ключ шифрования секретов второго фактора. Пустой = второй
	// фактор не сконфигурирован, и его эндпоинты отвечают ошибкой, а не пишут
	// в базу мусор (фаза 23, слайс F).
	totpSecretKey []byte
	// teams — источник ответа «мешают ли удалению аккаунта его команды»
	// (реализация — *workspaces.Service, подключается WithTeams). nil =
	// удаление аккаунта не сконфигурировано и отвечает ошибкой, а не догадкой.
	teams teamOwnership
}

// WithTeams подключает вопрос о владении пространствами (нужен удалению
// аккаунта, слайс G). Отдельный метод, а не аргумент NewService: workspaces
// собирается ПОЗЖЕ auth — его хендлер стоит на RequireAuth.
func (s *Service) WithTeams(t teamOwnership) *Service {
	s.teams = t
	return s
}

// WithTOTPKey подключает шифрование секретов второго фактора. Отдельный метод,
// а не седьмой аргумент NewService: ключ параметризует один узел, а не всю
// сборку сервиса (тот же приём, что у WithPasswordReset у транспорта).
func (s *Service) WithTOTPKey(key []byte) *Service {
	s.totpSecretKey = key
	return s
}

func NewService(db postgres.DBTX, tx Transactor, repo Store, mailer mailEnqueuer, sessionTTL time.Duration, appBaseURL string) *Service {
	return &Service{db: db, tx: tx, repo: repo, mail: mailer, sessionTTL: sessionTTL, appBaseURL: appBaseURL}
}

// Register создаёт пользователя, его личный воркспейс и членство одной
// транзакцией (инвариант ARCHITECTURE §3.3), в ней же ставит в очередь письмо
// подтверждения email (transactional outbox), затем открывает сессию. Возвращает
// пользователя и сырой токен сессии (в БД лёг только его SHA-256).
func (s *Service) Register(ctx context.Context, email, password string) (User, string, error) {
	email = normalizeEmail(email)
	if err := validateCredentials(email, password); err != nil {
		return User{}, "", err
	}

	hash, err := HashPassword(password)
	if err != nil {
		return User{}, "", err
	}

	userID := domain.NewID()
	wsID := domain.NewID()

	var user User
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		u, e := s.repo.CreateUser(ctx, tx, userID, email, &hash)
		if e != nil {
			if isUniqueViolation(e) {
				return domain.ErrEmailTaken
			}
			return e
		}
		user = u
		if _, e := s.repo.CreateWorkspace(ctx, tx, wsID, personalWorkspaceName, userID); e != nil {
			return e
		}
		if e := s.repo.AddWorkspaceMember(ctx, tx, wsID, userID, roleOwner); e != nil {
			return e
		}
		if e := s.repo.CreateSubscription(ctx, tx, userID, defaultPlanCode); e != nil {
			return e
		}
		return s.enqueueVerificationEmail(ctx, tx, user)
	})
	if err != nil {
		return User{}, "", err
	}

	token, err := s.createSession(ctx, user.ID)
	if err != nil {
		return User{}, "", err
	}
	return user, token, nil
}

// Login проверяет пароль и открывает сессию. Время ответа одинаково для
// «нет такого email» и «неверный пароль»: в обоих случаях выполняется одна
// argon2-проверка (для несуществующего email — против фиктивного хеша).
func (s *Service) Login(ctx context.Context, email, password string) (User, string, error) {
	email = normalizeEmail(email)

	user, err := s.repo.GetUserByEmail(ctx, s.db, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			equalizeTiming(password)
			return User{}, "", domain.ErrInvalidCredentials
		}
		return User{}, "", err
	}

	// Аккаунт без пароля (заведён через провайдера, миграция 0009): войти
	// паролем в него нельзя. Отвечаем как на неверный пароль — и по тексту,
	// и по времени: иначе «этот email заведён через Яндекс» становится
	// наблюдаемым снаружи, а вместе с ним и способ входа в чужой аккаунт.
	if user.PasswordHash == nil {
		equalizeTiming(password)
		return User{}, "", domain.ErrInvalidCredentials
	}

	ok, err := VerifyPassword(*user.PasswordHash, password)
	if err != nil {
		return User{}, "", err
	}
	if !ok {
		return User{}, "", domain.ErrInvalidCredentials
	}

	// Пароль верен — но это ещё не вход, если включён второй фактор (слайс F).
	return s.sessionOrChallenge(ctx, user)
}

// Logout удаляет сессию по её токену. Отсутствие сессии — не ошибка.
func (s *Service) Logout(ctx context.Context, token string) error {
	if err := s.repo.DeleteSession(ctx, s.db, hashToken(token)); err != nil {
		return fmt.Errorf("logout: %w", err)
	}
	return nil
}

// UserByToken возвращает пользователя по живой сессии (для RequireAuth и /me).
// Нет сессии или истекла — domain.ErrUnauthorized.
func (s *Service) UserByToken(ctx context.Context, token string) (User, error) {
	user, err := s.repo.GetSessionUser(ctx, s.db, hashToken(token))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return User{}, domain.ErrUnauthorized
		}
		return User{}, fmt.Errorf("user by token: %w", err)
	}
	return user, nil
}

// UserByEmail возвращает пользователя по email (нормализуя его). Нет такого —
// domain.ErrNotFound. Нужен утилитам вроде сидирования, где надо найти уже
// существующего пользователя; в обычном потоке аутентификации не используется.
func (s *Service) UserByEmail(ctx context.Context, email string) (User, error) {
	user, err := s.repo.GetUserByEmail(ctx, s.db, normalizeEmail(email))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return User{}, domain.ErrNotFound
		}
		return User{}, fmt.Errorf("user by email: %w", err)
	}
	return user, nil
}

// PurgeExpiredSessions удаляет протухшие сессии; возвращает число удалённых
// строк. Вызывается фоновой периодической задачей (ARCHITECTURE §4.4).
func (s *Service) PurgeExpiredSessions(ctx context.Context) (int64, error) {
	n, err := s.repo.DeleteExpiredSessions(ctx, s.db)
	if err != nil {
		return 0, fmt.Errorf("purge expired sessions: %w", err)
	}
	return n, nil
}

// RequestPasswordReset выдаёт ссылку сброса на email, если такой аккаунт есть.
// Существование аккаунта наружу не раскрывается по ТЕЛУ и КОДУ ответа: нет
// пользователя → тихо выходим, хендлер отвечает тем же 204.
//
// По времени неотличимость неполная (TD-35): главный сток — синхронная отправка
// письма только существующему адресу — устранён (письмо уходит асинхронно через
// outbox), но остаточная разница есть: для существующего адреса синхронно
// выполняются генерация токена и две вставки в транзакции, для несуществующего —
// один SELECT. Разница порядка долей мс, дополнительно размазана rate-limit'ом по
// email и по IP; замер и решение (эквалайзер времени либо принять) — в TD-35.
//
// provider-only аккаунт (password_hash IS NULL) письмо тоже получает: это и есть
// починка TD-34 — владелец адреса задаёт пароль и делает аккаунт достижимым, не
// теряя вход через провайдера.
func (s *Service) RequestPasswordReset(ctx context.Context, email string) error {
	email = normalizeEmail(email)

	user, err := s.repo.GetUserByEmail(ctx, s.db, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("request password reset: %w", err)
	}

	rawToken, err := newToken()
	if err != nil {
		return err
	}
	link := s.appBaseURL + "/reset-password?token=" + url.QueryEscape(rawToken)

	// Токен и письмо — одной транзакцией (transactional outbox): либо и ссылка
	// существует, и письмо поставлено в очередь, либо ничего.
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if e := s.repo.CreatePasswordResetToken(ctx, tx, hashToken(rawToken), user.ID, time.Now().Add(passwordResetTTL)); e != nil {
			return e
		}
		return s.mail.EnqueueEmail(ctx, tx, mail.EmailMessage{
			To:       user.Email,
			Template: mail.TemplatePasswordReset,
			Data:     map[string]any{"link": link},
		})
	})
	if err != nil {
		return fmt.Errorf("request password reset: %w", err)
	}
	return nil
}

// ResetPassword по одноразовому токену ставит новый пароль и рвёт все сессии
// пользователя. Невалидный/использованный/истёкший токен → ErrValidation (единый
// текст, без различения причин). Одноразовость гарантируется атомарным
// потреблением токена (ConsumePasswordResetToken): повтор получает ErrNoRows.
func (s *Service) ResetPassword(ctx context.Context, rawToken, newPassword string) error {
	if err := validatePassword(newPassword); err != nil {
		return err
	}
	hash, err := HashPassword(newPassword)
	if err != nil {
		return err
	}

	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		userID, e := s.repo.ConsumePasswordResetToken(ctx, tx, hashToken(rawToken))
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return fmt.Errorf("%w: ссылка недействительна или устарела", domain.ErrValidation)
			}
			return e
		}
		if e := s.repo.SetUserPassword(ctx, tx, userID, hash); e != nil {
			return e
		}
		return s.repo.DeleteSessionsByUser(ctx, tx, userID)
	})
	if err != nil {
		return err
	}
	return nil
}

// PurgeExpiredPasswordResetTokens удаляет истёкшие токены сброса; возвращает число
// удалённых строк. Вызывается фоновой периодической задачей.
func (s *Service) PurgeExpiredPasswordResetTokens(ctx context.Context) (int64, error) {
	n, err := s.repo.DeleteExpiredPasswordResetTokens(ctx, s.db)
	if err != nil {
		return 0, fmt.Errorf("purge expired password reset tokens: %w", err)
	}
	return n, nil
}

// enqueueVerificationEmail генерирует одноразовый токен подтверждения и кладёт его
// вместе с письмом-ссылкой в одну транзакцию (transactional outbox) — общий код
// регистрации и повторной отправки. tx — исполнитель вызывающей транзакции.
func (s *Service) enqueueVerificationEmail(ctx context.Context, tx postgres.DBTX, user User) error {
	rawToken, err := newToken()
	if err != nil {
		return err
	}
	link := s.appBaseURL + "/verify-email?token=" + url.QueryEscape(rawToken)
	if err := s.repo.CreateEmailVerificationToken(ctx, tx, hashToken(rawToken), user.ID, time.Now().Add(emailVerificationTTL)); err != nil {
		return err
	}
	return s.mail.EnqueueEmail(ctx, tx, mail.EmailMessage{
		To:       user.Email,
		Template: mail.TemplateEmailVerification,
		Data:     map[string]any{"link": link},
	})
}

// VerifyEmail по одноразовому токену помечает email пользователя подтверждённым.
// Невалидный/использованный/истёкший токен → ErrValidation (единый текст).
// Одноразовость — атомарным потреблением токена (повтор получает ErrNoRows).
func (s *Service) VerifyEmail(ctx context.Context, rawToken string) error {
	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		userID, e := s.repo.ConsumeEmailVerificationToken(ctx, tx, hashToken(rawToken))
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return fmt.Errorf("%w: ссылка недействительна или устарела", domain.ErrValidation)
			}
			return e
		}
		return s.repo.MarkEmailVerified(ctx, tx, userID)
	})
}

// ResendVerification повторно отправляет письмо подтверждения текущему
// пользователю. Уже подтверждённому — тихий no-op (без письма и без ошибки), чтобы
// кнопка «отправить ещё раз» не плодила писем после подтверждения.
func (s *Service) ResendVerification(ctx context.Context, user User) error {
	if user.EmailVerifiedAt != nil {
		return nil
	}
	err := s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		return s.enqueueVerificationEmail(ctx, tx, user)
	})
	if err != nil {
		return fmt.Errorf("resend verification: %w", err)
	}
	return nil
}

// PurgeExpiredEmailVerificationTokens удаляет истёкшие токены подтверждения;
// возвращает число удалённых строк. Вызывается фоновой периодической задачей.
func (s *Service) PurgeExpiredEmailVerificationTokens(ctx context.Context) (int64, error) {
	n, err := s.repo.DeleteExpiredEmailVerificationTokens(ctx, s.db)
	if err != nil {
		return 0, fmt.Errorf("purge expired email verification tokens: %w", err)
	}
	return n, nil
}

func (s *Service) createSession(ctx context.Context, userID uuid.UUID) (string, error) {
	token, err := newSessionToken()
	if err != nil {
		return "", err
	}
	if err := s.repo.CreateSession(ctx, s.db, hashToken(token), userID, time.Now().Add(s.sessionTTL)); err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	return token, nil
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func validateCredentials(email, password string) error {
	if _, err := netmail.ParseAddress(email); err != nil {
		return fmt.Errorf("%w: некорректный email", domain.ErrValidation)
	}
	return validatePassword(password)
}

func validatePassword(password string) error {
	if len(password) < minPasswordLen || len(password) > maxPasswordLen {
		return fmt.Errorf("%w: длина пароля должна быть %d–%d символов", domain.ErrValidation, minPasswordLen, maxPasswordLen)
	}
	return nil
}

// newSessionToken — 256-битный случайный токен в base64url (без паддинга).
func newSessionToken() (string, error) {
	b := make([]byte, sessionTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("auth: read session token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// newToken — 256-битный случайный токен в base64url (в БД лёг только его SHA-256,
// как у сессии). Канало-независим: сброс пароля и подтверждение email.
func newToken() (string, error) {
	b := make([]byte, resetTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("auth: read token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashToken — в БД хранится только SHA-256 токена (утечка дампа не даёт сессий).
func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == uniqueViolationCode
}

// equalizeTiming тратит примерно столько же времени, сколько VerifyPassword,
// чтобы ответ на несуществующий email не отличался по времени от неверного
// пароля. Фиктивный хеш считается один раз на процесс.
var (
	dummyHashOnce sync.Once
	dummyHash     string
)

func equalizeTiming(password string) {
	dummyHashOnce.Do(func() {
		dummyHash, _ = HashPassword("timing-equalizer-not-a-real-password")
	})
	_, _ = VerifyPassword(dummyHash, password)
}
