package auth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Сценарии второго фактора (фаза 23, слайс F). Ключ шифрования в тестах —
// произвольная строка: важно, что он есть и один и тот же.
var testTOTPKey = []byte("test-form-token-secret-16+")

func newTOTPService(store *fakeStore) *Service {
	return newService(store).WithTOTPKey(testTOTPKey)
}

// enabledTOTP кладёт в фейк включённый фактор с известным секретом.
func enabledTOTP(t *testing.T, store *fakeStore) []byte {
	t.Helper()
	secret, err := newTOTPSecret()
	if err != nil {
		t.Fatalf("newTOTPSecret: %v", err)
	}
	sealed, err := sealSecret(testTOTPKey, secret)
	if err != nil {
		t.Fatalf("sealSecret: %v", err)
	}
	now := time.Now()
	store.totp = &TOTPState{Secret: sealed, ConfirmedAt: &now}
	return secret
}

func TestSetupTOTP_StoresSealedSecretAndStaysDisabled(t *testing.T) {
	store := &fakeStore{}
	svc := newTOTPService(store)
	user := User{ID: domain.NewID(), Email: "ivan@example.com"}

	shown, link, err := svc.SetupTOTP(context.Background(), user)
	if err != nil {
		t.Fatalf("SetupTOTP: %v", err)
	}
	if shown == "" || link == "" {
		t.Fatal("секрет или ссылка пустые — заводить фактор человеку нечем")
	}
	if !store.totpUpserted {
		t.Fatal("секрет не сохранён")
	}
	// В колонке шифротекст, а не то, что показано человеку.
	if string(store.totp.Secret) == shown {
		t.Fatal("секрет лежит в базе в том же виде, в каком показан")
	}
	// Фактор ещё НЕ включён: человек не подтвердил, что завёл его в приложении.
	enabled, err := svc.TwoFactorEnabled(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("TwoFactorEnabled: %v", err)
	}
	if enabled {
		t.Fatal("фактор включён до подтверждения кодом")
	}
}

func TestSetupTOTP_RefusedWhenAlreadyEnabled(t *testing.T) {
	store := &fakeStore{}
	svc := newTOTPService(store)
	enabledTOTP(t, store)

	// Новый секрет поверх включённого оставил бы человека с двумя разными
	// кодами и без понимания, какой настоящий.
	_, _, err := svc.SetupTOTP(context.Background(), User{ID: domain.NewID(), Email: "a@b.com"})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ошибка = %v, ожидалась ErrConflict", err)
	}
}

func TestEnableTOTP_ConfirmsAndIssuesRecoveryCodes(t *testing.T) {
	store := &fakeStore{}
	svc := newTOTPService(store)
	user := User{ID: domain.NewID(), Email: "ivan@example.com"}

	if _, _, err := svc.SetupTOTP(context.Background(), user); err != nil {
		t.Fatalf("SetupTOTP: %v", err)
	}
	secret, err := openSecret(testTOTPKey, store.totp.Secret)
	if err != nil {
		t.Fatalf("openSecret: %v", err)
	}

	codes, err := svc.EnableTOTP(context.Background(), user, totpCode(secret, time.Now().Unix()/30))
	if err != nil {
		t.Fatalf("EnableTOTP: %v", err)
	}
	if len(codes) != recoveryCodeCount {
		t.Fatalf("резервных кодов %d, ожидалось %d", len(codes), recoveryCodeCount)
	}
	if !store.totpConfirmed {
		t.Fatal("фактор не подтверждён")
	}
	if len(store.recoveryHashes) != recoveryCodeCount {
		t.Fatalf("в базу легло %d хешей", len(store.recoveryHashes))
	}
	// В базе хеши, а не сами коды: иначе дамп даёт вход мимо фактора.
	for i, h := range store.recoveryHashes {
		if string(h) == codes[i] {
			t.Fatal("резервный код лежит в базе открытым текстом")
		}
	}
}

func TestEnableTOTP_WrongCodeChangesNothing(t *testing.T) {
	store := &fakeStore{}
	svc := newTOTPService(store)
	user := User{ID: domain.NewID(), Email: "ivan@example.com"}
	if _, _, err := svc.SetupTOTP(context.Background(), user); err != nil {
		t.Fatalf("SetupTOTP: %v", err)
	}

	if _, err := svc.EnableTOTP(context.Background(), user, "000000"); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("ошибка = %v, ожидалась ErrInvalidCredentials", err)
	}
	if store.totpConfirmed || len(store.recoveryHashes) != 0 {
		t.Fatal("неверный код всё равно включил фактор или выдал резервные коды")
	}
}

func TestCompleteTwoFactorLogin_CodeWorksOnce(t *testing.T) {
	store := &fakeStore{user: User{Email: "ivan@example.com"}}
	svc := newTOTPService(store)
	secret := enabledTOTP(t, store)
	userID := domain.NewID()

	code := totpCode(secret, time.Now().Unix()/30)
	if _, token, err := svc.CompleteTwoFactorLogin(context.Background(), userID, code); err != nil || token == "" {
		t.Fatalf("первый вход по коду: err=%v token=%q", err, token)
	}

	// Тот же код второй раз не проходит: перехваченный иначе работал бы все
	// свои полминуты — то есть второй фактор не мешал бы тому, кто его подсмотрел.
	_, _, err := svc.CompleteTwoFactorLogin(context.Background(), userID, code)
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("повтор кода: ошибка = %v, ожидалась ErrInvalidCredentials", err)
	}
}

func TestCompleteTwoFactorLogin_WrongCodeNoSession(t *testing.T) {
	store := &fakeStore{user: User{Email: "ivan@example.com"}}
	svc := newTOTPService(store)
	enabledTOTP(t, store)

	_, token, err := svc.CompleteTwoFactorLogin(context.Background(), domain.NewID(), "000000")
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("ошибка = %v, ожидалась ErrInvalidCredentials", err)
	}
	if token != "" {
		t.Fatal("выдана сессия при неверном коде")
	}
	if store.createdSession {
		t.Fatal("сессия создана в базе при неверном коде")
	}
}

func TestCompleteTwoFactorLogin_RecoveryCodeBurns(t *testing.T) {
	store := &fakeStore{user: User{Email: "ivan@example.com"}, recoveryUsable: true}
	svc := newTOTPService(store)
	enabledTOTP(t, store)
	userID := domain.NewID()

	// Телефон потерян — входим резервным кодом.
	if _, token, err := svc.CompleteTwoFactorLogin(context.Background(), userID, "SOMERECOVERY"); err != nil || token == "" {
		t.Fatalf("вход резервным кодом: err=%v token=%q", err, token)
	}
	if !store.recoveryUsed {
		t.Fatal("резервный код не потреблён")
	}
	// Одноразовость: второй раз тот же код не пускает.
	if _, _, err := svc.CompleteTwoFactorLogin(context.Background(), userID, "SOMERECOVERY"); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("повтор резервного кода: ошибка = %v", err)
	}
}

func TestLogin_WithTwoFactorGivesNoSession(t *testing.T) {
	hash, err := HashPassword("supersecret1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	user := User{ID: domain.NewID(), Email: "ivan@example.com", PasswordHash: &hash}
	store := &fakeStore{user: user, userExists: true}
	svc := newTOTPService(store)
	enabledTOTP(t, store)

	got, token, err := svc.Login(context.Background(), user.Email, "supersecret1")
	if !errors.Is(err, ErrTwoFactorRequired) {
		t.Fatalf("ошибка = %v, ожидалась ErrTwoFactorRequired", err)
	}
	if token != "" || store.createdSession {
		t.Fatal("верный пароль сам по себе открыл сессию — второй фактор обойдён")
	}
	// Кто вошёл — транспорту нужно знать, чтобы подписать пропуск на второй шаг.
	if got.ID != user.ID {
		t.Fatalf("пользователь = %v, ожидался %v", got.ID, user.ID)
	}
}

func TestLoginWithIdentity_WithTwoFactorGivesNoSession(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "ivan@yandex.ru"}
	store := &fakeStore{identityExists: true, identityUser: user, user: user}
	svc := newTOTPService(store)
	enabledTOTP(t, store)

	// Вход через провайдера обязан упираться в тот же фактор: иначе он
	// обходится в один клик, то есть не существует.
	_, token, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{
		Provider: "yandex", ProviderUserID: "1234567", Email: user.Email,
	})
	if !errors.Is(err, ErrTwoFactorRequired) {
		t.Fatalf("ошибка = %v, ожидалась ErrTwoFactorRequired", err)
	}
	if token != "" || store.createdSession {
		t.Fatal("вход через провайдера обошёл второй фактор")
	}
}

func TestDisableTOTP_NeedsPasswordAndCode(t *testing.T) {
	hash, err := HashPassword("supersecret1")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	user := User{ID: domain.NewID(), Email: "ivan@example.com", PasswordHash: &hash}

	// Неверный пароль — фактор на месте.
	store := &fakeStore{user: user, userExists: true}
	svc := newTOTPService(store)
	secret := enabledTOTP(t, store)
	if err := svc.DisableTOTP(context.Background(), user, "wrong", totpCode(secret, time.Now().Unix()/30)); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("неверный пароль: ошибка = %v", err)
	}
	if store.totpDeleted {
		t.Fatal("фактор снят при неверном пароле")
	}

	// Верный пароль, но неверный код — тоже отказ: снять второй фактор, не
	// предъявив второй фактор, значит его не иметь.
	if err := svc.DisableTOTP(context.Background(), user, "supersecret1", "000000"); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("неверный код: ошибка = %v", err)
	}
	if store.totpDeleted {
		t.Fatal("фактор снят без верного кода")
	}

	// И то и другое верно — снимается вместе с резервными кодами.
	if err := svc.DisableTOTP(context.Background(), user, "supersecret1", totpCode(secret, time.Now().Unix()/30)); err != nil {
		t.Fatalf("DisableTOTP: %v", err)
	}
	if !store.totpDeleted || !store.recoveryWiped {
		t.Fatalf("после выключения остались данные фактора: totp=%v codes=%v", !store.totpDeleted, !store.recoveryWiped)
	}
}
