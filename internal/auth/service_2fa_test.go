package auth

import (
	"context"
	"errors"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/mail"
)

// Сценарии второго фактора — кода на почту (0056). Ключ подписи в тестах —
// произвольная строка: важно, что он есть и один и тот же.
var testCodeKey = []byte("test-form-token-secret-16+")

func newCodeService(store *fakeStore, mailer mailEnqueuer) *Service {
	return newServiceMail(store, mailer).WithLoginCodeKey(testCodeKey)
}

// enabledUser — аккаунт с включённым фактором и паролем.
func enabledUser(t *testing.T, store *fakeStore) User {
	t.Helper()
	hash, err := HashPassword("supersecret")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	u := User{ID: domain.NewID(), Email: "ivan@example.com", PasswordHash: &hash, TwoFactorEnabled: true}
	store.user = u
	store.userExists = true
	return u
}

// sentCode вытаскивает код из последнего поставленного письма — ровно так его
// получает человек.
func sentCode(t *testing.T, mailer *fakeEnqueuer, want mail.Template) string {
	t.Helper()
	if len(mailer.msgs) == 0 {
		t.Fatal("письмо с кодом не поставлено в очередь")
	}
	msg := mailer.msgs[len(mailer.msgs)-1]
	if msg.Template != want {
		t.Fatalf("шаблон письма %q, ожидался %q", msg.Template, want)
	}
	code, ok := msg.Data["code"].(string)
	if !ok || code == "" {
		t.Fatalf("в письме нет кода: %+v", msg.Data)
	}
	return code
}

func TestLogin_UnknownDeviceSendsCodeAndGivesNoSession(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	enabledUser(t, store)

	user, token, err := svc.Login(context.Background(), "ivan@example.com", "supersecret", Device{})
	if !errors.Is(err, ErrTwoFactorRequired) {
		t.Fatalf("Login: %v, ожидался ErrTwoFactorRequired", err)
	}
	if token != "" {
		t.Fatal("сессия выдана до предъявления кода")
	}
	if user.ID == (User{}).ID {
		t.Fatal("транспорту нужен пользователь, чтобы знать, у кого спрашивать код")
	}
	if store.createdSession {
		t.Fatal("сессия создана в базе, хотя код ещё не предъявлен")
	}
	sentCode(t, mailer, mail.TemplateLoginCode)
}

func TestLogin_KnownDeviceSkipsCode(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	enabledUser(t, store)
	store.deviceKnown = true

	_, token, err := svc.Login(context.Background(), "ivan@example.com", "supersecret", Device{Token: "known"})
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	if token == "" {
		t.Fatal("знакомому устройству сессия не выдана")
	}
	if len(mailer.msgs) != 0 {
		t.Fatalf("знакомому устройству отправлено письмо: %+v", mailer.msgs)
	}
}

// Мина: пустой токен устройства не должен считаться знакомством. Иначе первый
// же вход без cookie проходил бы мимо фактора.
func TestLogin_EmptyDeviceTokenIsNotKnown(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	enabledUser(t, store)
	store.deviceKnown = true // фейк ответил бы «знакомо» на любой запрос

	_, token, err := svc.Login(context.Background(), "ivan@example.com", "supersecret", Device{})
	if !errors.Is(err, ErrTwoFactorRequired) {
		t.Fatalf("Login: %v, ожидался ErrTwoFactorRequired", err)
	}
	if token != "" {
		t.Fatal("сессия выдана браузеру без cookie устройства")
	}
}

func TestLoginWithIdentity_UnknownDeviceGivesNoSession(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	user := enabledUser(t, store)
	store.identityUser = user
	store.identityExists = true

	_, token, err := svc.LoginWithIdentity(context.Background(), IdentityProfile{
		Provider: "yandex", ProviderUserID: "42", Email: user.Email,
	}, Device{})
	if !errors.Is(err, ErrTwoFactorRequired) {
		t.Fatalf("LoginWithIdentity: %v, ожидался ErrTwoFactorRequired", err)
	}
	if token != "" {
		t.Fatal("вход через провайдера обошёл второй фактор")
	}
	sentCode(t, mailer, mail.TemplateLoginCode)
}

func TestCompleteTwoFactorLogin_CodeOpensSessionAndRemembersDevice(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	user := enabledUser(t, store)

	if _, _, err := svc.Login(context.Background(), user.Email, "supersecret", Device{}); !errors.Is(err, ErrTwoFactorRequired) {
		t.Fatalf("Login: %v", err)
	}
	code := sentCode(t, mailer, mail.TemplateLoginCode)

	_, token, deviceToken, err := svc.CompleteTwoFactorLogin(context.Background(), user.ID, code, Device{UserAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120"})
	if err != nil {
		t.Fatalf("CompleteTwoFactorLogin: %v", err)
	}
	if token == "" || deviceToken == "" {
		t.Fatalf("после кода нет сессии (%q) или токена устройства (%q)", token, deviceToken)
	}
	if len(store.knownDevices) != 1 {
		t.Fatalf("устройство не запомнено: %+v", store.knownDevices)
	}
	if store.knownDevices[0].Label != "Chrome на Windows" {
		t.Fatalf("метка устройства %q", store.knownDevices[0].Label)
	}
}

// Код одноразовый: второе предъявление того же кода сессии не даёт.
func TestCompleteTwoFactorLogin_CodeWorksOnce(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	user := enabledUser(t, store)
	if err := svc.SendLoginCode(context.Background(), user); err != nil {
		t.Fatalf("SendLoginCode: %v", err)
	}
	code := sentCode(t, mailer, mail.TemplateLoginCode)

	if _, _, _, err := svc.CompleteTwoFactorLogin(context.Background(), user.ID, code, Device{}); err != nil {
		t.Fatalf("первый вход: %v", err)
	}
	_, _, _, err := svc.CompleteTwoFactorLogin(context.Background(), user.ID, code, Device{})
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("повторный код принят: %v", err)
	}
}

func TestCompleteTwoFactorLogin_WrongCodeNoSession(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	user := enabledUser(t, store)
	if err := svc.SendLoginCode(context.Background(), user); err != nil {
		t.Fatalf("SendLoginCode: %v", err)
	}

	_, token, _, err := svc.CompleteTwoFactorLogin(context.Background(), user.ID, "000000", Device{})
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("неверный код принят: %v", err)
	}
	if token != "" {
		t.Fatal("выдана сессия по неверному коду")
	}
}

// Мина: попытка списывается ДО сверки. Иначе верный код проходил бы мимо
// исчерпанного счётчика, и перебор стоил бы столько же, сколько без него.
func TestCompleteTwoFactorLogin_AttemptsExhaustedBurnCode(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	user := enabledUser(t, store)
	if err := svc.SendLoginCode(context.Background(), user); err != nil {
		t.Fatalf("SendLoginCode: %v", err)
	}
	code := sentCode(t, mailer, mail.TemplateLoginCode)

	for i := 0; i < loginCodeMaxAttempts; i++ {
		if _, _, _, err := svc.CompleteTwoFactorLogin(context.Background(), user.ID, "000000", Device{}); !errors.Is(err, domain.ErrInvalidCredentials) {
			t.Fatalf("попытка %d: %v", i, err)
		}
	}
	_, _, _, err := svc.CompleteTwoFactorLogin(context.Background(), user.ID, code, Device{})
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("верный код принят после исчерпания попыток: %v", err)
	}
}

// Просроченный код не проходит, и отказ неотличим от «код не тот».
func TestCompleteTwoFactorLogin_ExpiredCodeRejected(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	user := enabledUser(t, store)
	if err := svc.SendLoginCode(context.Background(), user); err != nil {
		t.Fatalf("SendLoginCode: %v", err)
	}
	code := sentCode(t, mailer, mail.TemplateLoginCode)
	store.loginCodeExpired = true

	if _, _, _, err := svc.CompleteTwoFactorLogin(context.Background(), user.ID, code, Device{}); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("просроченный код принят: %v", err)
	}
}

// Новый код гасит предыдущий: иначе «отправить ещё раз» копило бы валидные
// коды в чужом ящике.
func TestSendLoginCode_NewCodeInvalidatesPrevious(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	user := enabledUser(t, store)

	if err := svc.SendLoginCode(context.Background(), user); err != nil {
		t.Fatalf("SendLoginCode: %v", err)
	}
	first := sentCode(t, mailer, mail.TemplateLoginCode)
	if err := svc.SendLoginCode(context.Background(), user); err != nil {
		t.Fatalf("SendLoginCode (второй): %v", err)
	}
	second := sentCode(t, mailer, mail.TemplateLoginCode)
	if first == second {
		t.Fatal("повторная отправка выдала тот же код")
	}
	if _, _, _, err := svc.CompleteTwoFactorLogin(context.Background(), user.ID, first, Device{}); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("прежний код всё ещё работает: %v", err)
	}
}

func TestEnableTwoFactor_NeedsPassword(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	hash, err := HashPassword("supersecret")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	user := User{ID: domain.NewID(), Email: "ivan@example.com", PasswordHash: &hash}
	store.user = user

	if err := svc.EnableTwoFactor(context.Background(), user, "wrong"); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("включение без пароля: %v", err)
	}
	if store.twoFactorSet {
		t.Fatal("фактор включён неверным паролем")
	}

	if err := svc.EnableTwoFactor(context.Background(), user, "supersecret"); err != nil {
		t.Fatalf("EnableTwoFactor: %v", err)
	}
	if !store.twoFactorEnabled {
		t.Fatal("фактор не включён")
	}
	if len(mailer.msgs) == 0 || mailer.msgs[len(mailer.msgs)-1].Template != mail.TemplateTwoFactorChanged {
		t.Fatalf("уведомление о включении не отправлено: %+v", mailer.msgs)
	}
}

// Выключение забывает устройства: иначе включение обратно молча пропустило бы
// браузеры, знакомые с прошлого раза.
func TestDisableTwoFactor_ForgetsDevices(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	user := enabledUser(t, store)
	store.deviceKnown = true

	if err := svc.DisableTwoFactor(context.Background(), user, "supersecret"); err != nil {
		t.Fatalf("DisableTwoFactor: %v", err)
	}
	if store.twoFactorEnabled {
		t.Fatal("фактор не выключен")
	}
	if !store.devicesWiped {
		t.Fatal("известные устройства не забыты при выключении фактора")
	}
}

// Мина: «забыть все устройства» обязано рвать и сессии, кроме текущей. Иначе
// чужой, ради которого жмут кнопку, продолжает работать в своей сессии.
func TestForgetAllDevices_AlsoKillsOtherSessions(t *testing.T) {
	store := &fakeStore{}
	svc := newCodeService(store, &fakeEnqueuer{})
	user := enabledUser(t, store)

	if err := svc.ForgetAllDevices(context.Background(), user.ID, "current-session"); err != nil {
		t.Fatalf("ForgetAllDevices: %v", err)
	}
	if !store.devicesWiped {
		t.Fatal("устройства не забыты")
	}
	if !store.sessionsWiped {
		t.Fatal("прочие сессии не разорваны")
	}
}

func TestListDevices_MarksCurrent(t *testing.T) {
	store := &fakeStore{}
	svc := newCodeService(store, &fakeEnqueuer{})
	user := enabledUser(t, store)
	store.knownDevices = []KnownDevice{
		{ID: domain.NewID(), TokenHash: hashToken("mine"), Label: "Chrome на Windows"},
		{ID: domain.NewID(), TokenHash: hashToken("other"), Label: "Firefox на Linux"},
	}

	devices, err := svc.ListDevices(context.Background(), user.ID, Device{Token: "mine"})
	if err != nil {
		t.Fatalf("ListDevices: %v", err)
	}
	if len(devices) != 2 || !devices[0].Current || devices[1].Current {
		t.Fatalf("текущее устройство помечено неверно: %+v", devices)
	}
}

// Переотправка кода аккаунту с выключенным фактором — отказ, а не письмо:
// иначе ручка рассылала бы письма по чужим адресам, зная один id.
func TestResendLoginCode_RefusedWhenFactorOff(t *testing.T) {
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newCodeService(store, mailer)
	store.user = User{ID: domain.NewID(), Email: "ivan@example.com"}

	if err := svc.ResendLoginCode(context.Background(), store.user.ID); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("ResendLoginCode: %v, ожидался отказ", err)
	}
	if len(mailer.msgs) != 0 {
		t.Fatalf("письмо отправлено аккаунту без фактора: %+v", mailer.msgs)
	}
}

func TestDeviceLabel(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (Windows NT 10.0; Win64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36": "Chrome на Windows",
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15":      "Safari на macOS",
		"Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/121.0":                                           "Firefox на Linux",
		// Яндекс.Браузер и Edge представляются Chrome'ом — частное обязано
		// проверяться раньше общего.
		"Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 YaBrowser/24.1.0 Safari/537.36": "Яндекс.Браузер на Windows",
		"Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0":        "Edge на Windows",
		"": "Неизвестный браузер",
	}
	for ua, want := range cases {
		if got := deviceLabel(ua); got != want {
			t.Errorf("deviceLabel(%q) = %q, ожидалось %q", ua, got, want)
		}
	}
}

// issueCode выдаёт действующий код так же, как его получает человек: письмом.
// Помощник для тестов соседних сценариев (смена адреса, удаление аккаунта,
// привязка провайдера паролем) — им нужен верный код, а не механика его выдачи.
func issueCode(t *testing.T, svc *Service, mailer *fakeEnqueuer, user User) string {
	t.Helper()
	if err := svc.SendActionCode(context.Background(), user); err != nil {
		t.Fatalf("SendActionCode: %v", err)
	}
	return sentCode(t, mailer, mail.TemplateAccountActionCode)
}

// enableFactorFor помечает аккаунт фейка включённым фактором. userExists
// намеренно не трогается: у фейка он же отвечает на «занят ли адрес», и
// включение фактора не должно попутно делать все адреса занятыми.
func enableFactorFor(store *fakeStore, user *User) {
	user.TwoFactorEnabled = true
	store.user = *user
	store.twoFactorEnabled = true
}
