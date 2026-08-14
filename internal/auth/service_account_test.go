package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/mail"
)

func TestUpdateProfile_TrimsAndStores(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, nil, store, nil, DefaultSessionTTL, testAppOrigin)
	id := domain.NewID()

	if _, err := svc.UpdateProfile(context.Background(), id, "  Иван  ", "Петров"); err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if !store.profileUpdated || store.profileUser != id {
		t.Fatalf("репозиторий не получил обновление (updated=%v user=%v)", store.profileUpdated, store.profileUser)
	}
	if store.profileFirstName == nil || *store.profileFirstName != "Иван" {
		t.Errorf("имя = %v, ожидалось «Иван» без окружающих пробелов", store.profileFirstName)
	}
}

func TestUpdateProfile_EmptyMeansNull(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, nil, store, nil, DefaultSessionTTL, testAppOrigin)

	// Пустая строка и строка из пробелов — «стереть», то есть NULL. Второго
	// способа записать «не указано» быть не должно: пустая строка в колонке
	// разъедется с NULL в первом же запросе, который сравнивает с одним из них.
	if _, err := svc.UpdateProfile(context.Background(), domain.NewID(), "", "   "); err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}
	if store.profileFirstName != nil || store.profileLastName != nil {
		t.Errorf("в репозиторий уехало имя=%v фамилия=%v, ожидались оба nil", store.profileFirstName, store.profileLastName)
	}
}

func TestUpdateProfile_RejectsTooLong(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, nil, store, nil, DefaultSessionTTL, testAppOrigin)

	// Кириллица: лимит считается в рунах, а не в байтах — 101 буква «я» весит
	// 202 байта, и байтовая проверка отвергла бы уже 51 символ.
	_, err := svc.UpdateProfile(context.Background(), domain.NewID(), strings.Repeat("я", MaxPersonNameLen+1), "")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.profileUpdated {
		t.Error("репозиторий не должен вызываться при провале валидации")
	}
}

func TestUpdateProfile_AcceptsExactlyMaxLen(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, nil, store, nil, DefaultSessionTTL, testAppOrigin)

	// Граница включительная: ровно MaxPersonNameLen рун проходят. Без этого
	// теста «> » легко превращается в «>=» при правке и молча отрезает символ.
	name := strings.Repeat("я", MaxPersonNameLen)
	if _, err := svc.UpdateProfile(context.Background(), domain.NewID(), name, ""); err != nil {
		t.Fatalf("имя ровно в %d рун отвергнуто: %v", MaxPersonNameLen, err)
	}
	if store.profileFirstName == nil || *store.profileFirstName != name {
		t.Error("имя длиной ровно в лимит не доехало до репозитория")
	}
}

// Смена пароля (фаза 23, слайс C).

func TestChangePassword_SetsHashKillsSessionsAndMails(t *testing.T) {
	hash, err := HashPassword("old-password")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	user := User{ID: domain.NewID(), Email: "user@example.com", PasswordHash: &hash}
	store := &fakeStore{user: user, userExists: true}
	mailer := &fakeEnqueuer{}
	svc := newServiceMail(store, mailer)

	token, err := svc.ChangePassword(context.Background(), user, "old-password", "new-password")
	if err != nil {
		t.Fatalf("ChangePassword: %v", err)
	}
	if token == "" {
		t.Fatal("новая сессия не открыта — человек остался бы разлогиненным собственной сменой пароля")
	}
	if !store.setPasswordCalled || store.setPasswordUser != user.ID {
		t.Fatalf("хеш не поставлен: called=%v user=%v", store.setPasswordCalled, store.setPasswordUser)
	}
	// В колонку уезжает argon2id-хеш, а не сам пароль (инвариант 2).
	if store.setPasswordHash == "new-password" {
		t.Fatal("в базу уехал пароль в открытом виде")
	}
	ok, err := VerifyPassword(store.setPasswordHash, "new-password")
	if err != nil || !ok {
		t.Fatalf("сохранённый хеш не проверяется новым паролем (ok=%v err=%v)", ok, err)
	}
	// Разрыв сессий — половина смысла операции: без него вошедший по старому
	// паролю остаётся внутри.
	if !store.sessionsDeletedByUser || store.deletedSessionsUser != user.ID {
		t.Fatalf("сессии не разорваны: %v / %v", store.sessionsDeletedByUser, store.deletedSessionsUser)
	}
	if len(mailer.msgs) != 1 || mailer.msgs[0].Template != mail.TemplatePasswordChanged {
		t.Fatalf("письмо-уведомление не поставлено в очередь: %+v", mailer.msgs)
	}
	if mailer.msgs[0].To != user.Email {
		t.Fatalf("письмо ушло на %q, ожидался адрес аккаунта", mailer.msgs[0].To)
	}
}

func TestChangePassword_WrongCurrentChangesNothing(t *testing.T) {
	hash, err := HashPassword("old-password")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	user := User{ID: domain.NewID(), Email: "user@example.com", PasswordHash: &hash}
	store := &fakeStore{user: user, userExists: true}
	mailer := &fakeEnqueuer{}
	svc := newServiceMail(store, mailer)

	_, err = svc.ChangePassword(context.Background(), user, "not-the-password", "new-password")
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("ошибка = %v, ожидалась ErrInvalidCredentials", err)
	}
	if store.setPasswordCalled || store.sessionsDeletedByUser || len(mailer.msgs) != 0 {
		t.Fatal("провал проверки текущего пароля не должен ни менять хеш, ни рвать сессии, ни слать письмо")
	}
}

func TestChangePassword_PasswordlessAccountNeedsNoCurrent(t *testing.T) {
	// Аккаунт заведён через провайдера: пароля нет, и требовать его значит
	// запереть человека в собственном аккаунте. Доказательство — живая сессия.
	user := User{ID: domain.NewID(), Email: "yandex@example.com", PasswordHash: nil}
	store := &fakeStore{user: user, userExists: true}
	svc := newService(store)

	if _, err := svc.ChangePassword(context.Background(), user, "", "brand-new-password"); err != nil {
		t.Fatalf("аккаунту без пароля не дали его задать: %v", err)
	}
	if !store.setPasswordCalled {
		t.Fatal("хеш не поставлен")
	}
}

func TestChangePassword_ValidatesNewPassword(t *testing.T) {
	hash, err := HashPassword("old-password")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	user := User{ID: domain.NewID(), Email: "user@example.com", PasswordHash: &hash}
	store := &fakeStore{user: user, userExists: true}
	svc := newService(store)

	// Границы те же, что у регистрации и сброса: 8..128. Проверка ДО сверки
	// текущего пароля — иначе короткий новый пароль стоил бы лишнего argon2.
	if _, err := svc.ChangePassword(context.Background(), user, "old-password", "short"); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.setPasswordCalled {
		t.Error("короткий пароль всё равно поставлен")
	}
}

// Смена адреса (фаза 23, слайс D).

func emailChangeUser(t *testing.T) (User, string) {
	t.Helper()
	hash, err := HashPassword("old-password")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	return User{ID: domain.NewID(), Email: "old@example.com", PasswordHash: &hash}, hash
}

func TestRequestEmailChange_QueuesTwoLettersAndKeepsEmail(t *testing.T) {
	user, _ := emailChangeUser(t)
	store := &fakeStore{} // userExists=false → новый адрес свободен
	mailer := &fakeEnqueuer{}
	svc := newServiceMail(store, mailer)

	if err := svc.RequestEmailChange(context.Background(), user, "  New@Example.COM ", "old-password", ""); err != nil {
		t.Fatalf("RequestEmailChange: %v", err)
	}
	if !store.createdEmailChangeToken || store.emailChangeTokenUser != user.ID {
		t.Fatal("токен смены адреса не заведён")
	}
	if store.emailChangeTokenEmail != "new@example.com" {
		t.Fatalf("адрес в токене = %q, ожидался нормализованный", store.emailChangeTokenEmail)
	}
	// Адрес аккаунта НЕ меняется до перехода по ссылке: иначе опечатка стоит
	// аккаунта, а восстанавливать его будет некуда.
	if store.emailUpdated {
		t.Fatal("адрес аккаунта изменён до подтверждения")
	}
	if len(mailer.msgs) != 2 {
		t.Fatalf("писем в очереди %d, ожидалось 2 (ссылка на новый адрес, уведомление на старый)", len(mailer.msgs))
	}
	if mailer.msgs[0].Template != mail.TemplateEmailChangeConfirm || mailer.msgs[0].To != "new@example.com" {
		t.Errorf("первое письмо = %q на %q", mailer.msgs[0].Template, mailer.msgs[0].To)
	}
	if mailer.msgs[1].Template != mail.TemplateEmailChangeNotice || mailer.msgs[1].To != user.Email {
		t.Errorf("второе письмо = %q на %q, ожидалось уведомление на СТАРЫЙ адрес", mailer.msgs[1].Template, mailer.msgs[1].To)
	}
	// Уведомление на старый адрес не несёт ссылки-токена: оно сообщает, а не даёт прав.
	if _, ok := mailer.msgs[1].Data["link"]; ok {
		t.Error("в уведомлении на старый адрес оказалась ссылка с токеном")
	}
}

func TestRequestEmailChange_WrongPasswordChangesNothing(t *testing.T) {
	user, _ := emailChangeUser(t)
	store := &fakeStore{}
	mailer := &fakeEnqueuer{}
	svc := newServiceMail(store, mailer)

	// Пароль — единственное, что отличает «человек меняет свой адрес» от «увели
	// сессию и уводят аккаунт»: после смены восстановление пойдёт на новый ящик.
	err := svc.RequestEmailChange(context.Background(), user, "new@example.com", "not-the-password", "")
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("ошибка = %v, ожидалась ErrInvalidCredentials", err)
	}
	if store.createdEmailChangeToken || len(mailer.msgs) != 0 {
		t.Fatal("при неверном пароле заведён токен или отправлено письмо")
	}
}

// Второй фактор включён — пароля мало. Смена адреса уводит канал восстановления
// (сброс пароля пойдёт на новый ящик), поэтому состав подтверждения тот же, что
// у удаления аккаунта. Мутация «проверять только пароль» роняет этот тест.
func TestRequestEmailChange_RequiresSecondFactorWhenEnabled(t *testing.T) {
	user, _ := emailChangeUser(t)
	store := &fakeStore{}
	enabledTOTP(t, store)
	mailer := &fakeEnqueuer{}
	svc := newServiceMail(store, mailer).WithTOTPKey(testTOTPKey)

	err := svc.RequestEmailChange(context.Background(), user, "new@example.com", "old-password", "")
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("ошибка = %v, ожидалась ErrInvalidCredentials на пустой код", err)
	}
	if store.createdEmailChangeToken || len(mailer.msgs) != 0 {
		t.Fatal("без кода второго фактора заведён токен или ушло письмо")
	}
}

// Аккаунт через провайдера: пароля нет, и до слайса F доказывать было нечем
// вовсе — угнанной сессии хватало, чтобы увести адрес. Теперь доказывают кодом.
func TestRequestEmailChange_ProviderOnlyAccountProvesByCode(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "old@example.com"} // PasswordHash == nil
	store := &fakeStore{}
	secret := enabledTOTP(t, store)
	mailer := &fakeEnqueuer{}
	svc := newServiceMail(store, mailer).WithTOTPKey(testTOTPKey)

	if err := svc.RequestEmailChange(context.Background(), user, "new@example.com", "", ""); !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("без кода: ошибка = %v, ожидалась ErrInvalidCredentials", err)
	}
	if store.createdEmailChangeToken {
		t.Fatal("адрес уводится одной сессией — у аккаунта без пароля код и есть единственное доказательство")
	}

	code := totpCode(secret, time.Now().Unix()/30)
	if err := svc.RequestEmailChange(context.Background(), user, "new@example.com", "", code); err != nil {
		t.Fatalf("с верным кодом: %v", err)
	}
	if !store.createdEmailChangeToken || len(mailer.msgs) != 2 {
		t.Fatalf("токен=%v, писем=%d — ожидались токен и два письма", store.createdEmailChangeToken, len(mailer.msgs))
	}
}

func TestRequestEmailChange_RejectsTakenAndSameAddress(t *testing.T) {
	user, _ := emailChangeUser(t)

	taken := &fakeStore{userExists: true} // адрес занят кем-то ещё
	if err := newService(taken).RequestEmailChange(context.Background(), user, "busy@example.com", "old-password", ""); !errors.Is(err, domain.ErrEmailTaken) {
		t.Fatalf("ошибка на занятый адрес = %v, ожидалась ErrEmailTaken", err)
	}
	if taken.createdEmailChangeToken {
		t.Error("на занятый адрес заведён токен")
	}

	// Свой же адрес — не смена, а недоразумение: письмо слать некуда и незачем.
	same := &fakeStore{}
	if err := newService(same).RequestEmailChange(context.Background(), user, "OLD@example.com", "old-password", ""); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка на собственный адрес = %v, ожидалась ErrValidation", err)
	}
}

func TestConfirmEmailChange_MovesAddress(t *testing.T) {
	uid := domain.NewID()
	store := &fakeStore{changeConsumeExists: true, changeConsumeUserID: uid, changeConsumeEmail: "new@example.com"}
	svc := newService(store)

	if err := svc.ConfirmEmailChange(context.Background(), "raw-token"); err != nil {
		t.Fatalf("ConfirmEmailChange: %v", err)
	}
	if !store.emailUpdated || store.updatedEmail != "new@example.com" {
		t.Fatalf("адрес не перенесён: updated=%v email=%q", store.emailUpdated, store.updatedEmail)
	}
}

func TestConfirmEmailChange_BadTokenIsOneAnswer(t *testing.T) {
	// Нет, использован, истёк — снаружи один и тот же ответ: различать их значит
	// рассказывать перебирающему, что он угадал.
	store := &fakeStore{changeConsumeExists: false}
	svc := newService(store)

	err := svc.ConfirmEmailChange(context.Background(), "raw-token")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.emailUpdated {
		t.Error("адрес перенесён по негодному токену")
	}
}

func TestConfirmEmailChange_AddressTakenMeanwhile(t *testing.T) {
	// Между запросом и подтверждением сутки — адрес могли занять регистрацией.
	// Явная проверка, а не ловля UNIQUE: 409 с текстом полезнее 500 из драйвера.
	uid := domain.NewID()
	store := &fakeStore{
		changeConsumeExists: true, changeConsumeUserID: uid, changeConsumeEmail: "new@example.com",
		userExists: true, // адрес уже занят
	}
	svc := newService(store)

	if err := svc.ConfirmEmailChange(context.Background(), "raw-token"); !errors.Is(err, domain.ErrEmailTaken) {
		t.Fatalf("ошибка = %v, ожидалась ErrEmailTaken", err)
	}
	if store.emailUpdated {
		t.Error("адрес перенесён на занятый")
	}
}
