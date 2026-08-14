package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Удаление аккаунта (фаза 23, слайс G). Проверяется здесь то, что видно без БД:
// чем подтверждается, кого не пускает и что делает при успехе. Слепота чтений к
// пометке и 404 публичной формы живут в запросах — их проверяет интеграционный
// набор.

// fakeTeams — ответ модуля пространств «мешают ли команды удалению».
type fakeTeams struct {
	names  []string
	err    error
	asked  bool
	userID uuid.UUID
}

func (f *fakeTeams) TeamsBlockingAccountDeletion(_ context.Context, userID uuid.UUID) ([]string, error) {
	f.asked = true
	f.userID = userID
	return f.names, f.err
}

func newDeleteService(store *fakeStore, teams *fakeTeams) *Service {
	return newService(store).WithTOTPKey(testTOTPKey).WithTeams(teams)
}

// passwordUser — аккаунт с паролем «right-password».
func passwordUser(t *testing.T) User {
	t.Helper()
	hash, err := HashPassword("right-password")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	return User{ID: domain.NewID(), Email: "ivan@example.com", PasswordHash: &hash}
}

func TestDeleteAccount_MarksAndKillsSessions(t *testing.T) {
	store := &fakeStore{}
	teams := &fakeTeams{}
	svc := newDeleteService(store, teams)
	user := passwordUser(t)

	if err := svc.DeleteAccount(context.Background(), user, "right-password", ""); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	if !store.userDeleted || store.deletedUserID != user.ID {
		t.Fatalf("пометка не поставлена (deleted=%v user=%v)", store.userDeleted, store.deletedUserID)
	}
	// Сессии рвутся все: помеченный аккаунт с живой cookie — это кабинет,
	// который открывается ровно до первого запроса.
	if !store.sessionsDeletedByUser || store.deletedSessionsUser != user.ID {
		t.Fatalf("сессии не разорваны (deleted=%v user=%v)", store.sessionsDeletedByUser, store.deletedSessionsUser)
	}
	if !teams.asked {
		t.Error("владение пространствами не спрошено — участники могли осиротеть")
	}
}

func TestDeleteAccount_WrongPasswordRefused(t *testing.T) {
	store := &fakeStore{}
	teams := &fakeTeams{}
	svc := newDeleteService(store, teams)

	err := svc.DeleteAccount(context.Background(), passwordUser(t), "wrong-password", "")
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("ошибка = %v, ожидалась ErrInvalidCredentials", err)
	}
	if store.userDeleted {
		t.Fatal("аккаунт помечен удалённым без верного пароля")
	}
}

// Второй фактор включён — пароля мало. Мутация «проверять только пароль» роняет
// этот тест: украденной сессии со знанием пароля не должно хватать, чтобы снести
// аккаунт мимо фактора, ради которого его включали.
func TestDeleteAccount_RequiresSecondFactorWhenEnabled(t *testing.T) {
	store := &fakeStore{}
	enabledTOTP(t, store)
	svc := newDeleteService(store, &fakeTeams{})

	err := svc.DeleteAccount(context.Background(), passwordUser(t), "right-password", "")
	if !errors.Is(err, domain.ErrInvalidCredentials) {
		t.Fatalf("ошибка = %v, ожидалась ErrInvalidCredentials на пустой код", err)
	}
	if store.userDeleted {
		t.Fatal("аккаунт удалён без кода второго фактора")
	}
}

func TestDeleteAccount_SecondFactorCodeAccepted(t *testing.T) {
	store := &fakeStore{}
	secret := enabledTOTP(t, store)
	svc := newDeleteService(store, &fakeTeams{})

	code := totpCode(secret, time.Now().Unix()/30)
	if err := svc.DeleteAccount(context.Background(), passwordUser(t), "right-password", code); err != nil {
		t.Fatalf("DeleteAccount с верным кодом: %v", err)
	}
	if !store.userDeleted {
		t.Fatal("пометка не поставлена при верном пароле и коде")
	}
}

// Аккаунт через провайдера: пароля нет и фактора нет — доказательством служит
// сама сессия, требовать несуществующее нечем.
func TestDeleteAccount_ProviderOnlyAccountNeedsNothingButSession(t *testing.T) {
	store := &fakeStore{}
	svc := newDeleteService(store, &fakeTeams{})
	user := User{ID: domain.NewID(), Email: "ivan@yandex.ru"}

	if err := svc.DeleteAccount(context.Background(), user, "", ""); err != nil {
		t.Fatalf("DeleteAccount: %v", err)
	}
	if !store.userDeleted {
		t.Fatal("аккаунт без пароля не удалился")
	}
}

// Владелец команды с участниками не удаляется: у пространства ровно один
// владелец, и его уход оставил бы людей в пространстве, работающем по плану
// несуществующего аккаунта (TD-53).
func TestDeleteAccount_OwnerOfTeamWithMembersRefused(t *testing.T) {
	store := &fakeStore{}
	teams := &fakeTeams{names: []string{"Отдел маркетинга", "Дизайн"}}
	svc := newDeleteService(store, teams)

	err := svc.DeleteAccount(context.Background(), passwordUser(t), "right-password", "")
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ошибка = %v, ожидался ErrConflict", err)
	}
	// В тексте — имена пространств: «передайте владение» без ответа на «каких
	// именно» отправляет человека искать их по всему кабинету.
	if msg := err.Error(); !strings.Contains(msg, "Отдел маркетинга") || !strings.Contains(msg, "Дизайн") {
		t.Errorf("в тексте отказа нет имён пространств: %q", msg)
	}
	if store.userDeleted {
		t.Fatal("аккаунт помечен удалённым вопреки отказу")
	}
}

// WithTeams не вызван — удаление отвечает ошибкой, а не догадкой «наверное,
// команд нет»: это ошибка сборки процесса, и молча удалять по ней нельзя.
func TestDeleteAccount_WithoutTeamsSourceRefuses(t *testing.T) {
	store := &fakeStore{}
	svc := newService(store).WithTOTPKey(testTOTPKey)

	if err := svc.DeleteAccount(context.Background(), passwordUser(t), "right-password", ""); err == nil {
		t.Fatal("удаление прошло без подключённого источника владения пространствами")
	}
	if store.userDeleted {
		t.Fatal("аккаунт помечен удалённым при несобранном сервисе")
	}
}
