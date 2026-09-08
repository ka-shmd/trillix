//go:build integration

// Интеграционный тест auth против настоящего Postgres в контейнере — эталон
// тестов уровня «эндпоинт» (PROCESS §3). Гоняется под тегом `integration`
// (make test / CI); обычный `go test` его не собирает и остаётся герметичным.
package auth_test

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

const testAppOrigin = "http://localhost:5173"

// newMailSvc — реальный почтовый сервис поверх контейнерного пула с dev-транспортом
// (LogMailer в /dev/null): письма реально пишутся в outbox, доставка их логирует.
func newMailSvc() *mail.Service {
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	return mail.NewService(testPool, mail.Repo{}, mail.LogMailer{Log: discard, From: "test@localhost"},
		discard, 50, mail.Backoff{Base: time.Minute, Max: time.Hour})
}

// newAuthService — реальный сервис auth с подключённой почтой (для сброса пароля)
// и настоящим модулем пространств: удаление аккаунта спрашивает у него, не
// осиротеет ли команда, и фейк здесь проверял бы не тот запрос (слайс G).
func newAuthService() *auth.Service {
	mailSvc := newMailSvc()
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now), mailSvc, testAppOrigin)
	return auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, mailSvc, time.Hour, testAppOrigin).
		WithLoginCodeKey([]byte("integration-test-login-code-key")).
		WithTeams(wsSvc).
		WithAvatars(stubAvatars{})
}

// stubAvatars подменяет объектное хранилище: интеграционный тест проверяет путь
// «ручка → сервис → колонка», а не S3 (для него есть internal/media).
type stubAvatars struct{}

func (stubAvatars) PutAvatar(_ context.Context, _ []byte) (string, error) {
	return "avatars/integration.png", nil
}

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
		`TRUNCATE users, user_identities, workspaces, workspace_members, sessions, password_reset_tokens, email_verification_tokens, login_codes, known_devices, outbox CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack собирает реальную вертикаль auth (repo → service → handler) поверх
// контейнерного пула. Лимитер — пермиссивный (инвариант 6: rate limit не
// ослабляется, а подменяется всё-пропускающей реализацией).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	svc := newAuthService()
	h := auth.NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false).
		WithPasswordReset(ratelimit.AllowAll{}, ratelimit.AllowAll{}, ratelimit.AllowAll{}).
		WithEmailVerification(ratelimit.AllowAll{}, ratelimit.AllowAll{}).
		WithAccount(auth.AccountLimits{PasswordChange: ratelimit.AllowAll{}, TwoFactor: ratelimit.AllowAll{}, DeleteAccount: ratelimit.AllowAll{}, Avatar: ratelimit.AllowAll{}})
	mux := http.NewServeMux()
	h.Routes(mux)
	h.AccountRoutes(mux)
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

// Регистрация заводит подписку личного воркспейса той же транзакцией (0014,
// фаза 17). Проверяется в настоящей БД, а не фейком: инвариант «воркспейса без
// подписки не бывает» держится схемой и транзакцией, а не намерением сервиса.
func TestRegister_CreatesSubscription(t *testing.T) {
	resetDB(t)
	srv := newStack(t)

	if r := post(t, newClient(t), srv.URL+"/api/v1/auth/register",
		`{"email":"plan@example.com","password":"supersecret1"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("регистрация: статус %d, ожидалось 201", r.StatusCode)
	}

	var planCode, status string
	// Подписка — у АККАУНТА (0016), поэтому ищется по пользователю напрямую.
	err := testPool.QueryRow(context.Background(), `
		SELECT s.plan_code, s.status
		FROM subscriptions s
		JOIN users u ON u.id = s.user_id
		WHERE u.email = 'plan@example.com'`).Scan(&planCode, &status)
	if err != nil {
		t.Fatalf("подписка аккаунта не найдена: %v", err)
	}
	if planCode != "free" || status != "active" {
		t.Fatalf("подписка = (%q, %q), ждали (free, active)", planCode, status)
	}
}

// Каталог тарифов приезжает миграцией и приезжает ВЫКЛЮЧЕННЫМ (спека §8):
// выкатка кода не запирает ничего никому, включение — отдельный UPDATE.
// Тест сторожит именно это: сегодняшний ноль запретов.
func TestPlans_SeededAndUnrestricted(t *testing.T) {
	rows, err := testPool.Query(context.Background(),
		`SELECT code, limits->>'submissions_per_month', limits->>'analytics_funnel', is_public FROM plans ORDER BY code`)
	if err != nil {
		t.Fatalf("select plans: %v", err)
	}
	defer rows.Close()

	got := map[string]string{}
	public := map[string]bool{}
	for rows.Next() {
		var code string
		var isPublic bool
		var perMonth, funnel *string
		if err := rows.Scan(&code, &perMonth, &funnel, &isPublic); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if perMonth != nil {
			t.Errorf("план %q приехал с включённым лимитом ответов (%s) — гейты должны включаться UPDATE'ом, а не миграцией", code, *perMonth)
		}
		if funnel == nil || *funnel != "true" {
			t.Errorf("план %q приехал с закрытой воронкой — то же правило", code)
		}
		got[code] = "ok"
		public[code] = isPublic
	}
	for _, code := range []string{"free", "pro", "legacy_free"} {
		if _, ok := got[code]; !ok {
			t.Errorf("в каталоге нет плана %q", code)
		}
	}
	// legacy_free — грандфазеринг: выбрать его нельзя, в нём можно только остаться.
	if public["legacy_free"] {
		t.Error("legacy_free показывается в списке тарифов")
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

// del — DELETE с CSRF-заголовком: забывание устройств меняет состояние.
func del(t *testing.T, c *http.Client, url, csrf string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
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
