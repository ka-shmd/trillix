//go:build integration

package auth_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/ka-shmd/trillix/internal/pgtest"
)

// emailVerifiedInMe читает по /me, подтверждён ли email (поле emailVerified в
// ответе userResponse).
func emailVerifiedInMe(t *testing.T, c *http.Client, base string) bool {
	t.Helper()
	me := get(t, c, base+"/api/v1/auth/me")
	if me.StatusCode != http.StatusOK {
		t.Fatalf("me: статус %d, ожидалось 200", me.StatusCode)
	}
	defer closeBody(t, me)
	var payload struct {
		EmailVerified bool `json:"emailVerified"`
	}
	if err := json.NewDecoder(me.Body).Decode(&payload); err != nil {
		t.Fatalf("decode me: %v", err)
	}
	return payload.EmailVerified
}

func TestEmailVerificationFlow(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	const email = "verify@example.com"
	const password = "supersecret1"

	// Регистрация → 201, живая сессия, письмо подтверждения в outbox.
	if r := post(t, c, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"`+password+`"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d; %s", r.StatusCode, body(t, r))
	}
	if n := outboxCount(t); n != 1 {
		t.Fatalf("в outbox %d писем после регистрации, ожидалось 1 (подтверждение)", n)
	}
	// Свежий аккаунт не подтверждён — кабинет покажет баннер.
	if emailVerifiedInMe(t, c, srv.URL) {
		t.Fatal("сразу после регистрации email не должен быть подтверждён")
	}

	token := readResetTokenFromOutbox(t) // формат письма тот же: ссылка с token

	// Подтверждение по токену → 204 (публичная ручка, без сессии).
	if r := post(t, newClient(t), srv.URL+"/api/v1/auth/verify-email",
		`{"token":"`+token+`"}`, ""); r.StatusCode != http.StatusNoContent {
		t.Fatalf("verify: %d; %s", r.StatusCode, body(t, r))
	}
	// Теперь /me показывает подтверждённый адрес.
	if !emailVerifiedInMe(t, c, srv.URL) {
		t.Fatal("после подтверждения email должен быть подтверждён")
	}

	// Повторное использование той же ссылки → 422 (токен потреблён одноразово).
	if r := post(t, newClient(t), srv.URL+"/api/v1/auth/verify-email",
		`{"token":"`+token+`"}`, ""); r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("повторное подтверждение тем же токеном: %d, ожидалось 422", r.StatusCode)
	}
}

func TestResendVerification_EnqueuesNewLetter(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	const email = "resend@example.com"
	const password = "supersecret1"

	if r := post(t, c, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"`+password+`"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d; %s", r.StatusCode, body(t, r))
	}
	pgtest.CompleteSignup(t, testPool, email)
	clearOutbox(t) // убираем письмо регистрации, считаем именно повторное

	// Повторная отправка (за сессией и CSRF) → 204, новое письмо в очереди.
	if r := post(t, c, srv.URL+"/api/v1/auth/resend-verification", "", csrfHeader(t, c, srv.URL)); r.StatusCode != http.StatusNoContent {
		t.Fatalf("resend: %d; %s", r.StatusCode, body(t, r))
	}
	if n := outboxCount(t); n != 1 {
		t.Fatalf("после повторной отправки в outbox %d писем, ожидалось 1", n)
	}
}
