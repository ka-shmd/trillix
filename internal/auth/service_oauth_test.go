package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Таблица случаев из DEV-PLAN фазы 11 шага 4, ставшая таблицей тестов.

func TestLoginWithIdentity_KnownIdentity(t *testing.T) {
	known := User{ID: domain.NewID(), Email: "user@yandex.ru", CreatedAt: time.Now()}
	store := &fakeStore{identityExists: true, identityUser: known}
	svc := newService(store)

	user, token, err := svc.LoginWithIdentity(context.Background(), "yandex", "1234567", "user@yandex.ru")
	if err != nil {
		t.Fatalf("LoginWithIdentity: %v", err)
	}
	if user.ID != known.ID || token == "" {
		t.Fatalf("вход не в тот аккаунт: user=%+v token=%q", user, token)
	}
	if store.createdUser {
		t.Fatal("при известной привязке заведён новый пользователь")
	}
}

func TestLoginWithIdentity_NewUser(t *testing.T) {
	store := &fakeStore{identityExists: false, userExists: false}
	svc := newService(store)

	user, token, err := svc.LoginWithIdentity(context.Background(), "yandex", "1234567", "  New@Yandex.RU ")
	if err != nil {
		t.Fatalf("LoginWithIdentity: %v", err)
	}
	if user.Email != "new@yandex.ru" {
		t.Fatalf("email не нормализован: %q", user.Email)
	}
	if token == "" {
		t.Fatal("сессия не выдана")
	}
	// Аккаунт без пароля: войти в него можно только через провайдера.
	if user.PasswordHash != nil {
		t.Fatal("у OAuth-аккаунта проставлен пароль")
	}
	// Инвариант регистрации распространяется и на этот путь.
	if !store.createdUser || !store.createdWorkspace || !store.createdMember || !store.createdIdentity {
		t.Fatalf("не все шаги регистрации выполнены: %+v", store)
	}
	// Включая подписку личного воркспейса (0014): регистрация через провайдера —
	// такая же регистрация, и второго места, где «иногда подписки нет», не будет.
	if store.createdPlanCode != defaultPlanCode {
		t.Errorf("подписка личного воркспейса: план %q, ждали %q", store.createdPlanCode, defaultPlanCode)
	}
	// Вход через провайдера считается подтверждением email (баннер не показываем).
	if !store.markVerifiedCalled || store.markVerifiedUser != user.ID {
		t.Errorf("OAuth-аккаунт не помечен подтверждённым (called=%v user=%v)", store.markVerifiedCalled, store.markVerifiedUser)
	}
	if user.EmailVerifiedAt == nil {
		t.Error("в возвращённой структуре не проставлен email_verified_at")
	}
}

// Главный тест фазы: совпадение email не отдаёт чужой аккаунт. Провайдеры не
// сообщают, подтверждён ли адрес, поэтому доступ даётся только по паролю.
func TestLoginWithIdentity_ExistingEmailRequiresPassword(t *testing.T) {
	hash, _ := HashPassword("victim-password")
	store := &fakeStore{
		identityExists: false,
		userExists:     true,
		user:           User{ID: domain.NewID(), Email: "victim@yandex.ru", PasswordHash: &hash},
	}
	svc := newService(store)

	_, token, err := svc.LoginWithIdentity(context.Background(), "yandex", "attacker-id", "victim@yandex.ru")
	if !errors.Is(err, ErrPasswordLinkRequired) {
		t.Fatalf("err = %v, want ErrPasswordLinkRequired", err)
	}
	if token != "" {
		t.Fatal("выдана сессия к чужому аккаунту по одному совпадению email")
	}
	if store.createdSession {
		t.Fatal("создана сессия к чужому аккаунту")
	}
	if store.createdIdentity {
		t.Fatal("чужая личность привязана к аккаунту без доказательства владения")
	}
}

// Адрес занят аккаунтом БЕЗ пароля (аккаунт у провайдера удалён и заведён
// заново: адрес прежний, идентификатор новый). На экран привязки вести нельзя —
// доказывать владение там нечем, и любой ввод давал бы 401 навсегда.
// Найдено ревью шага 5.
func TestLoginWithIdentity_ExistingPasswordlessAccount(t *testing.T) {
	store := &fakeStore{
		identityExists: false,
		userExists:     true,
		user:           User{ID: domain.NewID(), Email: "user@yandex.ru", PasswordHash: nil},
	}
	svc := newService(store)

	_, token, err := svc.LoginWithIdentity(context.Background(), "yandex", "new-id", "user@yandex.ru")
	if !errors.Is(err, ErrProviderOnlyAccount) {
		t.Fatalf("err = %v, want ErrProviderOnlyAccount", err)
	}
	if token != "" || store.createdSession {
		t.Fatal("выдана сессия к аккаунту, владение которым не доказано")
	}
	if store.createdIdentity {
		t.Fatal("новая личность привязана по одному совпадению email")
	}
}

// Гонка двух вкладок при первом входе: соседняя транзакция успела создать
// аккаунт и привязку. Человек должен войти, а не упереться в экран привязки.
func TestLoginWithIdentity_ConcurrentSignupLetsIn(t *testing.T) {
	winner := User{ID: domain.NewID(), Email: "user@yandex.ru"}
	store := &fakeStore{
		identityExists: false,
		userExists:     false,
		// Вставка падает на unique violation по email, а повторный поиск
		// привязки уже находит созданную соседом.
		createUserErr:      &pgconn.PgError{Code: "23505"},
		identityAfterRetry: &winner,
	}
	svc := newService(store)

	user, token, err := svc.LoginWithIdentity(context.Background(), "yandex", "1234567", "user@yandex.ru")
	if err != nil {
		t.Fatalf("LoginWithIdentity: %v — гонка двух вкладок не должна быть отказом", err)
	}
	if user.ID != winner.ID || token == "" {
		t.Fatalf("вход не в созданный соседом аккаунт: %+v", user)
	}
}

func TestLinkIdentityWithPassword_Success(t *testing.T) {
	hash, _ := HashPassword("correct-password")
	owner := User{ID: domain.NewID(), Email: "owner@yandex.ru", PasswordHash: &hash}
	store := &fakeStore{userExists: true, user: owner}
	svc := newService(store)

	user, token, err := svc.LinkIdentityWithPassword(context.Background(), "owner@yandex.ru", "correct-password", "yandex", "1234567")
	if err != nil {
		t.Fatalf("LinkIdentityWithPassword: %v", err)
	}
	if user.ID != owner.ID || token == "" {
		t.Fatalf("привязка не к тому аккаунту: %+v", user)
	}
	if !store.createdIdentity {
		t.Fatal("привязка не создана")
	}
}

func TestLinkIdentityWithPassword_Rejects(t *testing.T) {
	hash, _ := HashPassword("correct-password")
	cases := map[string]struct {
		store    *fakeStore
		password string
	}{
		"неверный пароль": {
			store:    &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "o@y.ru", PasswordHash: &hash}},
			password: "wrong-password",
		},
		"нет такого аккаунта": {
			store:    &fakeStore{userExists: false},
			password: "any-password",
		},
		"аккаунт без пароля": {
			store:    &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "o@y.ru", PasswordHash: nil}},
			password: "any-password",
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			svc := newService(c.store)
			_, _, err := svc.LinkIdentityWithPassword(context.Background(), "o@y.ru", c.password, "yandex", "1234567")
			if !errors.Is(err, domain.ErrInvalidCredentials) {
				t.Fatalf("err = %v, want ErrInvalidCredentials", err)
			}
			if c.store.createdIdentity {
				t.Fatal("привязка создана без доказательства владения аккаунтом")
			}
			if c.store.createdSession {
				t.Fatal("выдана сессия без доказательства владения аккаунтом")
			}
		})
	}
}

// Отказ на несуществующем аккаунте не должен быть быстрее отказа по паролю:
// иначе /link превращается в перечислитель зарегистрированных адресов.
func TestLinkIdentityWithPassword_TimingEqualized(t *testing.T) {
	hash, _ := HashPassword("correct-password")
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "o@y.ru", PasswordHash: &hash}}
	svc := newService(store)

	start := time.Now()
	_, _, _ = svc.LinkIdentityWithPassword(context.Background(), "o@y.ru", "wrong-password", "yandex", "1")
	wrongPw := time.Since(start)

	store.userExists = false
	start = time.Now()
	_, _, _ = svc.LinkIdentityWithPassword(context.Background(), "missing@y.ru", "any-password", "yandex", "1")
	unknown := time.Since(start)

	if unknown < wrongPw/5 {
		t.Fatalf("отказ на несуществующем аккаунте слишком быстр (%v против %v) — адреса перечислимы", unknown, wrongPw)
	}
}
