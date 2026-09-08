//go:build integration

package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

// Полный путь второго фактора: включение, вход с кодом из письма, повтор кода,
// знакомое устройство. Критерий приёмки — docs/design/two-factor-email.md §1.

// readLoginCodeFromOutbox достаёт код из письма — ровно так его получает
// человек. Тест, читающий код из login_codes, проверял бы только собственную
// неизменность: там лежит HMAC, а не код.
func readLoginCodeFromOutbox(t *testing.T, template string) string {
	t.Helper()
	var payload []byte
	err := testPool.QueryRow(context.Background(),
		`SELECT payload FROM outbox WHERE channel='email' AND payload->>'template' = $1
		 ORDER BY created_at DESC LIMIT 1`, template).Scan(&payload)
	if err != nil {
		t.Fatalf("outbox (%s): %v", template, err)
	}
	var msg struct {
		Data struct {
			Code string `json:"code"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if msg.Data.Code == "" {
		t.Fatalf("в письме нет кода: %s", payload)
	}
	return msg.Data.Code
}

func TestTwoFactor_FullLoginRoundTrip(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	const email = "user@example.com"
	const password = "supersecret1"
	if r := post(t, c, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"`+password+`"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("register: статус %d", r.StatusCode)
	}
	csrf := csrfHeader(t, c, srv.URL)

	// 1. Включение: пароль, и больше ничего — ни секретов, ни резервных кодов.
	enable := post(t, c, srv.URL+"/api/v1/account/2fa/enable",
		`{"currentPassword":"`+password+`"}`, csrf)
	if enable.StatusCode != http.StatusOK {
		t.Fatalf("enable: статус %d; тело=%s", enable.StatusCode, body(t, enable))
	}
	if !twoFactorOf(t, get(t, c, srv.URL+"/api/v1/auth/me")) {
		t.Fatal("после включения фактор выключен")
	}

	// Мина: без пароля включение означало бы, что посторонний за незалоченной
	// машиной меняет настройку безопасности хозяина.
	if r := post(t, c, srv.URL+"/api/v1/account/2fa/disable", `{"currentPassword":"wrong"}`, csrf); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("выключение неверным паролем: статус %d, ожидалось 401", r.StatusCode)
	}

	// 2. Новый браузер: пароль верен, но сессии нет — только пропуск и письмо.
	fresh := newClient(t)
	login := post(t, fresh, srv.URL+"/api/v1/auth/login", `{"email":"`+email+`","password":"`+password+`"}`, "")
	if login.StatusCode != http.StatusOK {
		t.Fatalf("login: статус %d", login.StatusCode)
	}
	var loginBody map[string]bool
	if err := json.NewDecoder(login.Body).Decode(&loginBody); err != nil {
		t.Fatalf("разбор login: %v", err)
	}
	_ = login.Body.Close()
	if !loginBody["twoFactorRequired"] {
		t.Fatalf("тело входа = %v, ожидалось требование кода", loginBody)
	}
	if me := get(t, fresh, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me после первого шага: статус %d, ожидалось 401 — пароль сам по себе не должен пускать", me.StatusCode)
	}

	// 3. Код из письма открывает сессию.
	code := readLoginCodeFromOutbox(t, "login_code")
	if r := post(t, fresh, srv.URL+"/api/v1/auth/login-2fa", `{"code":"`+code+`"}`, ""); r.StatusCode != http.StatusOK {
		t.Fatalf("login-2fa: статус %d; тело=%s", r.StatusCode, body(t, r))
	}
	if me := get(t, fresh, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusOK {
		t.Fatalf("me после кода: статус %d", me.StatusCode)
	}

	// 4. Тот же код второй раз не работает — он одноразовый.
	third := newClient(t)
	if r := post(t, third, srv.URL+"/api/v1/auth/login", `{"email":"`+email+`","password":"`+password+`"}`, ""); r.StatusCode != http.StatusOK {
		t.Fatalf("повторный первый шаг: статус %d", r.StatusCode)
	}
	if r := post(t, third, srv.URL+"/api/v1/auth/login-2fa", `{"code":"`+code+`"}`, ""); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("повтор кода: статус %d, ожидалось 401", r.StatusCode)
	}

	// 5. Тот же браузер, что уже предъявлял код, входит без кода: ради этого
	// фактор и спрашивают только на незнакомом устройстве.
	if r := post(t, fresh, srv.URL+"/api/v1/auth/logout", "", csrfHeader(t, fresh, srv.URL)); r.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: статус %d", r.StatusCode)
	}
	again := post(t, fresh, srv.URL+"/api/v1/auth/login", `{"email":"`+email+`","password":"`+password+`"}`, "")
	if again.StatusCode != http.StatusOK {
		t.Fatalf("повторный вход со знакомого браузера: статус %d", again.StatusCode)
	}
	var againBody map[string]bool
	if err := json.NewDecoder(again.Body).Decode(&againBody); err != nil {
		t.Fatalf("разбор повторного входа: %v", err)
	}
	_ = again.Body.Close()
	if againBody["twoFactorRequired"] {
		t.Fatal("знакомый браузер снова спрашивает код")
	}
	if me := get(t, fresh, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusOK {
		t.Fatalf("me после входа со знакомого браузера: статус %d", me.StatusCode)
	}

	// 6. Список устройств: знакомый браузер в нём есть.
	devices := get(t, fresh, srv.URL+"/api/v1/account/devices")
	if devices.StatusCode != http.StatusOK {
		t.Fatalf("devices: статус %d", devices.StatusCode)
	}
	var devicesBody struct {
		Devices []struct {
			ID      string `json:"id"`
			Label   string `json:"label"`
			Current bool   `json:"current"`
		} `json:"devices"`
	}
	if err := json.NewDecoder(devices.Body).Decode(&devicesBody); err != nil {
		t.Fatalf("разбор devices: %v", err)
	}
	_ = devices.Body.Close()
	if len(devicesBody.Devices) != 1 || !devicesBody.Devices[0].Current {
		t.Fatalf("список устройств = %+v, ожидалось одно текущее", devicesBody.Devices)
	}

	// 7. «Забыть все» — и знакомство кончилось: следующий вход снова с кодом.
	if r := del(t, fresh, srv.URL+"/api/v1/account/devices", csrfHeader(t, fresh, srv.URL)); r.StatusCode != http.StatusNoContent {
		t.Fatalf("forget devices: статус %d; тело=%s", r.StatusCode, body(t, r))
	}
	forgot := post(t, fresh, srv.URL+"/api/v1/auth/login", `{"email":"`+email+`","password":"`+password+`"}`, "")
	var forgotBody map[string]bool
	if err := json.NewDecoder(forgot.Body).Decode(&forgotBody); err != nil {
		t.Fatalf("разбор входа после забывания: %v", err)
	}
	_ = forgot.Body.Close()
	if !forgotBody["twoFactorRequired"] {
		t.Fatal("после «забыть все устройства» вход прошёл без кода")
	}
}

// Смена адреса у аккаунта с включённым фактором: код берётся ручкой send-code,
// потому что взять его больше негде.
func TestTwoFactor_EmailChangeUsesActionCode(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	const email = "owner@example.com"
	const password = "supersecret1"
	if r := post(t, c, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"`+password+`"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("register: статус %d", r.StatusCode)
	}
	csrf := csrfHeader(t, c, srv.URL)
	if r := post(t, c, srv.URL+"/api/v1/account/2fa/enable", `{"currentPassword":"`+password+`"}`, csrf); r.StatusCode != http.StatusOK {
		t.Fatalf("enable: статус %d", r.StatusCode)
	}

	// Без кода смена адреса не проходит: адрес уводит канал восстановления.
	if r := post(t, c, srv.URL+"/api/v1/account/email",
		`{"newEmail":"new@example.com","currentPassword":"`+password+`","code":""}`, csrf); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("смена адреса без кода: статус %d, ожидалось 401", r.StatusCode)
	}

	if r := post(t, c, srv.URL+"/api/v1/account/2fa/send-code", "", csrf); r.StatusCode != http.StatusNoContent {
		t.Fatalf("send-code: статус %d; тело=%s", r.StatusCode, body(t, r))
	}
	code := readLoginCodeFromOutbox(t, "account_action_code")
	if r := post(t, c, srv.URL+"/api/v1/account/email",
		`{"newEmail":"new@example.com","currentPassword":"`+password+`","code":"`+code+`"}`, csrf); r.StatusCode != http.StatusNoContent {
		t.Fatalf("смена адреса с кодом: статус %d; тело=%s", r.StatusCode, body(t, r))
	}
}

func twoFactorOf(t *testing.T, r *http.Response) bool {
	t.Helper()
	defer func() { _ = r.Body.Close() }()
	var u struct {
		TwoFactorEnabled bool `json:"twoFactorEnabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		t.Fatalf("разбор профиля: %v", err)
	}
	return u.TwoFactorEnabled
}
