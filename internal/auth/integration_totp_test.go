//go:build integration

package auth_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// codeFor считает TOTP-код НЕЗАВИСИМО от реализации сервиса: тест, зовущий тот
// же totpCode, проверял бы только собственную неизменность. Здесь — прямая
// формула RFC 6238 поверх секрета, который сервер показал человеку; заодно это
// проверка контракта «показанный секрет годится для приложения».
func codeFor(t *testing.T, shownSecret string, at time.Time) string {
	t.Helper()
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).
		DecodeString(strings.ReplaceAll(shownSecret, " ", ""))
	if err != nil {
		t.Fatalf("секрет с экрана не декодируется: %v", err)
	}
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(at.Unix()/30))
	mac := hmac.New(sha1.New, raw)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1_000_000)
}

// Полный путь второго фактора: включение, вход в два шага, отказ на повторе
// кода. Четвёртый пункт критерия приёмки фазы 23.
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

	// 1. Настройка: секрет и ссылка для приложения.
	setup := post(t, c, srv.URL+"/api/v1/account/2fa/setup", "", csrf)
	if setup.StatusCode != http.StatusOK {
		t.Fatalf("setup: статус %d; тело=%s", setup.StatusCode, body(t, setup))
	}
	var setupBody struct {
		Secret     string `json:"secret"`
		OtpauthURL string `json:"otpauthUrl"`
	}
	if err := json.NewDecoder(setup.Body).Decode(&setupBody); err != nil {
		t.Fatalf("разбор setup: %v", err)
	}
	_ = setup.Body.Close()
	if setupBody.Secret == "" || !strings.HasPrefix(setupBody.OtpauthURL, "otpauth://totp/") {
		t.Fatalf("setup вернул %+v", setupBody)
	}
	// Пока код не подтверждён, фактор ВЫКЛЮЧЕН — иначе брошенная на середине
	// настройка запирала бы человека снаружи.
	if twoFactorOf(t, get(t, c, srv.URL+"/api/v1/auth/me")) {
		t.Fatal("фактор включён до подтверждения кодом")
	}

	// 2. Включение первым сошедшимся кодом → резервные коды, один раз.
	enable := post(t, c, srv.URL+"/api/v1/account/2fa/enable",
		`{"code":"`+codeFor(t, setupBody.Secret, time.Now())+`"}`, csrf)
	if enable.StatusCode != http.StatusOK {
		t.Fatalf("enable: статус %d; тело=%s", enable.StatusCode, body(t, enable))
	}
	var enableBody struct {
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	if err := json.NewDecoder(enable.Body).Decode(&enableBody); err != nil {
		t.Fatalf("разбор enable: %v", err)
	}
	_ = enable.Body.Close()
	if len(enableBody.RecoveryCodes) != 10 {
		t.Fatalf("резервных кодов %d, ожидалось 10", len(enableBody.RecoveryCodes))
	}
	if !twoFactorOf(t, get(t, c, srv.URL+"/api/v1/auth/me")) {
		t.Fatal("после подтверждения фактор не включён")
	}
	// В базе — шифротекст, а не секрет с экрана.
	var stored []byte
	if err := testPool.QueryRow(context.Background(), `SELECT secret FROM user_totp`).Scan(&stored); err != nil {
		t.Fatalf("select secret: %v", err)
	}
	if strings.Contains(string(stored), strings.ReplaceAll(setupBody.Secret, " ", "")) {
		t.Fatal("секрет лежит в базе открытым текстом")
	}

	// 3. Новый браузер: пароль верен, но сессии нет — только пропуск на код.
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

	// 4. Второй шаг: код открывает сессию.
	//
	// Код берётся на СЛЕДУЮЩИЙ шаг (30 с вперёд), и это не хитрость теста, а
	// прямое следствие защиты от повтора: код текущего шага уже израсходован
	// включением фактора секундой раньше. В жизни между «включил» и «вошёл»
	// проходят минуты; здесь то же самое достигается сдвигом на шаг, который
	// сервер принимает окном ±1 (часы телефона спешат).
	code := codeFor(t, setupBody.Secret, time.Now().Add(30*time.Second))
	second := post(t, fresh, srv.URL+"/api/v1/auth/login-2fa", `{"code":"`+code+`"}`, "")
	if second.StatusCode != http.StatusOK {
		t.Fatalf("login-2fa: статус %d; тело=%s", second.StatusCode, body(t, second))
	}
	if me := get(t, fresh, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusOK {
		t.Fatalf("me после кода: статус %d", me.StatusCode)
	}

	// 5. Тот же код второй раз не работает — даже в пределах своих 30 секунд.
	third := newClient(t)
	if r := post(t, third, srv.URL+"/api/v1/auth/login", `{"email":"`+email+`","password":"`+password+`"}`, ""); r.StatusCode != http.StatusOK {
		t.Fatalf("повторный первый шаг: статус %d", r.StatusCode)
	}
	replay := post(t, third, srv.URL+"/api/v1/auth/login-2fa", `{"code":"`+code+`"}`, "")
	if replay.StatusCode != http.StatusUnauthorized {
		t.Fatalf("повтор кода: статус %d, ожидалось 401", replay.StatusCode)
	}

	// 6. Резервный код работает и сгорает.
	recovery := enableBody.RecoveryCodes[0]
	if r := post(t, third, srv.URL+"/api/v1/auth/login-2fa", `{"code":"`+recovery+`"}`, ""); r.StatusCode != http.StatusOK {
		t.Fatalf("вход резервным кодом: статус %d", r.StatusCode)
	}
	fourth := newClient(t)
	if r := post(t, fourth, srv.URL+"/api/v1/auth/login", `{"email":"`+email+`","password":"`+password+`"}`, ""); r.StatusCode != http.StatusOK {
		t.Fatalf("первый шаг: статус %d", r.StatusCode)
	}
	if r := post(t, fourth, srv.URL+"/api/v1/auth/login-2fa", `{"code":"`+recovery+`"}`, ""); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("повтор резервного кода: статус %d, ожидалось 401", r.StatusCode)
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
