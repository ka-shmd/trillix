//go:build integration

// Интеграционный тест forms против настоящего Postgres в контейнере: реальная
// вертикаль auth+forms (регистрация → CRUD форм), с упором на изоляцию
// воркспейсов (анти-IDOR: пользователь A не видит и не трогает форму B → 404).
package forms_test

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
	"github.com/ka-shmd/trierra/internal/forms"
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

func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, form_versions CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack собирает реальную вертикаль auth+forms поверх контейнерного пула.
// Лимитер auth — пермиссивный (инвариант 6).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, time.Hour)
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, false)

	formsSvc := forms.NewService(testPool, forms.Repo{})
	formsH := forms.NewHandler(formsSvc, authH.RequireAuth, authH.RequireCSRF)

	mux := http.NewServeMux()
	authH.Routes(mux)
	formsH.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// registerUser регистрирует пользователя и возвращает клиент с его сессией.
func registerUser(t *testing.T, srv *httptest.Server, email string) *http.Client {
	t.Helper()
	c := newClient(t)
	r := do(t, c, http.MethodPost, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"supersecret1"}`, "")
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: статус %d, ожидалось 201", email, r.StatusCode)
	}
	closeBody(t, r)
	return c
}

func TestForms_CRUDFlow(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	// Создать форму без названия → дефолтный title, статус draft, slug выдан.
	created := createForm(t, c, srv, "")
	if created.Title != "Untitled form" {
		t.Fatalf("title = %q, ожидался дефолт", created.Title)
	}
	if created.Status != "draft" || created.Slug == "" {
		t.Fatalf("неожиданная форма: %+v", created)
	}

	// GET → отдаёт draft_schema (точка входа заглушки редактора).
	detail := getFormDetail(t, c, srv, created.ID, http.StatusOK)
	if string(detail.DraftSchema) != `{"blocks":[]}` {
		t.Fatalf("draftSchema = %s, ожидался пустой каркас", detail.DraftSchema)
	}

	// Переименование.
	renamed := patchTitle(t, c, srv, created.ID, "Опрос клиентов", http.StatusOK)
	if renamed.Title != "Опрос клиентов" {
		t.Fatalf("title после переименования = %q", renamed.Title)
	}

	// Список содержит форму.
	if list := listForms(t, c, srv, ""); len(list.Forms) != 1 || list.Forms[0].ID != created.ID {
		t.Fatalf("список = %+v, ожидалась одна форма %s", list.Forms, created.ID)
	}

	// Удаление → потом 404.
	deleteForm(t, c, srv, created.ID, http.StatusNoContent)
	getFormDetail(t, c, srv, created.ID, http.StatusNotFound)
}

// Главный тест фазы: изоляция воркспейсов. Пользователь B не имеет доступа к
// форме A — ни чтения, ни правки, ни удаления; всё → 404 (не 403).
func TestForms_WorkspaceIsolation(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	form := createForm(t, alice, srv, "Секрет Алисы")

	// B читает форму A → 404.
	getFormDetail(t, bob, srv, form.ID, http.StatusNotFound)
	// B переименовывает форму A → 404 (и не меняет её).
	patchTitle(t, bob, srv, form.ID, "взломано", http.StatusNotFound)
	// B удаляет форму A → 404.
	deleteForm(t, bob, srv, form.ID, http.StatusNotFound)

	// Список B пуст — чужая форма туда не попадает.
	if list := listForms(t, bob, srv, ""); len(list.Forms) != 0 {
		t.Fatalf("список B = %+v, ожидался пустой", list.Forms)
	}
	// А форма A цела и с исходным названием.
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.Title != "Секрет Алисы" {
		t.Fatalf("форму A изменили: title = %q", d.Title)
	}
}

// Пагинация: 5 форм, страницы по 2 — курсор без дублей и потерь.
func TestForms_CursorPagination(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "many@example.com")

	const total = 5
	ids := make(map[string]bool, total)
	for i := 0; i < total; i++ {
		f := createForm(t, c, srv, "форма")
		ids[f.ID] = true
	}

	seen := make(map[string]bool, total)
	cursor := ""
	pages := 0
	for {
		page := listForms(t, c, srv, "?limit=2"+cursorParam(cursor))
		pages++
		for _, f := range page.Forms {
			if seen[f.ID] {
				t.Fatalf("дубль формы %s между страницами", f.ID)
			}
			seen[f.ID] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
		if pages > total+2 {
			t.Fatal("пагинация не сходится (курсор не двигается)")
		}
	}
	if len(seen) != total {
		t.Fatalf("увидено %d форм из %d", len(seen), total)
	}
}

// --- DTO и HTTP-хелперы ---

type formDTO struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Slug      string `json:"slug"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type formDetailDTO struct {
	formDTO
	DraftSchema json.RawMessage `json:"draftSchema"`
}

type listDTO struct {
	Forms      []formDTO `json:"forms"`
	NextCursor *string   `json:"nextCursor"`
}

func createForm(t *testing.T, c *http.Client, srv *httptest.Server, title string) formDTO {
	t.Helper()
	body := ""
	if title != "" {
		body = `{"title":"` + title + `"}`
	}
	r := do(t, c, http.MethodPost, srv.URL+"/api/v1/forms", body, csrf(t, c, srv.URL))
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создание формы: статус %d, ожидалось 201; тело=%s", r.StatusCode, body2(t, r))
	}
	var f formDTO
	decode(t, r, &f)
	return f
}

func getFormDetail(t *testing.T, c *http.Client, srv *httptest.Server, id string, wantStatus int) formDetailDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+id, "", "")
	if r.StatusCode != wantStatus {
		t.Fatalf("GET форма: статус %d, ожидалось %d", r.StatusCode, wantStatus)
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDetailDTO{}
	}
	var d formDetailDTO
	decode(t, r, &d)
	return d
}

func patchTitle(t *testing.T, c *http.Client, srv *httptest.Server, id, title string, wantStatus int) formDTO {
	t.Helper()
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, `{"title":"`+title+`"}`, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH форма: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDTO{}
	}
	var f formDTO
	decode(t, r, &f)
	return f
}

func deleteForm(t *testing.T, c *http.Client, srv *httptest.Server, id string, wantStatus int) {
	t.Helper()
	r := do(t, c, http.MethodDelete, srv.URL+"/api/v1/forms/"+id, "", csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("DELETE форма: статус %d, ожидалось %d", r.StatusCode, wantStatus)
	}
	closeBody(t, r)
}

func listForms(t *testing.T, c *http.Client, srv *httptest.Server, query string) listDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms"+query, "", "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("список форм: статус %d, ожидалось 200; тело=%s", r.StatusCode, body2(t, r))
	}
	var l listDTO
	decode(t, r, &l)
	return l
}

func cursorParam(cursor string) string {
	if cursor == "" {
		return ""
	}
	return "&cursor=" + url.QueryEscape(cursor)
}

// --- низкоуровневые хелперы ---

func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	return &http.Client{Jar: jar}
}

func do(t *testing.T, c *http.Client, method, u, jsonBody, csrfTok string) *http.Response {
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
	if csrfTok != "" {
		req.Header.Set("X-CSRF-Token", csrfTok)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
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

func decode(t *testing.T, r *http.Response, v any) {
	t.Helper()
	defer closeBody(t, r)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func closeBody(t *testing.T, r *http.Response) {
	t.Helper()
	if err := r.Body.Close(); err != nil {
		t.Errorf("close body: %v", err)
	}
}

func body2(t *testing.T, r *http.Response) string {
	t.Helper()
	defer closeBody(t, r)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return "read body: " + err.Error()
	}
	return string(b)
}
