//go:build integration

// Интеграционный тест auth против настоящего Postgres в контейнере — эталон
// тестов уровня «эндпоинт» (PROCESS §3). Гоняется под тегом `integration`
// (make test / CI); обычный `go test` его не собирает и остаётся герметичным.
package auth_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/pgtest"
	"github.com/ka-shmd/trierra/internal/postgres"
	"github.com/ka-shmd/trierra/internal/ratelimit"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	pool, stop, err := pgtest.Start(ctx)
	if err != nil {
		panic(err)
	}
	testPool = pool
	code := m.Run()
	stop()
	os.Exit(code)
}

// resetDB очищает данные между тестами: каждый тест видит пустую базу.
func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`TRUNCATE users, workspaces, workspace_members, sessions CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack собирает реальную вертикаль auth (repo → service → handler) поверх
// контейнерного пула. Лимитер — пермиссивный (инвариант 6: rate limit не
// ослабляется, а подменяется всё-пропускающей реализацией).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	svc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, time.Hour)
	h := auth.NewHandler(svc, ratelimit.AllowAll{}, false, "http://localhost:5173", false)
	mux := http.NewServeMux()
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	return &http.Client{Jar: jar}
}

func mustParse(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse url %q: %v", raw, err)
	}
	return u
}

// csrfHeader вытаскивает значение csrf-cookie из jar клиента, чтобы положить
// его в заголовок X-CSRF-Token (double-submit).
func csrfHeader(t *testing.T, c *http.Client, base string) string {
	t.Helper()
	u := mustParse(t, base)
	for _, ck := range c.Jar.Cookies(u) {
		if ck.Name == "csrf_token" {
			return ck.Value
		}
	}
	t.Fatal("csrf_token cookie не выдан")
	return ""
}

func TestAuthFlow_RegisterLoginMeLogout(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	const email = "user@example.com"
	const password = "supersecret1"

	// 1. Регистрация → 201, сессия и csrf-cookie выданы.
	resp := post(t, c, srv.URL+"/api/v1/auth/register", `{"email":"`+email+`","password":"`+password+`"}`, "")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: статус %d, ожидалось 201; тело=%s", resp.StatusCode, body(t, resp))
	}

	// 2. /me с cookie сессии → 200, тот самый email.
	me := get(t, c, srv.URL+"/api/v1/auth/me")
	if me.StatusCode != http.StatusOK {
		t.Fatalf("me после регистрации: статус %d, ожидалось 200", me.StatusCode)
	}
	if got := decodeEmail(t, me); got != email {
		t.Fatalf("me.email = %q, ожидалось %q", got, email)
	}

	// 3. Logout с CSRF-заголовком → 204.
	out := post(t, c, srv.URL+"/api/v1/auth/logout", "", csrfHeader(t, c, srv.URL))
	if out.StatusCode != http.StatusNoContent {
		t.Fatalf("logout: статус %d, ожидалось 204; тело=%s", out.StatusCode, body(t, out))
	}

	// 4. После logout /me → 401 (сессия мертва).
	me2 := get(t, c, srv.URL+"/api/v1/auth/me")
	if me2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me после logout: статус %d, ожидалось 401", me2.StatusCode)
	}

	// 5. Повторный вход тем же паролем → 200 (новая сессия).
	login := post(t, c, srv.URL+"/api/v1/auth/login", `{"email":"`+email+`","password":"`+password+`"}`, "")
	if login.StatusCode != http.StatusOK {
		t.Fatalf("login: статус %d, ожидалось 200; тело=%s", login.StatusCode, body(t, login))
	}
}

func TestRegister_DuplicateEmail_409(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	payload := `{"email":"dup@example.com","password":"supersecret1"}`
	if r := post(t, c, srv.URL+"/api/v1/auth/register", payload, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("первая регистрация: статус %d, ожидалось 201", r.StatusCode)
	}
	// Второй клиент без унаследованных cookie.
	r := post(t, newClient(t), srv.URL+"/api/v1/auth/register", payload, "")
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("повтор на тот же email: статус %d, ожидалось 409", r.StatusCode)
	}
	if code := decodeErrorCode(t, r); code != "email_taken" {
		t.Fatalf("код ошибки = %q, ожидалось email_taken", code)
	}
}

func TestLogin_WrongPassword_401(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	if r := post(t, c, srv.URL+"/api/v1/auth/register",
		`{"email":"who@example.com","password":"supersecret1"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("регистрация: статус %d, ожидалось 201", r.StatusCode)
	}
	r := post(t, newClient(t), srv.URL+"/api/v1/auth/login",
		`{"email":"who@example.com","password":"wrongpassword"}`, "")
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("неверный пароль: статус %d, ожидалось 401", r.StatusCode)
	}
	if code := decodeErrorCode(t, r); code != "invalid_credentials" {
		t.Fatalf("код ошибки = %q, ожидалось invalid_credentials", code)
	}
}

// --- маленькие HTTP-хелперы, чтобы тела тестов читались как сценарии ---

func post(t *testing.T, c *http.Client, url, jsonBody, csrf string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if jsonBody != "" {
		rdr = strings.NewReader(jsonBody)
	}
	req, err := http.NewRequest(http.MethodPost, url, rdr)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if jsonBody != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

func get(t *testing.T, c *http.Client, url string) *http.Response {
	t.Helper()
	resp, err := c.Get(url)
	if err != nil {
		t.Fatalf("get %s: %v", url, err)
	}
	return resp
}

func closeBody(t *testing.T, r *http.Response) {
	t.Helper()
	if err := r.Body.Close(); err != nil {
		t.Errorf("close body: %v", err)
	}
}

func body(t *testing.T, r *http.Response) string {
	t.Helper()
	defer closeBody(t, r)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return "read body: " + err.Error()
	}
	return string(b)
}

func decodeEmail(t *testing.T, r *http.Response) string {
	t.Helper()
	defer closeBody(t, r)
	var v struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
		t.Fatalf("decode user: %v", err)
	}
	return v.Email
}

func decodeErrorCode(t *testing.T, r *http.Response) string {
	t.Helper()
	defer closeBody(t, r)
	var v struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(r.Body).Decode(&v); err != nil {
		t.Fatalf("decode error envelope: %v", err)
	}
	return v.Error.Code
}
