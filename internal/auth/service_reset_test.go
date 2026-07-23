package auth

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/mail"
)

func TestRequestPasswordReset_ExistingUser_EnqueuesLetter(t *testing.T) {
	id := domain.NewID()
	hash := "argon2-hash"
	store := &fakeStore{userExists: true, user: User{ID: id, Email: "user@example.com", PasswordHash: &hash}}
	enq := &fakeEnqueuer{}
	svc := newServiceMail(store, enq)

	if err := svc.RequestPasswordReset(context.Background(), "  User@Example.COM "); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	if !store.createdResetToken || store.createdResetTokenUser != id {
		t.Errorf("токен не создан для пользователя %v (created=%v, user=%v)", id, store.createdResetToken, store.createdResetTokenUser)
	}
	if len(enq.msgs) != 1 {
		t.Fatalf("поставлено писем: %d, ожидалось 1", len(enq.msgs))
	}
	msg := enq.msgs[0]
	if msg.To != "user@example.com" {
		t.Errorf("получатель = %q, ожидался user@example.com", msg.To)
	}
	if msg.Template != mail.TemplatePasswordReset {
		t.Errorf("шаблон = %q, ожидался %q", msg.Template, mail.TemplatePasswordReset)
	}
	link, _ := msg.Data["link"].(string)
	if !strings.HasPrefix(link, "https://app.test/reset-password?token=") {
		t.Errorf("ссылка = %q, ожидался префикс кабинета с токеном", link)
	}
}

func TestRequestPasswordReset_UnknownEmail_Silent(t *testing.T) {
	store := &fakeStore{userExists: false}
	enq := &fakeEnqueuer{}
	svc := newServiceMail(store, enq)

	// Не раскрываем существование аккаунта: тот же успех, но без токена и письма.
	if err := svc.RequestPasswordReset(context.Background(), "nobody@example.com"); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	if store.createdResetToken {
		t.Error("создан токен для несуществующего адреса")
	}
	if len(enq.msgs) != 0 {
		t.Errorf("поставлено писем: %d, ожидалось 0", len(enq.msgs))
	}
}

// provider-only аккаунт (password_hash IS NULL) тоже получает письмо — это и есть
// починка TD-34: владелец задаёт пароль и делает аккаунт достижимым.
func TestRequestPasswordReset_ProviderOnlyAccount_EnqueuesLetter(t *testing.T) {
	id := domain.NewID()
	store := &fakeStore{userExists: true, user: User{ID: id, Email: "yandex@example.com", PasswordHash: nil}}
	enq := &fakeEnqueuer{}
	svc := newServiceMail(store, enq)

	if err := svc.RequestPasswordReset(context.Background(), "yandex@example.com"); err != nil {
		t.Fatalf("RequestPasswordReset: %v", err)
	}
	if len(enq.msgs) != 1 || !store.createdResetToken {
		t.Errorf("provider-only аккаунт не получил письмо сброса (msgs=%d, token=%v)", len(enq.msgs), store.createdResetToken)
	}
}

func TestResetPassword_ValidToken_SetsPasswordAndKillsSessions(t *testing.T) {
	uid := domain.NewID()
	store := &fakeStore{consumeExists: true, consumeUserID: uid}
	svc := newService(store)

	if err := svc.ResetPassword(context.Background(), "raw-token", "brand-new-password"); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if !store.setPasswordCalled || store.setPasswordUser != uid {
		t.Errorf("пароль не установлен для %v (called=%v user=%v)", uid, store.setPasswordCalled, store.setPasswordUser)
	}
	if store.setPasswordHash == "" || store.setPasswordHash == "brand-new-password" {
		t.Errorf("пароль сохранён не как argon2-хеш: %q", store.setPasswordHash)
	}
	if !store.sessionsDeletedByUser || store.deletedSessionsUser != uid {
		t.Errorf("сессии пользователя не разорваны (called=%v user=%v)", store.sessionsDeletedByUser, store.deletedSessionsUser)
	}
}

func TestResetPassword_InvalidToken_Rejected(t *testing.T) {
	store := &fakeStore{consumeExists: false} // токен не найден/использован/истёк
	svc := newService(store)

	err := svc.ResetPassword(context.Background(), "bad-token", "brand-new-password")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.setPasswordCalled || store.sessionsDeletedByUser {
		t.Error("по недействительному токену пароль/сессии не должны меняться")
	}
}

// Пароль валидируется ДО потребления токена: короткий пароль не должен сжигать
// одноразовую ссылку.
func TestResetPassword_ShortPassword_DoesNotConsumeToken(t *testing.T) {
	store := &fakeStore{consumeExists: true, consumeUserID: uuid.New()}
	svc := newService(store)

	err := svc.ResetPassword(context.Background(), "raw-token", "short")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.consumeCalled {
		t.Error("токен потреблён при невалидном пароле — ссылка сгорела зря")
	}
}
