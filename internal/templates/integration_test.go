//go:build integration

// Интеграционный тест шаблонов против настоящего Postgres в контейнере: реальная
// вертикаль auth+workspaces+forms+templates. Проверяются те свойства, которые
// живут не в Go, а в схеме и в связке модулей: изоляция приватного шаблона
// пространством, гейт администратора на витрине, свежие id у формы из шаблона.
package templates_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/templates"
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
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, form_versions, form_templates CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack собирает реальную вертикаль поверх контейнерного пула. Лимитер auth —
// пермиссивный (инвариант 6).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	plans := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, plans, "http://localhost:5173")
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{}, wsSvc, plans)
	formsH := forms.NewHandler(formsSvc, authH.RequireAuth, authH.RequireCSRF)
	wsH := workspaces.NewHandler(wsSvc, authH.RequireAuth, authH.RequireCSRF)

	tplSvc := templates.NewService(testPool, templates.Repo{}, wsSvc, formsSvc, authSvc)
	tplH := templates.NewHandler(tplSvc, authH.RequireAuth, authH.RequireCSRF)

	mux := http.NewServeMux()
	authH.Routes(mux)
	formsH.Routes(mux)
	wsH.Routes(mux)
	tplH.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type templateDTO struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
	Visibility  string          `json:"visibility"`
	WorkspaceID *string         `json:"workspaceId"`
}

type listDTO struct {
	Items []templateDTO `json:"items"`
}

type formDTO struct {
	ID   string `json:"id"`
	Slug string `json:"slug"`
}

// schemaWith — документ с одним вопросом и подстановкой на него: минимальный
// набор, в котором видно, переадресуются ли ссылки при копировании.
func schemaWith(blockID string) string {
	return fmt.Sprintf(`{"schemaVersion":1,"blocks":[
		{"id":%[1]q,"groupId":"g_%[1]s","type":"short_text","settings":{}},
		{"id":"blk_note","groupId":"g_note","type":"text","text":[{"t":"Имя","ref":%[1]q}],"settings":{}}
	]}`, blockID)
}

// Свой шаблон виден в своём пространстве и не виден в чужом — граница доступа
// проходит по членству, а не по знанию id (анти-IDOR).
func TestTemplates_PrivateStaysInWorkspace(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	aliceWS := personalWorkspace(t, alice, srv)
	form := createForm(t, alice, srv, aliceWS, schemaWith("blk_src"))
	tpl := saveAsTemplate(t, alice, srv, form.ID, "Анкета", "Про что-то")
	if tpl.Visibility != "private" {
		t.Fatalf("видимость = %q, ожидалась private", tpl.Visibility)
	}

	own := listTemplates(t, alice, srv, aliceWS)
	if len(own.Items) != 1 || own.Items[0].ID != tpl.ID {
		t.Fatalf("своего шаблона нет в галерее пространства: %+v", own.Items)
	}

	// Боб знает id чужого пространства — и это не даёт ему ничего.
	r := do(t, bob, http.MethodGet, srv.URL+"/api/v1/templates?workspaceId="+aliceWS)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("чужая галерея: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)

	// Своя галерея у Боба пуста: чужой приватный шаблон в неё не протекает.
	bobList := listTemplates(t, bob, srv, personalWorkspace(t, bob, srv))
	if len(bobList.Items) != 0 {
		t.Fatalf("в чужой галерее %d шаблонов, ожидалось 0: %+v", len(bobList.Items), bobList.Items)
	}

	// Использовать чужой приватный шаблон нельзя даже по прямой ссылке.
	r = post(t, bob, srv, "/api/v1/templates/"+tpl.ID+"/use", `{}`)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("использование чужого шаблона: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)
}

// Форма из шаблона несёт те же вопросы, но НЕ те же id — иначе ответы, воронка и
// логика двух форм ссылались бы на одни и те же строки.
func TestTemplates_UseGivesFreshIDs(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	ws := personalWorkspace(t, alice, srv)

	form := createForm(t, alice, srv, ws, schemaWith("blk_src"))
	tpl := saveAsTemplate(t, alice, srv, form.ID, "Анкета", "")

	first := useTemplate(t, alice, srv, tpl.ID, ws)
	second := useTemplate(t, alice, srv, tpl.ID, ws)
	if first.ID == second.ID {
		t.Fatal("две формы из одного шаблона получили один id")
	}

	firstDoc := draftSchema(t, alice, srv, first.ID)
	secondDoc := draftSchema(t, alice, srv, second.ID)
	if strings.Contains(string(firstDoc), `"blk_src"`) {
		t.Errorf("форма из шаблона сохранила id шаблона: %s", firstDoc)
	}
	if firstDoc == secondDoc {
		t.Errorf("две формы из одного шаблона несут одинаковый документ: %s", firstDoc)
	}
	// Подстановка обязана указывать на блок ЭТОЙ формы: переадресуй id, но не
	// ссылки — и автор получил бы форму с молча неработающей подстановкой.
	//
	// Блоки ищутся по типу, а не по номеру: кабинет отдаёт черновик с дописанным
	// заголовком (EnsureFormTitle синтезирует его на чтении), поэтому позиции
	// сдвинуты относительно сохранённого документа.
	var doc struct {
		Blocks []struct {
			ID   string `json:"id"`
			Type string `json:"type"`
			Text []struct {
				Ref string `json:"ref"`
			} `json:"text"`
		} `json:"blocks"`
	}
	if err := json.Unmarshal([]byte(firstDoc), &doc); err != nil {
		t.Fatalf("разбор документа: %v", err)
	}
	question, note := "", ""
	for _, b := range doc.Blocks {
		switch b.Type {
		case "short_text":
			question = b.ID
		case "text":
			if len(b.Text) == 1 {
				note = b.Text[0].Ref
			}
		}
	}
	if question == "" || note == "" {
		t.Fatalf("документ поехал: %s", firstDoc)
	}
	if note != question {
		t.Errorf("подстановка ссылается на %q, ожидался %q", note, question)
	}
}

// Свой шаблон удаляется; созданная из него форма живёт своей жизнью.
func TestTemplates_DeleteOwn(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	ws := personalWorkspace(t, alice, srv)

	form := createForm(t, alice, srv, ws, schemaWith("blk_src"))
	tpl := saveAsTemplate(t, alice, srv, form.ID, "Анкета", "")
	made := useTemplate(t, alice, srv, tpl.ID, ws)

	r := del(t, alice, srv, "/api/v1/templates/"+tpl.ID)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("удаление: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	if left := listTemplates(t, alice, srv, ws); len(left.Items) != 0 {
		t.Fatalf("после удаления в галерее %d шаблонов", len(left.Items))
	}
	if draftSchema(t, alice, srv, made.ID) == "" {
		t.Error("форма, созданная из шаблона, не пережила его удаления")
	}
}

// Витрину пополняет только администратор сервиса, и обычному пользователю этой
// ручки не существует (404, а не 403 — приватное не раскрывается).
func TestTemplates_PublishRequiresAdmin(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	body := `{"title":"Обратная связь","description":"Заготовка","schema":` + schemaWith("blk_src") + `}`
	r := post(t, alice, srv, "/api/v1/admin/templates", body)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("публикация обычным пользователем: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)

	makeAdmin(t, "alice@example.com")
	r = post(t, alice, srv, "/api/v1/admin/templates", body)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("публикация администратором: статус %d, ожидалось 201", r.StatusCode)
	}
	var tpl templateDTO
	decode(t, r, &tpl)
	if tpl.Visibility != "public" || tpl.WorkspaceID != nil {
		t.Fatalf("шаблон витрины = %+v, ожидался public без пространства", tpl)
	}

	// Публичный виден всем и в любом пространстве — в том числе тому, кто про
	// пространство автора ничего не знает.
	got := listTemplates(t, bob, srv, personalWorkspace(t, bob, srv))
	if len(got.Items) != 1 || got.Items[0].ID != tpl.ID {
		t.Fatalf("витрина не видна чужому пользователю: %+v", got.Items)
	}
	// И пользоваться им может тоже всякий.
	if made := useTemplate(t, bob, srv, tpl.ID, personalWorkspace(t, bob, srv)); made.Slug == "" {
		t.Error("форма из публичного шаблона не создалась")
	}

	// Удалить витрину из кабинета нельзя никому: она правится там же, где
	// наполняется.
	r = del(t, bob, srv, "/api/v1/templates/"+tpl.ID)
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("удаление публичного: статус %d, ожидалось 403", r.StatusCode)
	}
	closeBody(t, r)
}

// Шесть заготовок продукта лежат в репозитории файлами и попадают на витрину
// ЕДИНСТВЕННЫМ путём — этой ручкой (её зовёт scripts/seed-templates.sh вашими
// данными: ручка сидит за сессией). Здесь проверяется всё, кроме входа: файлы
// разбираются, документы проходят валидацию, витрина наполняется и каждой
// заготовкой можно воспользоваться.
//
// Без этого теста негодный файл узнаётся как 422 посреди ручного прогона заливки —
// на чужой машине и, как правило, на проде.
func TestTemplates_SeedFilesPublish(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	admin := registerUser(t, srv, "admin@example.com")
	makeAdmin(t, "admin@example.com")

	files, err := filepath.Glob(filepath.Join("..", "..", "scripts", "templates", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) == 0 {
		t.Fatal("заготовок витрины нет вовсе — скрипту заливки нечего слать")
	}
	for _, path := range files {
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		assertGroupsAnchored(t, filepath.Base(path), body)
		r := post(t, admin, srv, "/api/v1/admin/templates", string(body))
		if r.StatusCode != http.StatusCreated {
			msg, _ := io.ReadAll(r.Body)
			t.Fatalf("заливка %s: статус %d, ожидалось 201 (%s)", filepath.Base(path), r.StatusCode, msg)
		}
		closeBody(t, r)
	}

	ws := personalWorkspace(t, admin, srv)
	got := listTemplates(t, admin, srv, ws)
	if len(got.Items) != len(files) {
		t.Fatalf("на витрине %d шаблонов, залито %d", len(got.Items), len(files))
	}
	for _, item := range got.Items {
		if made := useTemplate(t, admin, srv, item.ID, ws); made.Slug == "" {
			t.Errorf("форма из заготовки %q не создалась", item.Title)
		}
	}
}

// assertGroupsAnchored — groupId заготовки обязан быть выведен ИЗ ЯКОРЯ: `g_<id
// блока этого документа>`. Ровно это условие включает якорную ветку
// domain.NewSchemaIDs; своё имя вида `grp_1` уводит её в фолбэк, и каждая форма из
// заготовки получала бы группы, не связанные ни с одним блоком, — а первое открытие
// в редакторе (regroup, web/app/src/features/forms/builder/store.ts) переписывало бы
// их все.
//
// Проверяется связь, а не выбор якоря: КАКОЙ блок группы якорь, знает regroup, и его
// правило живёт в TS.
func assertGroupsAnchored(t *testing.T, name string, body []byte) {
	t.Helper()
	var doc struct {
		Schema struct {
			Blocks []struct {
				ID      string `json:"id"`
				GroupID string `json:"groupId"`
			} `json:"blocks"`
		} `json:"schema"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatalf("%s: разбор документа: %v", name, err)
	}
	ids := make(map[string]bool, len(doc.Schema.Blocks))
	for _, b := range doc.Schema.Blocks {
		ids[b.ID] = true
	}
	for _, b := range doc.Schema.Blocks {
		anchor, ok := strings.CutPrefix(b.GroupID, "g_")
		if !ok || !ids[anchor] {
			t.Errorf("%s: блок %s в группе %q — она не выведена из якоря документа", name, b.ID, b.GroupID)
		}
	}
}

// --- Хелперы ---

func makeAdmin(t *testing.T, email string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET is_admin = true WHERE email = $1`, email); err != nil {
		t.Fatalf("выдача прав администратора: %v", err)
	}
}

func personalWorkspace(t *testing.T, c *http.Client, srv *httptest.Server) string {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("список пространств: статус %d", r.StatusCode)
	}
	var got struct {
		Workspaces []struct {
			ID string `json:"id"`
		} `json:"workspaces"`
	}
	decode(t, r, &got)
	if len(got.Workspaces) == 0 {
		t.Fatal("у пользователя нет ни одного пространства")
	}
	return got.Workspaces[0].ID
}

// createForm заводит форму и кладёт в неё документ тем же путём, каким это
// делает автосейв полотна.
func createForm(t *testing.T, c *http.Client, srv *httptest.Server, workspaceID, schema string) formDTO {
	t.Helper()
	r := post(t, c, srv, "/api/v1/forms", `{"title":"Форма","workspaceId":"`+workspaceID+`"}`)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создание формы: статус %d", r.StatusCode)
	}
	var form struct {
		formDTO
		UpdatedAt time.Time `json:"updatedAt"`
	}
	decode(t, r, &form)

	stamp, err := json.Marshal(form.UpdatedAt)
	if err != nil {
		t.Fatalf("marshal updatedAt: %v", err)
	}
	r = patch(t, c, srv, "/api/v1/forms/"+form.ID,
		`{"draftSchema":`+schema+`,"updatedAt":`+string(stamp)+`}`)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("сохранение документа: статус %d", r.StatusCode)
	}
	closeBody(t, r)
	return form.formDTO
}

func draftSchema(t *testing.T, c *http.Client, srv *httptest.Server, formID string) string {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+formID)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("чтение формы: статус %d", r.StatusCode)
	}
	var got struct {
		DraftSchema json.RawMessage `json:"draftSchema"`
	}
	decode(t, r, &got)
	return string(got.DraftSchema)
}

func saveAsTemplate(t *testing.T, c *http.Client, srv *httptest.Server, formID, title, description string) templateDTO {
	t.Helper()
	body := fmt.Sprintf(`{"formId":%q,"title":%q,"description":%q}`, formID, title, description)
	r := post(t, c, srv, "/api/v1/templates", body)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("сохранение шаблона: статус %d", r.StatusCode)
	}
	var tpl templateDTO
	decode(t, r, &tpl)
	return tpl
}

func useTemplate(t *testing.T, c *http.Client, srv *httptest.Server, templateID, workspaceID string) formDTO {
	t.Helper()
	r := post(t, c, srv, "/api/v1/templates/"+templateID+"/use", `{"workspaceId":"`+workspaceID+`"}`)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создание формы из шаблона: статус %d", r.StatusCode)
	}
	var form formDTO
	decode(t, r, &form)
	return form
}

func listTemplates(t *testing.T, c *http.Client, srv *httptest.Server, workspaceID string) listDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/templates?workspaceId="+workspaceID)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("галерея: статус %d, ожидалось 200", r.StatusCode)
	}
	var got listDTO
	decode(t, r, &got)
	return got
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
	return &http.Client{Jar: jar}
}

func do(t *testing.T, c *http.Client, method, u string) *http.Response {
	return doBody(t, c, method, u, "")
}

func post(t *testing.T, c *http.Client, srv *httptest.Server, path, jsonBody string) *http.Response {
	return withCSRF(t, c, srv, http.MethodPost, path, jsonBody)
}

func patch(t *testing.T, c *http.Client, srv *httptest.Server, path, jsonBody string) *http.Response {
	return withCSRF(t, c, srv, http.MethodPatch, path, jsonBody)
}

func del(t *testing.T, c *http.Client, srv *httptest.Server, path string) *http.Response {
	return withCSRF(t, c, srv, http.MethodDelete, path, "")
}

// withCSRF — запись за RequireCSRF: заголовок берётся из выданной cookie.
func withCSRF(t *testing.T, c *http.Client, srv *httptest.Server, method, path, jsonBody string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if jsonBody != "" {
		rdr = strings.NewReader(jsonBody)
	}
	req, err := http.NewRequest(method, srv.URL+path, rdr)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if jsonBody != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv.URL))
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
