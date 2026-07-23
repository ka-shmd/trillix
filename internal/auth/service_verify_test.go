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

func TestRegister_EnqueuesVerificationEmail(t *testing.T) {
	store := &fakeStore{}
	enq := &fakeEnqueuer{}
	svc := newServiceMail(store, enq)

	user, _, err := svc.Register(context.Background(), "new@example.com", "supersecret")
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	if !store.createdVerifyToken || store.createdVerifyTokenUser != user.ID {
		t.Errorf("токен подтверждения не создан для %v (created=%v user=%v)", user.ID, store.createdVerifyToken, store.createdVerifyTokenUser)
	}
	if len(enq.msgs) != 1 {
		t.Fatalf("поставлено писем: %d, ожидалось 1", len(enq.msgs))
	}
	msg := enq.msgs[0]
	if msg.To != "new@example.com" || msg.Template != mail.TemplateEmailVerification {
		t.Errorf("письмо адресовано неверно: to=%q template=%q", msg.To, msg.Template)
	}
	link, _ := msg.Data["link"].(string)
	if !strings.HasPrefix(link, "https://app.test/verify-email?token=") {
		t.Errorf("ссылка = %q, ожидался префикс кабинета с токеном", link)
	}
}

func TestVerifyEmail_ValidToken_MarksVerified(t *testing.T) {
	uid := domain.NewID()
	store := &fakeStore{verifyConsumeExists: true, verifyConsumeUserID: uid}
	svc := newService(store)

	if err := svc.VerifyEmail(context.Background(), "raw-token"); err != nil {
		t.Fatalf("VerifyEmail: %v", err)
	}
	if !store.markVerifiedCalled || store.markVerifiedUser != uid {
		t.Errorf("email не помечен подтверждённым для %v (called=%v user=%v)", uid, store.markVerifiedCalled, store.markVerifiedUser)
	}
}

func TestVerifyEmail_InvalidToken_Rejected(t *testing.T) {
	store := &fakeStore{verifyConsumeExists: false} // не найден/использован/истёк
	svc := newService(store)

	err := svc.VerifyEmail(context.Background(), "bad-token")
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.markVerifiedCalled {
		t.Error("по недействительному токену email не должен помечаться подтверждённым")
	}
}

func TestResendVerification_Unverified_EnqueuesLetter(t *testing.T) {
	id := domain.NewID()
	store := &fakeStore{}
	enq := &fakeEnqueuer{}
	svc := newServiceMail(store, enq)

	user := User{ID: id, Email: "user@example.com"} // EmailVerifiedAt == nil
	if err := svc.ResendVerification(context.Background(), user); err != nil {
		t.Fatalf("ResendVerification: %v", err)
	}
	if !store.createdVerifyToken || len(enq.msgs) != 1 {
		t.Errorf("повторное письмо не поставлено (token=%v msgs=%d)", store.createdVerifyToken, len(enq.msgs))
	}
}

// Уже подтверждённому — тихий no-op: ни токена, ни письма, ни ошибки. Иначе
// кнопка «отправить ещё раз» плодила бы письма после подтверждения.
func TestResendVerification_AlreadyVerified_NoOp(t *testing.T) {
	now := time.Now()
	store := &fakeStore{}
	enq := &fakeEnqueuer{}
	svc := newServiceMail(store, enq)

	user := User{ID: domain.NewID(), Email: "done@example.com", EmailVerifiedAt: &now}
	if err := svc.ResendVerification(context.Background(), user); err != nil {
		t.Fatalf("ResendVerification: %v", err)
	}
	if store.createdVerifyToken || len(enq.msgs) != 0 {
		t.Errorf("подтверждённому не должно слаться письмо (token=%v msgs=%d)", store.createdVerifyToken, len(enq.msgs))
	}
}
