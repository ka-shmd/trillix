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
	"github.com/ka-shmd/trillix/internal/mail"
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
	createdPlanCode  string // план подписки аккаунта ("" — подписки не завели)
	// Кому принадлежат заведённые строки: личное пространство помечается своим
	// хозяином (workspaces.personal_user_id), подписка — аккаунтом (0016).
	workspacePersonalUserID uuid.UUID
	subscriptionUserID      uuid.UUID
	createdSession          bool
	deletedSession          bool

	deleteExpiredN   int64
	deleteExpiredErr error

	// Привязки к провайдерам (фаза 11).
	identityUser      User
	identityExists    bool
	createdIdentity   bool
	createIdentityErr error
	// identityAfterRetry — привязка, «созданная соседней транзакцией»: первый
	// поиск её не находит, повторный (после гонки) находит.
	identityAfterRetry *User
	identityLookups    int

	// Сброс пароля (слайс B).
	setPasswordCalled     bool
	setPasswordUser       uuid.UUID
	setPasswordHash       string
	sessionsDeletedByUser bool
	deletedSessionsUser   uuid.UUID
	createdResetToken     bool
	createdResetTokenUser uuid.UUID
	consumeExists         bool // false → ErrNoRows (нет/использован/истёк)
	consumeUserID         uuid.UUID
	consumeErr            error
	consumeCalled         bool // потреблялся ли токен (проверка «валидация до потребления»)
	resetTokensPurged     int64

	// Подтверждение email (слайс C).
	createdVerifyToken     bool
	createdVerifyTokenUser uuid.UUID
	verifyConsumeExists    bool // false → ErrNoRows (нет/использован/истёк)
	verifyConsumeUserID    uuid.UUID
	verifyConsumeCalled    bool
	markVerifiedCalled     bool
	markVerifiedUser       uuid.UUID
	verifyTokensPurged     int64

	// Профиль (фаза 23, слайс A). Указатели, а не строки: тесту нужно отличать
	// «стереть» (nil) от «поставить пустое» — второго быть не должно.
	profileUpdated   bool
	profileUser      uuid.UUID
	profileFirstName *string
	profileLastName  *string
}

func (f *fakeStore) GetUserByIdentity(_ context.Context, _ postgres.DBTX, _, _ string) (User, error) {
	f.identityLookups++
	if f.identityAfterRetry != nil && f.identityLookups > 1 {
		return *f.identityAfterRetry, nil
	}
	if !f.identityExists {
		return User{}, pgx.ErrNoRows
	}
	return f.identityUser, nil
}

func (f *fakeStore) CreateIdentity(_ context.Context, _ postgres.DBTX, _, _ string, _ uuid.UUID) error {
	if f.createIdentityErr != nil {
		return f.createIdentityErr
	}
	f.createdIdentity = true
	return nil
}

func (f *fakeStore) CreateUser(_ context.Context, _ postgres.DBTX, id uuid.UUID, email string, passwordHash *string) (User, error) {
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

func (f *fakeStore) CreateWorkspace(_ context.Context, _ postgres.DBTX, id uuid.UUID, name string, personalUserID uuid.UUID) (Workspace, error) {
	f.createdWorkspace = true
	f.workspacePersonalUserID = personalUserID
	return Workspace{ID: id, Name: name, CreatedAt: time.Now()}, nil
}

func (f *fakeStore) AddWorkspaceMember(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID, _ string) error {
	f.createdMember = true
	return nil
}

func (f *fakeStore) CreateSubscription(_ context.Context, _ postgres.DBTX, userID uuid.UUID, planCode string) error {
	f.createdPlanCode = planCode
	f.subscriptionUserID = userID
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

func (f *fakeStore) UpdateProfile(_ context.Context, _ postgres.DBTX, userID uuid.UUID, firstName, lastName *string) (User, error) {
	f.profileUpdated = true
	f.profileUser = userID
	f.profileFirstName = firstName
	f.profileLastName = lastName
	u := f.user
	u.ID = userID
	u.FirstName = firstName
	u.LastName = lastName
	return u, nil
}

func (f *fakeStore) SetUserPassword(_ context.Context, _ postgres.DBTX, userID uuid.UUID, hash string) error {
	f.setPasswordCalled = true
	f.setPasswordUser = userID
	f.setPasswordHash = hash
	return nil
}

func (f *fakeStore) DeleteSessionsByUser(_ context.Context, _ postgres.DBTX, userID uuid.UUID) error {
	f.sessionsDeletedByUser = true
	f.deletedSessionsUser = userID
	return nil
}

func (f *fakeStore) CreatePasswordResetToken(_ context.Context, _ postgres.DBTX, _ []byte, userID uuid.UUID, _ time.Time) error {
	f.createdResetToken = true
	f.createdResetTokenUser = userID
	return nil
}

func (f *fakeStore) ConsumePasswordResetToken(_ context.Context, _ postgres.DBTX, _ []byte) (uuid.UUID, error) {
	f.consumeCalled = true
	if f.consumeErr != nil {
		return uuid.Nil, f.consumeErr
	}
	if !f.consumeExists {
		return uuid.Nil, pgx.ErrNoRows
	}
	return f.consumeUserID, nil
}

func (f *fakeStore) DeleteExpiredPasswordResetTokens(_ context.Context, _ postgres.DBTX) (int64, error) {
	return f.resetTokensPurged, nil
}

func (f *fakeStore) CreateEmailVerificationToken(_ context.Context, _ postgres.DBTX, _ []byte, userID uuid.UUID, _ time.Time) error {
	f.createdVerifyToken = true
	f.createdVerifyTokenUser = userID
	return nil
}

func (f *fakeStore) ConsumeEmailVerificationToken(_ context.Context, _ postgres.DBTX, _ []byte) (uuid.UUID, error) {
	f.verifyConsumeCalled = true
	if !f.verifyConsumeExists {
		return uuid.Nil, pgx.ErrNoRows
	}
	return f.verifyConsumeUserID, nil
}

func (f *fakeStore) MarkEmailVerified(_ context.Context, _ postgres.DBTX, userID uuid.UUID) error {
	f.markVerifiedCalled = true
	f.markVerifiedUser = userID
	return nil
}

func (f *fakeStore) DeleteExpiredEmailVerificationTokens(_ context.Context, _ postgres.DBTX) (int64, error) {
	return f.verifyTokensPurged, nil
}

// fakeEnqueuer — записывает поставленные в очередь письма для проверок.
type fakeEnqueuer struct {
	msgs []mail.EmailMessage
	err  error
}

func (f *fakeEnqueuer) EnqueueEmail(_ context.Context, _ postgres.DBTX, msg mail.EmailMessage) error {
	if f.err != nil {
		return f.err
	}
	f.msgs = append(f.msgs, msg)
	return nil
}

func newService(store *fakeStore) *Service {
	return newServiceMail(store, &fakeEnqueuer{})
}

func newServiceMail(store *fakeStore, mailer mailEnqueuer) *Service {
	return NewService(nil, fakeTx{}, store, mailer, time.Hour, "https://app.test")
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
	if !store.createdVerifyToken {
		t.Error("при регистрации не создан токен подтверждения email")
	}
	// Аккаунта без подписки не бывает (0014, субъект переехал на аккаунт в 0016):
	// иначе проверка лимита получает ветку «а если строки нет», и однажды эта
	// ветка разрешит лишнее.
	if store.createdPlanCode != defaultPlanCode {
		t.Errorf("подписка аккаунта: план %q, ждали %q", store.createdPlanCode, defaultPlanCode)
	}
	// Обе строки принадлежат заведённому пользователю: личное пространство
	// помечено им (иначе оно не найдётся как личное и попадёт под заморозку
	// даунгрейда), подписка выписана на него (иначе план не резолвится вовсе).
	if store.workspacePersonalUserID != user.ID {
		t.Errorf("личное пространство помечено %v, ждали %v", store.workspacePersonalUserID, user.ID)
	}
	if store.subscriptionUserID != user.ID {
		t.Errorf("подписка выписана на %v, ждали %v", store.subscriptionUserID, user.ID)
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
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "a@b.com", PasswordHash: &hash}}
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
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "a@b.com", PasswordHash: &hash}}
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

// Аккаунт, заведённый через провайдера (password_hash IS NULL, миграция 0009),
// не пускает по паролю — и не отличается снаружи от «неверный пароль»: иначе
// «этот адрес заведён через Яндекс» становится наблюдаемым, а вместе с ним и
// способ входа в чужой аккаунт.
func TestLogin_PasswordlessAccount(t *testing.T) {
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "oauth@b.com", PasswordHash: nil}}
	svc := newService(store)

	start := time.Now()
	_, _, err := svc.Login(context.Background(), "oauth@b.com", "any-password")
	elapsed := time.Since(start)

	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("err = %v, want ErrInvalidCredentials", err)
	}
	if store.createdSession {
		t.Fatal("сессия выдана аккаунту без пароля")
	}
	// Без equalizeTiming ветка вернулась бы мгновенно (без argon2) и выдала бы
	// наличие OAuth-аккаунта по времени ответа.
	if elapsed < time.Millisecond {
		t.Fatalf("ответ за %v — время не выровнено, ветка наблюдаема снаружи", elapsed)
	}
}

// Ответ на несуществующий email не должен быть заметно быстрее, чем на неверный
// пароль: без выравнивания разница ~1000x (argon2 ~десятки мс против ~мкс),
// поэтому порог «не быстрее чем в 5 раз» надёжен и не флейки.
func TestLogin_TimingEqualized(t *testing.T) {
	hash, _ := HashPassword("correct-password")
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "a@b.com", PasswordHash: &hash}}
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
