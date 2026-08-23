//go:build integration

// Интеграционные тесты интеграций против настоящего Postgres: реальная вертикаль
// auth + workspaces + integrations. Проверяется то, чего не видно на фейках, —
// права двух ролей на живых членствах и ВИД ТОКЕНА В БАЗЕ.
//
// Провайдер здесь подставной: живой поход в Google означал бы тест, зелёный
// только при интернете и настоящем аккаунте.
package integrations_test

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

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/workspaces"
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

const appOrigin = "http://localhost:5173"

func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`TRUNCATE users, workspaces, workspace_members, sessions, integration_accounts CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack — реальная вертикаль поверх контейнерного пула. Лимитеры auth —
// пермиссивные (инвариант 6: лимит не ослабляется ради теста, а инжектируется).
func newStack(t *testing.T, provider integrations.Provider) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, appOrigin, false)

	plans := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, plans,
		pgtest.MailService(testPool), appOrigin)

	svc := integrations.NewService(testPool, integrations.Repo{}, wsSvc, provider, testKey)
	h := integrations.NewHandler(svc, authH.RequireAuth, authH.RequireCSRF, appOrigin, false, testKey)

	mux := http.NewServeMux()
	authH.Routes(mux)
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type statusDTO struct {
	Enabled     bool   `json:"enabled"`
	Connected   bool   `json:"connected"`
	Email       string `json:"email"`
	ConnectedAt string `json:"connectedAt"`
	CanManage   bool   `json:"canManage"`
}

// Владелец видит настроенный, но не подключённый провайдер — и кнопку.
func TestIntegrations_OwnerSeesManageable(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	var got statusDTO
	r := do(t, owner, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/integrations")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200", r.StatusCode)
	}
	decode(t, r, &got)

	if !got.Enabled || got.Connected || !got.CanManage {
		t.Fatalf("состояние = %+v, ожидалось «настроено, не подключено, управляемо»", got)
	}
}

// Редактор видит состояние, но управлять не может — ни полем ответа, ни ручкой.
func TestIntegrations_EditorSeesButCannotManage(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")

	var got statusDTO
	decode(t, do(t, editor, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/integrations"), &got)
	if !got.Enabled || got.CanManage {
		t.Fatalf("состояние редактора = %+v, ожидалось «видит, но не управляет»", got)
	}

	// Ручка подключения — не «кнопка спрятана», а отказ на сервере.
	r := do(t, editor, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/integrations/google/start")
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("start редактором: статус %d, ожидалось 403", r.StatusCode)
	}
	closeBody(t, r)

	r = deleteWithCSRF(t, editor, srv, "/api/v1/workspaces/"+wsID+"/integrations/google")
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("отключение редактором: статус %d, ожидалось 403", r.StatusCode)
	}
	closeBody(t, r)
}

// Чужой не участник получает 404, а не 403: существование чужого пространства
// не раскрывается даже отказом (инвариант 5, анти-IDOR).
func TestIntegrations_StrangerGetsNotFound(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	stranger := registerUser(t, srv, "stranger@example.com")

	r := do(t, stranger, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/integrations")
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("статус = %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)
}

// Без сессии приватная ручка не отдаёт ничего.
func TestIntegrations_RequiresSession(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	r := do(t, newClient(t), http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/integrations")
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", r.StatusCode)
	}
	closeBody(t, r)
}

// Полный поход: start → колбэк → строка в БД → состояние «подключено» →
// отключение. Главная проверка внутри — токен в базе лежит ШИФРОТЕКСТОМ.
func TestIntegrations_ConnectFlow(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	state := startFlow(t, owner, srv, wsID)
	r := do(t, owner, http.MethodGet, srv.URL+"/api/v1/integrations/google/callback?code=auth-code&state="+state)
	assertOutcome(t, r, "integration_ok")

	var sealed []byte
	var email, provider string
	var connectedBy uuid.UUID
	err := testPool.QueryRow(context.Background(),
		`SELECT refresh_token, external_email, provider, connected_by FROM integration_accounts WHERE workspace_id = $1`,
		wsID).Scan(&sealed, &email, &provider, &connectedBy)
	if err != nil {
		t.Fatalf("подключение не записано: %v", err)
	}
	if strings.Contains(string(sealed), "rt") {
		t.Fatal("refresh-токен лежит в базе открытым текстом")
	}
	if email != "author@gmail.com" || provider != "google" {
		t.Errorf("строка = %q/%q", email, provider)
	}

	var got statusDTO
	decode(t, do(t, owner, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/integrations"), &got)
	if !got.Connected || got.Email != "author@gmail.com" || got.ConnectedAt == "" {
		t.Fatalf("состояние после подключения = %+v", got)
	}

	r = deleteWithCSRF(t, owner, srv, "/api/v1/workspaces/"+wsID+"/integrations/google")
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("отключение: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	var left int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM integration_accounts WHERE workspace_id = $1`, wsID).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatalf("после отключения осталось строк: %d", left)
	}

	// Повторное отключение идемпотентно — вторая вкладка не должна краснеть.
	r = deleteWithCSRF(t, owner, srv, "/api/v1/workspaces/"+wsID+"/integrations/google")
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("повторное отключение: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)
}

// Подсунутый чужой code с несовпадающим state не подключает ничего: это защита
// от CSRF, без неё атакующий подключает СВОЙ Google к чужому пространству.
func TestIntegrations_CallbackRejectsForeignState(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	startFlow(t, owner, srv, wsID)
	r := do(t, owner, http.MethodGet, srv.URL+"/api/v1/integrations/google/callback?code=auth-code&state=подделка")
	assertOutcome(t, r, "integration_expired")

	var count int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM integration_accounts`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Fatal("подключение записано при несошедшемся state")
	}
}

// Колбэк без похода (нет cookie намерения) ничего не подключает: пространство
// НЕ берётся из параметров запроса.
func TestIntegrations_CallbackWithoutIntent(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")

	r := do(t, owner, http.MethodGet, srv.URL+"/api/v1/integrations/google/callback?code=c&state=s")
	assertOutcome(t, r, "integration_expired")
}

// startFlow проходит первый шаг и отдаёт state, который сервер положил в cookie
// (он же уехал в ссылку провайдера).
func startFlow(t *testing.T, c *http.Client, srv *httptest.Server, wsID string) string {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/integrations/google/start")
	defer closeBody(t, r)
	if r.StatusCode != http.StatusFound {
		t.Fatalf("start: статус %d, ожидалось 302", r.StatusCode)
	}
	loc, err := url.Parse(r.Header.Get("Location"))
	if err != nil {
		t.Fatalf("Location не парсится: %v", err)
	}
	state := loc.Query().Get("state")
	if state == "" {
		t.Fatal("state не уехал к провайдеру")
	}
	return state
}

func assertOutcome(t *testing.T, r *http.Response, want string) {
	t.Helper()
	defer closeBody(t, r)
	if r.StatusCode != http.StatusFound {
		t.Fatalf("колбэк: статус %d, ожидалось 302", r.StatusCode)
	}
	loc := r.Header.Get("Location")
	if loc != appOrigin+"/oauth/done?r="+want {
		t.Fatalf("возврат на %q, ожидался исход %q", loc, want)
	}
}

// personalWorkspace — личное пространство единственного зарегистрированного
// владельца (его заводит транзакция регистрации).
func personalWorkspace(t *testing.T) string {
	t.Helper()
	var id string
	err := testPool.QueryRow(context.Background(),
		`SELECT id FROM workspaces WHERE personal_user_id IS NOT NULL ORDER BY created_at LIMIT 1`).Scan(&id)
	if err != nil {
		t.Fatalf("личное пространство не найдено: %v", err)
	}
	return id
}

// addMember сажает уже зарегистрированного человека в пространство ролью:
// проходить приглашение по почте ради проверки прав было бы тестом про
// приглашения, а не про интеграции.
func addMember(t *testing.T, wsID, email, role string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 SELECT $1, id, $3 FROM users WHERE email = $2`,
		wsID, email, role)
	if err != nil {
		t.Fatalf("добавление участника: %v", err)
	}
}

func registerUser(t *testing.T, srv *httptest.Server, email string) *http.Client {
	t.Helper()
	c := newClient(t)
	r := doBody(t, c, http.MethodPost, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"supersecret1"}`)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: статус %d, ожидалось 201", email, r.StatusCode)
	}
	closeBody(t, r)
	return c
}

func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	// Редиректы НЕ следуются: и start, и колбэк отвечают 302, и проверяется
	// именно Location — куда сервер отправил браузер и с каким исходом.
	return &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
}

func deleteWithCSRF(t *testing.T, c *http.Client, srv *httptest.Server, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, srv.URL+path, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv.URL))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", http.MethodDelete, path, err)
	}
	return resp
}

func csrf(t *testing.T, c *http.Client, base string) string {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	for _, ck := range c.Jar.Cookies(u) {
		if ck.Name == "csrf_token" {
			return ck.Value
		}
	}
	t.Fatal("csrf_token cookie не выдан")
	return ""
}

func do(t *testing.T, c *http.Client, method, u string) *http.Response {
	return doBody(t, c, method, u, "")
}

func doBody(t *testing.T, c *http.Client, method, u, jsonBody string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if jsonBody != "" {
		rdr = strings.NewReader(jsonBody)
	}
	req, err := http.NewRequest(method, u, rdr)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if jsonBody != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, u, err)
	}
	return resp
}

func decode(t *testing.T, r *http.Response, v any) {
	t.Helper()
	defer closeBody(t, r)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		t.Fatalf("decode тела: %v", err)
	}
}

func closeBody(t *testing.T, r *http.Response) {
	t.Helper()
	if err := r.Body.Close(); err != nil {
		t.Errorf("close body: %v", err)
	}
}
