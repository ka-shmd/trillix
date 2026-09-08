package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/mail"
)

// Таблица случаев из DEV-PLAN фазы 11 шага 4, ставшая таблицей тестов.

func TestLoginWithIdentity_KnownIdentity(t *testing.T) {
	known := User{ID: domain.NewID(), Email: "user@yandex.ru", CreatedAt: time.Now()}
	store := &fakeStore{identityExists: true, identityUser: known}
	svc := newService(store)

	user, token, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{Provider: "yandex", ProviderUserID: "1234567", Email: "user@yandex.ru"}, Device{})
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

	user, token, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{Provider: "yandex", ProviderUserID: "1234567", Email: "  New@Yandex.RU "}, Device{})
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

	_, token, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{Provider: "yandex", ProviderUserID: "attacker-id", Email: "victim@yandex.ru"}, Device{})
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

	_, token, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{Provider: "yandex", ProviderUserID: "new-id", Email: "user@yandex.ru"}, Device{})
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

	user, token, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{Provider: "yandex", ProviderUserID: "1234567", Email: "user@yandex.ru"}, Device{})
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

	user, token, _, err := svc.LinkIdentityWithPassword(context.Background(), "owner@yandex.ru", "correct-password", "", "yandex", "1234567", Device{})
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
			_, _, _, err := svc.LinkIdentityWithPassword(context.Background(), "o@y.ru", c.password, "", "yandex", "1234567", Device{})
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

// Второй фактор на шаге привязки. Проверяется не только отказ, но и отсутствие
// побочного эффекта: привязка, созданная до проверки кода, остаётся навсегда —
// знающий пароль прицепил бы к чужому аккаунту свою личность у провайдера и
// получил бы постоянный вход на тот день, когда владелец выключит фактор.
func TestLinkIdentityWithPassword_TwoFactor(t *testing.T) {
	setup := func(t *testing.T) (*fakeStore, *Service, *fakeEnqueuer, User) {
		t.Helper()
		hash, _ := HashPassword("correct-password")
		user := User{ID: domain.NewID(), Email: "o@y.ru", PasswordHash: &hash}
		store := &fakeStore{userExists: true, user: user}
		enableFactorFor(store, &user)
		mailer := &fakeEnqueuer{}
		return store, newCodeService(store, mailer), mailer, user
	}

	t.Run("без кода — код уходит письмом, привязки нет", func(t *testing.T) {
		store, svc, mailer, _ := setup(t)

		_, token, _, err := svc.LinkIdentityWithPassword(context.Background(), "o@y.ru", "correct-password", "", "yandex", "1234567", Device{})
		if !errors.Is(err, ErrTwoFactorRequired) {
			t.Fatalf("err = %v, want ErrTwoFactorRequired", err)
		}
		if token != "" {
			t.Fatal("выдана сессия без второго фактора")
		}
		if store.createdIdentity {
			t.Fatal("привязка создана до проверки второго фактора")
		}
		sentCode(t, mailer, mail.TemplateLoginCode)
	})

	t.Run("неверный код — отказ, привязки нет", func(t *testing.T) {
		store, svc, _, user := setup(t)
		if err := svc.SendLoginCode(context.Background(), user); err != nil {
			t.Fatalf("SendLoginCode: %v", err)
		}

		_, _, _, err := svc.LinkIdentityWithPassword(context.Background(), "o@y.ru", "correct-password", "000000", "yandex", "1234567", Device{})
		if !errors.Is(err, domain.ErrInvalidCredentials) {
			t.Fatalf("err = %v, want ErrInvalidCredentials", err)
		}
		if store.createdIdentity {
			t.Fatal("привязка создана по неверному коду")
		}
		if store.createdSession {
			t.Fatal("выдана сессия по неверному коду")
		}
	})

	t.Run("верный код — привязка, сессия и знакомство с браузером", func(t *testing.T) {
		store, svc, mailer, user := setup(t)
		if err := svc.SendLoginCode(context.Background(), user); err != nil {
			t.Fatalf("SendLoginCode: %v", err)
		}
		code := sentCode(t, mailer, mail.TemplateLoginCode)

		_, token, deviceToken, err := svc.LinkIdentityWithPassword(context.Background(), "o@y.ru", "correct-password", code, "yandex", "1234567", Device{})
		if err != nil || token == "" {
			t.Fatalf("привязка с кодом: err=%v token=%q", err, token)
		}
		if deviceToken == "" {
			t.Fatal("браузер не запомнен — следующий вход снова потребует код")
		}
		if !store.createdIdentity {
			t.Fatal("привязка не создана")
		}
	})

	// Знакомому браузеру код не нужен и здесь: иначе привязка вела бы себя
	// строже обычного входа, у которого те же доказательства.
	t.Run("знакомый браузер — без кода", func(t *testing.T) {
		store, svc, mailer, _ := setup(t)
		store.deviceKnown = true

		_, token, _, err := svc.LinkIdentityWithPassword(context.Background(), "o@y.ru", "correct-password", "", "yandex", "1234567", Device{Token: "known"})
		if err != nil || token == "" {
			t.Fatalf("привязка со знакомого браузера: err=%v token=%q", err, token)
		}
		if len(mailer.msgs) != 0 {
			t.Fatalf("знакомому браузеру отправлено письмо: %+v", mailer.msgs)
		}
	})
}

// Отказ на несуществующем аккаунте не должен быть быстрее отказа по паролю:
// иначе /link превращается в перечислитель зарегистрированных адресов.
func TestLinkIdentityWithPassword_TimingEqualized(t *testing.T) {
	hash, _ := HashPassword("correct-password")
	store := &fakeStore{userExists: true, user: User{ID: domain.NewID(), Email: "o@y.ru", PasswordHash: &hash}}
	svc := newService(store)

	start := time.Now()
	_, _, _, _ = svc.LinkIdentityWithPassword(context.Background(), "o@y.ru", "wrong-password", "", "yandex", "1", Device{})
	wrongPw := time.Since(start)

	store.userExists = false
	start = time.Now()
	_, _, _, _ = svc.LinkIdentityWithPassword(context.Background(), "missing@y.ru", "any-password", "", "yandex", "1", Device{})
	unknown := time.Since(start)

	if unknown < wrongPw/5 {
		t.Fatalf("отказ на несуществующем аккаунте слишком быстр (%v против %v) — адреса перечислимы", unknown, wrongPw)
	}
}

// Профиль из провайдера (фаза 23, слайс B). Правило одно: заполняем пустое,
// не трогаем заполненное.

func TestLoginWithIdentity_NewUserGetsProviderName(t *testing.T) {
	store := &fakeStore{identityExists: false, userExists: false}
	svc := newService(store)

	user, _, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{
		Provider: "yandex", ProviderUserID: "1234567", Email: "new@yandex.ru",
		FirstName: "Иван", LastName: "Петров",
	}, Device{})
	if err != nil {
		t.Fatalf("LoginWithIdentity: %v", err)
	}
	if user.FirstName == nil || *user.FirstName != "Иван" || user.LastName == nil || *user.LastName != "Петров" {
		t.Fatalf("профиль нового аккаунта не заполнен из провайдера: %v / %v", user.FirstName, user.LastName)
	}
}

func TestLoginWithIdentity_ProviderDoesNotOverwriteName(t *testing.T) {
	own := "СвоёИмя"
	known := User{ID: domain.NewID(), Email: "user@yandex.ru", FirstName: &own, CreatedAt: time.Now()}
	store := &fakeStore{identityExists: true, identityUser: known, user: known}
	svc := newService(store)

	// Имя, вписанное в кабинете руками, обязано пережить вход через Яндекс —
	// иначе правка профиля живёт до следующего входа.
	user, _, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{
		Provider: "yandex", ProviderUserID: "1234567", Email: "user@yandex.ru",
		FirstName: "ИзЯндекса", LastName: "Петров",
	}, Device{})
	if err != nil {
		t.Fatalf("LoginWithIdentity: %v", err)
	}
	if user.FirstName == nil || *user.FirstName != own {
		t.Fatalf("имя перетёрто провайдером: %v", user.FirstName)
	}
	// А пустая фамилия при этом заполняется: правило про поле, а не про запись.
	if user.LastName == nil || *user.LastName != "Петров" {
		t.Fatalf("пустая фамилия не заполнена из провайдера: %v", user.LastName)
	}
}

func TestLoginWithIdentity_NoNameNoWrite(t *testing.T) {
	known := User{ID: domain.NewID(), Email: "user@yandex.ru", CreatedAt: time.Now()}
	store := &fakeStore{identityExists: true, identityUser: known, user: known}
	svc := newService(store)

	// Провайдер имени не отдал (нет разрешения login:info) — запроса в базу
	// быть не должно вовсе: это вход, а не правка профиля.
	if _, _, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{
		Provider: "yandex", ProviderUserID: "1234567", Email: "user@yandex.ru",
	}, Device{}); err != nil {
		t.Fatalf("LoginWithIdentity: %v", err)
	}
	if store.profileFilled {
		t.Error("пустой профиль провайдера всё равно пошёл в базу")
	}
}

func TestLoginWithIdentity_OversizedProviderNameDoesNotBlockLogin(t *testing.T) {
	known := User{ID: domain.NewID(), Email: "user@yandex.ru", CreatedAt: time.Now()}
	store := &fakeStore{identityExists: true, identityUser: known, user: known}
	svc := newService(store)

	// Имя длиннее лимита — не повод отказать во входе: оно приезжает побочным
	// эффектом, а не по просьбе человека. Поле остаётся пустым.
	_, token, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{
		Provider: "yandex", ProviderUserID: "1234567", Email: "user@yandex.ru",
		FirstName: strings.Repeat("я", MaxPersonNameLen+1),
	}, Device{})
	if err != nil {
		t.Fatalf("вход отвергнут из-за длинного имени у провайдера: %v", err)
	}
	if token == "" {
		t.Fatal("сессия не выдана")
	}
	if store.profileFilled {
		t.Error("негодное имя всё равно пошло в базу")
	}
}
