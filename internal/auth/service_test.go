package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// fakeTx выполняет транзакционную функцию немедленно, без реальной БД:
// repo-фейк игнорирует переданного исполнителя (nil).
type fakeTx struct{}

func (fakeTx) WithTx(ctx context.Context, fn func(pgx.Tx) error) error { return fn(nil) }

// fakeStore — управляемая реализация Store для юнитов сервиса.
type fakeStore struct {
	user       User
	userExists bool

	createUserErr error

	createdUser      bool
	createdWorkspace bool
	createdMember    bool
	createdSession   bool
	deletedSession   bool

	deleteExpiredN   int64
	deleteExpiredErr error
}

func (f *fakeStore) CreateUser(_ context.Context, _ postgres.DBTX, id uuid.UUID, email, passwordHash string) (User, error) {
	if f.createUserErr != nil {
		return User{}, f.createUserErr
	}
	f.createdUser = true
	return User{ID: id, Email: email, PasswordHash: passwordHash, CreatedAt: time.Now()}, nil
}

func (f *fakeStore) GetUserByEmail(_ context.Context, _ postgres.DBTX, _ string) (User, error) {
	if !f.userExists {
		return User{}, pgx.ErrNoRows
	}
	return f.user, nil
}

func (f *fakeStore) CreateWorkspace(_ context.Context, _ postgres.DBTX, id uuid.UUID, name string) (Workspace, error) {
	f.createdWorkspace = true
	return Workspace{ID: id, Name: name, CreatedAt: time.Now()}, nil
}

func (f *fakeStore) AddWorkspaceMember(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID, _ string) error {
	f.createdMember = true
	return nil
}

func (f *fakeStore) CreateSession(_ context.Context, _ postgres.DBTX, _ []byte, _ uuid.UUID, _ time.Time) error {
	f.createdSession = true
	return nil
}

func (f *fakeStore) GetSessionUser(_ context.Context, _ postgres.DBTX, _ []byte) (User, error) {
	if !f.userExists {
		return User{}, pgx.ErrNoRows
	}
	return f.user, nil
}

func (f *fakeStore) DeleteSession(_ context.Context, _ postgres.DBTX, _ []byte) error {
	f.deletedSession = true
	return nil
}

func (f *fakeStore) DeleteExpiredSessions(_ context.Context, _ postgres.DBTX) (int64, error) {
	return f.deleteExpiredN, f.deleteExpiredErr
}

func newService(store *fakeStore) *Service {
	return NewService(nil, fakeTx{}, store, time.Hour)
}

func TestRegister_Success(t *testing.T) {
	store := &fakeStore{}
	svc := newService(store)

	user, token, err := svc.Register(context.Background(), "  User@Example.COM ", "supersecret")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if user.Email != "user@example.com" {
		t.Fatalf("email не нормализован: %q", user.Email)
	}
	if token == "" {
		t.Fatal("пустой токен сессии")
	}
	if !store.createdUser || !store.createdWorkspace || !store.createdMember || !store.createdSession {
		t.Fatalf("не все шаги регистрации выполнены: %+v", store)
	}
}

func TestRegister_EmailTaken(t *testing.T) {
	store := &fakeStore{createUserErr: &pgconn.PgError{Code: "23505"}}
	svc := newService(store)

	_, _, err := svc.Register(context.Background(), "taken@example.com", "supersecret")
	if !errors.Is(err, domain.ErrEmailTaken) {
		t.Fatalf("err = %v, want ErrEmailTaken", err)
	}
	if store.createdSession {
		t.Fatal("сессия не должна создаваться при занятом email")
	}
}

func TestRegister_ValidationRejectsBadInput(t *testing.T) {
	cases := map[string]struct{ email, password string }{
		"плохой email":    {"not-an-email", "supersecret"},
		"короткий пароль": {"a@b.com", "short"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{}
			svc := newService(store)
			_, _, err := svc.Register(context.Background(), c.email, c.password)
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("err = %v, want ErrValidation", err)
			}
			if store.createdUser {
				t.Fatal("при провале валидации БД не должна трогаться")
			}
		})
	}
}

func TestLogin_Success(t *testing.T) {
	hash, err := HashPassword("correct-password")
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "a@b.com", PasswordHash: hash}}
	svc := newService(store)

	user, token, err := svc.Login(context.Background(), "a@b.com", "correct-password")
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if token == "" || user.Email != "a@b.com" {
		t.Fatalf("неожиданный результат: user=%+v token=%q", user, token)
	}
	if !store.createdSession {
		t.Fatal("сессия не создана")
	}
}

func TestLogin_WrongPassword(t *testing.T) {
	hash, _ := HashPassword("correct-password")
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "a@b.com", PasswordHash: hash}}
	svc := newService(store)

	_, _, err := svc.Login(context.Background(), "a@b.com", "wrong-password")
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("err = %v, want ErrInvalidCredentials", err)
	}
}

func TestLogin_UnknownEmail(t *testing.T) {
	store := &fakeStore{userExists: false}
	svc := newService(store)

	_, _, err := svc.Login(context.Background(), "missing@b.com", "any-password")
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("err = %v, want ErrInvalidCredentials", err)
	}
}

// Ответ на несуществующий email не должен быть заметно быстрее, чем на неверный
// пароль: без выравнивания разница ~1000x (argon2 ~десятки мс против ~мкс),
// поэтому порог «не быстрее чем в 5 раз» надёжен и не флейки.
func TestLogin_TimingEqualized(t *testing.T) {
	hash, _ := HashPassword("correct-password")
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "a@b.com", PasswordHash: hash}}
	svc := newService(store)

	start := time.Now()
	_, _, _ = svc.Login(context.Background(), "a@b.com", "wrong-password")
	wrongPw := time.Since(start)

	store.userExists = false
	start = time.Now()
	_, _, _ = svc.Login(context.Background(), "missing@b.com", "any-password")
	unknown := time.Since(start)

	if unknown < wrongPw/5 {
		t.Fatalf("логин на несуществующий email слишком быстр (%v против %v) — время не выровнено", unknown, wrongPw)
	}
}

func TestLogout_DeletesSession(t *testing.T) {
	store := &fakeStore{}
	svc := newService(store)
	if err := svc.Logout(context.Background(), "some-token"); err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if !store.deletedSession {
		t.Fatal("сессия не удалена")
	}
}

func TestUserByToken_NoSession(t *testing.T) {
	store := &fakeStore{userExists: false}
	svc := newService(store)
	_, err := svc.UserByToken(context.Background(), "dead-token")
	if !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestPurgeExpiredSessions_ReturnsCount(t *testing.T) {
	store := &fakeStore{deleteExpiredN: 7}
	svc := newService(store)
	n, err := svc.PurgeExpiredSessions(context.Background())
	if err != nil {
		t.Fatalf("PurgeExpiredSessions: %v", err)
	}
	if n != 7 {
		t.Fatalf("удалено = %d, ожидалось 7", n)
	}
}

func TestPurgeExpiredSessions_WrapsError(t *testing.T) {
	sentinel := errors.New("db down")
	store := &fakeStore{deleteExpiredErr: sentinel}
	svc := newService(store)
	if _, err := svc.PurgeExpiredSessions(context.Background()); !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, ожидалась обёртка над %v", err, sentinel)
	}
}
