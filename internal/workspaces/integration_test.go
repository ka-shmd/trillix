//go:build integration

// Интеграционный тест workspaces против настоящего Postgres в контейнере: реальная
// вертикаль auth+workspaces. Регистрация заводит личный воркспейс (транзакция
// auth), GET /workspaces возвращает его владельцу; чужой пользователь видит только
// свой (членство — инвариант доступа, а не все воркспейсы подряд).
package workspaces_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
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

func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`TRUNCATE users, workspaces, workspace_members, sessions CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack собирает реальную вертикаль auth+workspaces поверх контейнерного пула.
// Лимитер auth — пермиссивный (инвариант 6).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, time.Hour)
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	wsSvc := workspaces.NewService(testPool, workspaces.Repo{})
	wsH := workspaces.NewHandler(wsSvc, authH.RequireAuth)

	mux := http.NewServeMux()
	authH.Routes(mux)
	wsH.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type workspaceDTO struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type listDTO struct {
	Workspaces []workspaceDTO `json:"workspaces"`
}

// Владелец получает свой личный воркспейс (созданный при регистрации, имя Personal).
func TestWorkspaces_ListForUser(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200", r.StatusCode)
	}
	var got listDTO
	decode(t, r, &got)
	if len(got.Workspaces) != 1 {
		t.Fatalf("воркспейсов = %d, ожидался 1: %+v", len(got.Workspaces), got.Workspaces)
	}
	if got.Workspaces[0].Name != "Personal" || got.Workspaces[0].ID == "" {
		t.Fatalf("воркспейс = %+v, ожидался Personal с непустым id", got.Workspaces[0])
	}
}

// Каждый пользователь видит только свой воркспейс — не чужой (изоляция членства).
func TestWorkspaces_IsolatedPerUser(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	aliceWS := listWorkspaces(t, alice, srv)
	bobWS := listWorkspaces(t, bob, srv)
	if len(aliceWS) != 1 || len(bobWS) != 1 {
		t.Fatalf("у каждого должен быть один воркспейс: alice=%+v bob=%+v", aliceWS, bobWS)
	}
	if aliceWS[0].ID == bobWS[0].ID {
		t.Fatalf("воркспейсы разных пользователей совпали: %s", aliceWS[0].ID)
	}
}

// Без сессии — 401 (приватный эндпоинт не отдаёт ничего анониму).
func TestWorkspaces_RequiresSession(t *testing.T) {
	resetDB(t)
	srv := newStack(t)

	r := do(t, newClient(t), http.MethodGet, srv.URL+"/api/v1/workspaces")
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", r.StatusCode)
	}
	closeBody(t, r)
}

func listWorkspaces(t *testing.T, c *http.Client, srv *httptest.Server) []workspaceDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("список воркспейсов: статус %d, ожидалось 200", r.StatusCode)
	}
	var got listDTO
	decode(t, r, &got)
	return got.Workspaces
}

// --- Хелперы ---

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
	return &http.Client{Jar: jar}
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
		t.Fatalf("do request: %v", err)
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
