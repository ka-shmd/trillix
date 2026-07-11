package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/postgres"
)

const (
	personalWorkspaceName = "Personal"
	roleOwner             = "owner"

	minPasswordLen = 8
	maxPasswordLen = 128

	sessionTokenBytes   = 32 // 256 бит энтропии
	uniqueViolationCode = "23505"
)

// Store — интерфейс доступа к данным auth, объявленный на стороне потребителя
// (сервиса). Реализация — Repo; в тестах подменяется фейком. Методы принимают
// исполнителя (postgres.DBTX: пул или транзакция).
type Store interface {
	CreateUser(ctx context.Context, db postgres.DBTX, id uuid.UUID, email, passwordHash string) (User, error)
	GetUserByEmail(ctx context.Context, db postgres.DBTX, email string) (User, error)
	CreateWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string) (Workspace, error)
	AddWorkspaceMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID, role string) error
	CreateSession(ctx context.Context, db postgres.DBTX, tokenHash []byte, userID uuid.UUID, expiresAt time.Time) error
	GetSessionUser(ctx context.Context, db postgres.DBTX, tokenHash []byte) (User, error)
	DeleteSession(ctx context.Context, db postgres.DBTX, tokenHash []byte) error
	DeleteExpiredSessions(ctx context.Context, db postgres.DBTX) (int64, error)
}

var _ Store = Repo{}

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
	sessionTTL time.Duration
}

func NewService(db postgres.DBTX, tx Transactor, repo Store, sessionTTL time.Duration) *Service {
	return &Service{db: db, tx: tx, repo: repo, sessionTTL: sessionTTL}
}

// Register создаёт пользователя, его личный воркспейс и членство одной
// транзакцией (инвариант ARCHITECTURE §3.3), затем открывает сессию. Возвращает
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
		u, e := s.repo.CreateUser(ctx, tx, userID, email, hash)
		if e != nil {
			if isUniqueViolation(e) {
				return domain.ErrEmailTaken
			}
			return e
		}
		user = u
		if _, e := s.repo.CreateWorkspace(ctx, tx, wsID, personalWorkspaceName); e != nil {
			return e
		}
		return s.repo.AddWorkspaceMember(ctx, tx, wsID, userID, roleOwner)
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

	ok, err := VerifyPassword(user.PasswordHash, password)
	if err != nil {
		return User{}, "", err
	}
	if !ok {
		return User{}, "", domain.ErrInvalidCredentials
	}

	token, err := s.createSession(ctx, user.ID)
	if err != nil {
		return User{}, "", err
	}
	return user, token, nil
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
	if _, err := mail.ParseAddress(email); err != nil {
		return fmt.Errorf("%w: некорректный email", domain.ErrValidation)
	}
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
