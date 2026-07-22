//go:build integration

package auth_test

import (
	"context"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/oauth"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

// stubProvider отдаёт заранее заданный профиль, не выходя в сеть. Обмен кода на
// профиль уже покрыт юнитами internal/oauth против httptest-Яндекса; здесь
// проверяется то, что юнитами не проверить, — что делает с профилем реальная
// вертикаль поверх настоящего Postgres.
type stubProvider struct{ profile oauth.Profile }

func (stubProvider) Name() string               { return "yandex" }
func (stubProvider) AuthURL(_, _ string) string { return "https://provider.example/auth" }
func (p stubProvider) Exchange(context.Context, string, string) (oauth.Profile, error) {
	return p.profile, nil
}

const appOrigin = "http://localhost:5173"

// newOAuthStack — реальная вертикаль с включённым провайдером.
func newOAuthStack(t *testing.T, profile oauth.Profile) *httptest.Server {
	t.Helper()
	svc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, time.Hour)
	h := auth.NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, appOrigin, false).
		WithOAuth(svc, map[string]oauth.Provider{"yandex": stubProvider{profile}}, ratelimit.AllowAll{}, []byte("integration-test-secret"))
	mux := http.NewServeMux()
	h.Routes(mux)
	h.OAuthRoutes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// noRedirectClient не ходит по редиректам: колбэк отвечает 302 на кабинет, и
// нам нужен именно ответ бэка, а не попытка сходить на localhost:5173.
func noRedirectClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	return &http.Client{
		Jar:           jar,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// walkStartAndCallback проходит полный путь: /start (получить state в cookie) →
// /callback с тем же state. Возвращает ответ колбэка.
func walkStartAndCallback(t *testing.T, srv *httptest.Server, c *http.Client) *http.Response {
	t.Helper()

	start, err := c.Get(srv.URL + "/api/v1/auth/oauth/yandex/start")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	_ = start.Body.Close()

	// state достаём из выданной cookie — ровно так же, как это сделал бы браузер.
	var state string
	for _, ck := range c.Jar.Cookies(mustParse(t, srv.URL)) {
		if ck.Name == "oauth_state" {
			state, _, _ = strings.Cut(ck.Value, ":")
		}
	}
	if state == "" {
		t.Fatal("cookie состояния не выдана — дальше идти бессмысленно")
	}

	resp, err := c.Get(srv.URL + "/api/v1/auth/oauth/yandex/callback?code=any&state=" + url.QueryEscape(state))
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	return resp
}

func countUsers(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM users`).Scan(&n); err != nil {
		t.Fatalf("count users: %v", err)
	}
	return n
}

func hasSessionCookie(c *http.Client, srv *httptest.Server, t *testing.T) bool {
	t.Helper()
	for _, ck := range c.Jar.Cookies(mustParse(t, srv.URL)) {
		if ck.Name == "session" && ck.Value != "" {
			return true
		}
	}
	return false
}

// Первый вход через провайдера заводит аккаунт без пароля вместе с личным
// воркспейсом и привязкой; повторный — входит в тот же, а не создаёт второй.
func TestOAuth_FirstLoginCreatesAccount_SecondReuses(t *testing.T) {
	resetDB(t)
	srv := newOAuthStack(t, oauth.Profile{ID: "1234567", Email: "New@Yandex.RU"})

	c := noRedirectClient(t)
	resp := walkStartAndCallback(t, srv, c)
	_ = resp.Body.Close()

	if resp.StatusCode != http.StatusFound {
		t.Fatalf("код = %d, want 302", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); loc != appOrigin+"/" {
		t.Fatalf("Location = %q, want %q", loc, appOrigin+"/")
	}
	if !hasSessionCookie(c, srv, t) {
		t.Fatal("сессия не выдана")
	}

	var email string
	var passwordless bool
	err := testPool.QueryRow(context.Background(), `
		SELECT u.email, u.password_hash IS NULL
		FROM user_identities i JOIN users u ON u.id = i.user_id
		WHERE i.provider = 'yandex' AND i.provider_user_id = '1234567'`).Scan(&email, &passwordless)
	if err != nil {
		t.Fatalf("привязка не создана: %v", err)
	}
	if email != "new@yandex.ru" {
		t.Fatalf("email в базе = %q — не нормализован", email)
	}
	if !passwordless {
		t.Fatal("у аккаунта, заведённого провайдером, проставлен пароль")
	}

	// Личный воркспейс — часть инварианта регистрации.
	var members int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM workspace_members`).Scan(&members); err != nil {
		t.Fatalf("count members: %v", err)
	}
	if members != 1 {
		t.Fatalf("членств в воркспейсах = %d, want 1", members)
	}

	// Повторный вход тем же аккаунтом провайдера.
	resp2 := walkStartAndCallback(t, srv, noRedirectClient(t))
	_ = resp2.Body.Close()
	if n := countUsers(t); n != 1 {
		t.Fatalf("пользователей после повторного входа = %d, want 1", n)
	}
}

// Главный сценарий безопасности фазы: адрес занят парольным аккаунтом. Сессия
// не выдаётся до ввода пароля, а после ввода — вход в ТОТ ЖЕ аккаунт.
func TestOAuth_ExistingEmail_RequiresPasswordThenLinks(t *testing.T) {
	resetDB(t)
	srv := newOAuthStack(t, oauth.Profile{ID: "7654321", Email: "owner@yandex.ru"})

	// Заводим парольный аккаунт обычной регистрацией.
	reg := newClient(t)
	body := strings.NewReader(`{"email":"owner@yandex.ru","password":"owner-password"}`)
	rr, err := reg.Post(srv.URL+"/api/v1/auth/register", "application/json", body)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	_ = rr.Body.Close()
	if rr.StatusCode != http.StatusCreated {
		t.Fatalf("регистрация: код = %d", rr.StatusCode)
	}

	// Вход через провайдера на тот же адрес.
	c := noRedirectClient(t)
	resp := walkStartAndCallback(t, srv, c)
	_ = resp.Body.Close()

	if loc := resp.Header.Get("Location"); !strings.Contains(loc, "/link-account") {
		t.Fatalf("Location = %q, ожидался экран привязки", loc)
	}
	if hasSessionCookie(c, srv, t) {
		t.Fatal("ВЫДАНА СЕССИЯ к чужому аккаунту по одному совпадению email")
	}
	var identities int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM user_identities`).Scan(&identities); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if identities != 0 {
		t.Fatal("привязка создана без доказательства владения аккаунтом")
	}

	// Неверный пароль привязку не даёт.
	bad, err := c.Post(srv.URL+"/api/v1/auth/oauth/link", "application/json",
		strings.NewReader(`{"email":"owner@yandex.ru","password":"wrong-password"}`))
	if err != nil {
		t.Fatalf("link (неверный пароль): %v", err)
	}
	_ = bad.Body.Close()
	if bad.StatusCode != http.StatusUnauthorized {
		t.Fatalf("неверный пароль: код = %d, want 401", bad.StatusCode)
	}
	if hasSessionCookie(c, srv, t) {
		t.Fatal("сессия выдана при неверном пароле")
	}

	// Верный — привязывает и пускает.
	ok, err := c.Post(srv.URL+"/api/v1/auth/oauth/link", "application/json",
		strings.NewReader(`{"email":"owner@yandex.ru","password":"owner-password"}`))
	if err != nil {
		t.Fatalf("link: %v", err)
	}
	_ = ok.Body.Close()
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("привязка: код = %d, want 200", ok.StatusCode)
	}
	if !hasSessionCookie(c, srv, t) {
		t.Fatal("сессия не выдана после верного пароля")
	}

	// Пользователь остался один — привязка, а не второй аккаунт.
	if n := countUsers(t); n != 1 {
		t.Fatalf("пользователей = %d, want 1 (должна быть привязка, а не дубль)", n)
	}
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM user_identities`).Scan(&identities); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if identities != 1 {
		t.Fatalf("привязок = %d, want 1", identities)
	}

	// И теперь вход через провайдера идёт сразу в кабинет.
	c2 := noRedirectClient(t)
	resp2 := walkStartAndCallback(t, srv, c2)
	_ = resp2.Body.Close()
	if loc := resp2.Header.Get("Location"); loc != appOrigin+"/" {
		t.Fatalf("после привязки Location = %q, want %q", loc, appOrigin+"/")
	}
	if !hasSessionCookie(c2, srv, t) {
		t.Fatal("после привязки вход в один клик не работает")
	}
}
