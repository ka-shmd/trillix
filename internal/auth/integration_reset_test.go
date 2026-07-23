//go:build integration

package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// readResetTokenFromOutbox достаёт сырой токен из письма, поставленного в outbox
// (в самом письме — ссылка кабинета с токеном; в БД у токена лежит только его SHA-256).
func readResetTokenFromOutbox(t *testing.T) string {
	t.Helper()
	var payload []byte
	err := testPool.QueryRow(context.Background(),
		`SELECT payload FROM outbox WHERE channel='email' ORDER BY created_at DESC LIMIT 1`).Scan(&payload)
	if err != nil {
		t.Fatalf("outbox: %v", err)
	}
	var msg struct {
		To   string `json:"to"`
		Data struct {
			Link string `json:"link"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	tok := mustParse(t, msg.Data.Link).Query().Get("token")
	if tok == "" {
		t.Fatalf("в ссылке нет токена: %s", msg.Data.Link)
	}
	return tok
}

func outboxCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM outbox`).Scan(&n); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	return n
}

func TestPasswordResetFlow(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	const email = "reset@example.com"
	const oldPassword = "old-supersecret"
	const newPassword = "new-supersecret"

	// Регистрация заводит пользователя и живую сессию (cookie в jar клиента c).
	if r := post(t, c, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"`+oldPassword+`"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d; %s", r.StatusCode, body(t, r))
	}

	// «Забыли пароль» → 204, письмо и токен появились.
	if r := post(t, c, srv.URL+"/api/v1/auth/forgot-password", `{"email":"`+email+`"}`, ""); r.StatusCode != http.StatusNoContent {
		t.Fatalf("forgot: %d; %s", r.StatusCode, body(t, r))
	}
	if n := outboxCount(t); n != 1 {
		t.Fatalf("в outbox %d писем, ожидалось 1", n)
	}
	token := readResetTokenFromOutbox(t)

	// Сброс по токену → 204.
	if r := post(t, c, srv.URL+"/api/v1/auth/reset-password",
		`{"token":"`+token+`","password":"`+newPassword+`"}`, ""); r.StatusCode != http.StatusNoContent {
		t.Fatalf("reset: %d; %s", r.StatusCode, body(t, r))
	}

	// Прежняя сессия мертва: /me со старой cookie → 401 (все сессии разорваны).
	if me := get(t, c, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me после сброса: %d, ожидалось 401", me.StatusCode)
	}

	// Старый пароль больше не пускает; новый — пускает.
	if r := post(t, newClient(t), srv.URL+"/api/v1/auth/login",
		`{"email":"`+email+`","password":"`+oldPassword+`"}`, ""); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("вход старым паролем: %d, ожидалось 401", r.StatusCode)
	}
	if r := post(t, newClient(t), srv.URL+"/api/v1/auth/login",
		`{"email":"`+email+`","password":"`+newPassword+`"}`, ""); r.StatusCode != http.StatusOK {
		t.Fatalf("вход новым паролем: %d, ожидалось 200; %s", r.StatusCode, body(t, r))
	}

	// Повторное использование той же ссылки → 422 (токен потреблён одноразово).
	if r := post(t, newClient(t), srv.URL+"/api/v1/auth/reset-password",
		`{"token":"`+token+`","password":"third-supersecret"}`, ""); r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("повторный сброс тем же токеном: %d, ожидалось 422", r.StatusCode)
	}
}

// Несуществующий адрес: тот же 204, но письма нет — существование не раскрывается.
func TestForgotPassword_UnknownEmail_NoLeak(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	if r := post(t, c, srv.URL+"/api/v1/auth/forgot-password", `{"email":"ghost@example.com"}`, ""); r.StatusCode != http.StatusNoContent {
		t.Fatalf("forgot неизвестного: %d, ожидалось 204", r.StatusCode)
	}
	if n := outboxCount(t); n != 0 {
		t.Fatalf("для несуществующего адреса поставлено %d писем, ожидалось 0", n)
	}
}
