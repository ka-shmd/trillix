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
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

var testPool *pgxpool.Pool

// testOutbox — диспетчер очереди последней собранной вертикали: тест доставки
// гоняет его руками, как это делает periodic-задача в проде.
var testOutbox *mail.Service

// testIntegrations — сервис последней собранной вертикали: постановку события
// делает он же, что и в проде (submissions зовёт его после коммита).
var testIntegrations *integrations.Service

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
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, integration_accounts, outbox CASCADE`)
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

	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{}, wsSvc, plans)

	svc := integrations.NewService(testPool, postgres.TxRunner{Pool: testPool}, integrations.Repo{},
		wsSvc, formsSvc, provider, testKey)
	h := integrations.NewHandler(svc, authH.RequireAuth, authH.RequireCSRF, appOrigin, false, testKey)

	// Доставка: настоящий outbox (mail) как очередь, настоящий submissions как
	// источник строки. Провайдер подставной — живой поход в Google означал бы
	// тест, зелёный только при интернете.
	outbox := pgtest.MailService(testPool)
	subsSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, nil,
		outbox, plans, submissions.Repo{}, appOrigin)
	svc = svc.WithDelivery(outbox, subsSvc)
	outbox.WithTransport(integrations.ChannelSheets, svc)
	testOutbox, testIntegrations = outbox, svc

	mux := http.NewServeMux()
	authH.Routes(mux)
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type accountDTO struct {
	Enabled        bool   `json:"enabled"`
	Connected      bool   `json:"connected"`
	NeedsReconnect bool   `json:"needsReconnect"`
	Email          string `json:"email"`
	ConnectedAt    string `json:"connectedAt"`
	CanManage      bool   `json:"canManage"`
}

type sheetDTO struct {
	ID      string `json:"id"`
	URL     string `json:"url"`
	Enabled bool   `json:"enabled"`
	Name    string `json:"name"`
	Status  string `json:"status"`
}

type formStatusDTO struct {
	WorkspaceID string     `json:"workspaceId"`
	Account     accountDTO `json:"account"`
	Connections []sheetDTO `json:"connections"`
}

// formStatus читает состояние интеграций формы — то, что рисует таб.
func formStatus(t *testing.T, c *http.Client, srv *httptest.Server, formID string) formStatusDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/integrations")
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("состояние формы: статус %d, ожидалось 200", r.StatusCode)
	}
	var got formStatusDTO
	decode(t, r, &got)
	return got
}

// Токен, запечатанный ЧУЖИМ ключом (так выглядит строка, пережившая ротацию
// FORM_TOKEN_SECRET): подключение есть, а работать им нельзя. Экран обязан
// сказать «заново», а не рисовать зелёное «подключено».
func TestIntegrations_TokenFromAnotherKeyAsksToReconnect(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	seedAccountWithForeignToken(t, wsID)

	got := formStatus(t, owner, srv, newForm(t, wsID, "f-stale"))

	if !got.Account.Connected {
		t.Error("строка подключения есть — connected обязан остаться true")
	}
	if !got.Account.NeedsReconnect {
		t.Fatalf("аккаунт = %+v, ожидалось требование переподключиться", got.Account)
	}
}

// seedAccountWithForeignToken кладёт подключение с шифротекстом, который ключом
// контура не открывается. Пройти для этого настоящий OAuth нельзя — он запечатал
// бы токен правильным ключом.
func seedAccountWithForeignToken(t *testing.T, wsID string) {
	t.Helper()
	var userID string
	err := testPool.QueryRow(context.Background(),
		`SELECT personal_user_id FROM workspaces WHERE id = $1`, wsID).Scan(&userID)
	if err != nil {
		t.Fatalf("владелец пространства: %v", err)
	}
	_, err = testPool.Exec(context.Background(),
		`INSERT INTO integration_accounts
		 (id, workspace_id, provider, external_account_id, external_email, refresh_token, scopes, connected_by)
		 VALUES ($1, $2, 'google', 'sub-1', 'author@gmail.com', $3, '', $4)`,
		uuid.New(), wsID, []byte("шифротекст от прошлого секрета"), userID)
	if err != nil {
		t.Fatalf("insert integration account: %v", err)
	}
}

// newForm заводит форму в пространстве напрямую: проходить билдер ради проверки
// интеграций значило бы тестировать не то.
func newForm(t *testing.T, wsID, slug string) string {
	t.Helper()
	id := uuid.New().String()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO forms (id, workspace_id, slug, title) VALUES ($1, $2, $3, 'Опрос')`,
		id, wsID, slug)
	if err != nil {
		t.Fatalf("insert form: %v", err)
	}
	return id
}

// Владелец видит настроенный, но не подключённый провайдер — и кнопку.
func TestIntegrations_OwnerSeesManageable(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	got := formStatus(t, owner, srv, newForm(t, wsID, "f-owner"))

	if !got.Account.Enabled || got.Account.Connected || !got.Account.CanManage {
		t.Fatalf("аккаунт = %+v, ожидалось «настроено, не подключено, управляемо»", got.Account)
	}
	if len(got.Connections) != 0 {
		t.Fatalf("связки = %+v, ожидался пустой список", got.Connections)
	}
	if got.WorkspaceID != wsID {
		t.Fatalf("пространство формы = %q, ожидалось %q", got.WorkspaceID, wsID)
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

	got := formStatus(t, editor, srv, newForm(t, wsID, "f-editor"))
	if !got.Account.Enabled || got.Account.CanManage {
		t.Fatalf("аккаунт глазами редактора = %+v, ожидалось «видит, но не управляет»", got.Account)
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

	r := do(t, stranger, http.MethodGet, srv.URL+"/api/v1/forms/"+newForm(t, wsID, "f-stranger")+"/integrations")
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

	r := do(t, newClient(t), http.MethodGet, srv.URL+"/api/v1/forms/"+newForm(t, wsID, "f-anon")+"/integrations")
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

	got := formStatus(t, owner, srv, newForm(t, wsID, "f-connected")).Account
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

// Привязка формы: таблица создаётся, строка ложится в БД, состояние формы
// показывает ссылку. Редактор это МОЖЕТ — право на привязку идёт под правкой
// форм, а не под управлением аккаунтом.
func TestIntegrations_LinkFormToSheet(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)

	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")
	formID := newForm(t, wsID, "f-link")

	r := postWithCSRF(t, editor, srv, "/api/v1/forms/"+formID+"/integrations/google")
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка редактором: статус %d, ожидалось 201", r.StatusCode)
	}
	var sheet sheetDTO
	decode(t, r, &sheet)
	// Сразу после привязки идёт перенос накопленных ответов (у этой формы их
	// нет — перенос закроется первой же пустой пачкой).
	if sheet.URL == "" || sheet.Status != "backfilling" {
		t.Fatalf("привязка = %+v", sheet)
	}

	got := formStatus(t, owner, srv, formID)
	if len(got.Connections) != 1 || got.Connections[0].URL != sheet.URL {
		t.Fatalf("состояние формы = %+v, ожидалась одна связка", got.Connections)
	}

	// Вторая связка законна — в том числе в ту же книгу: интеграция это правило
	// доставки, а не состояние формы.
	r = postWithCSRF(t, editor, srv, "/api/v1/forms/"+formID+"/integrations/google")
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("вторая связка: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)
	if got := formStatus(t, owner, srv, formID); len(got.Connections) != 2 {
		t.Fatalf("связок = %d, ожидалось две", len(got.Connections))
	}

	r = deleteWithCSRF(t, editor, srv, "/api/v1/forms/"+formID+"/integrations/"+sheet.ID)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("отвязка: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	// Удалили одну — вторая осталась: связки живут своей жизнью.
	if got := formStatus(t, owner, srv, formID); len(got.Connections) != 1 {
		t.Fatalf("после удаления одной связок = %d, ожидалась одна", len(got.Connections))
	}
}

// Без подключённого аккаунта таблицу просить рано — 422 с человеческим текстом.
func TestIntegrations_LinkWithoutAccount(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	r := postWithCSRF(t, owner, srv, "/api/v1/forms/"+newForm(t, wsID, "f-noacc")+"/integrations/google")
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)
}

// Отключение аккаунта уносит привязки форм каскадом — иначе форма осталась бы
// «привязанной» к таблице, писать в которую больше нечем.
func TestIntegrations_DisconnectCascadesToForms(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)
	formID := newForm(t, wsID, "f-cascade")

	r := postWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google")
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)

	r = deleteWithCSRF(t, owner, srv, "/api/v1/workspaces/"+wsID+"/integrations/google")
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("отключение аккаунта: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	var left int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM form_integrations WHERE form_id = $1`, formID).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatalf("привязок формы осталось %d — каскад не сработал", left)
	}
}

// connectAccount проходит поход за согласием целиком: старт, колбэк, проверка
// исхода. Дальше тесты работают с подключённым пространством.
func connectAccount(t *testing.T, c *http.Client, srv *httptest.Server, wsID string) {
	t.Helper()
	state := startFlow(t, c, srv, wsID)
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/integrations/google/callback?code=auth-code&state="+state)
	assertOutcome(t, r, "integration_ok")
}

func postWithCSRF(t *testing.T, c *http.Client, srv *httptest.Server, path string) *http.Response {
	return postBodyWithCSRF(t, c, srv, path, "")
}

func postBodyWithCSRF(t *testing.T, c *http.Client, srv *httptest.Server, path, body string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(http.MethodPost, srv.URL+path, rdr)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv.URL))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", http.MethodPost, path, err)
	}
	return resp
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

// Полный путь доставки против настоящей БД: ответ ставится в очередь, диспетчер
// (тот же, что шлёт письма) отдаёт его транспорту таблиц, строка уезжает в лист,
// строка очереди помечается отправленной.
func TestIntegrations_DeliverSubmission(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)

	formID := newForm(t, wsID, "f-deliver")
	versionID := publishVersion(t, formID)
	r := postWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google")
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)

	subID := newSubmission(t, formID, versionID, `{"b1":"Ирина"}`)
	enqueueDelivery(t, srv, formID, subID)

	// В очереди рядом лежит письмо-подтверждение регистрации: диспетчер один на
	// все каналы, и это ровно то, что проверяется, — таблицы и почта едут вместе.
	if _, err := testOutbox.Dispatch(context.Background()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(provider.appended) != 1 {
		t.Fatalf("в лист дописано %d строк", len(provider.appended))
	}
	// Порядок колонок листа: id ответа, время, версия, затем вопрос.
	if got := provider.appended[0]; len(got) != 4 || got[0] != subID || got[3] != "Ирина" {
		t.Fatalf("строка = %v", got)
	}

	var pending int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbox WHERE sent_at IS NULL AND channel = $1`,
		integrations.ChannelSheets).Scan(&pending); err != nil {
		t.Fatalf("count: %v", err)
	}
	if pending != 0 {
		t.Fatalf("в очереди осталось %d недоставленных строк", pending)
	}
}

// Ответ формы, которая ни к чему не привязана, событий не порождает: приём не
// платит за интеграцию, которой у формы нет.
func TestIntegrations_NoEventForUnlinkedForm(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	formID := newForm(t, wsID, "f-nolink")
	versionID := publishVersion(t, formID)

	enqueueDelivery(t, srv, formID, newSubmission(t, formID, versionID, `{}`))

	var queued int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbox WHERE channel = $1`, integrations.ChannelSheets).Scan(&queued); err != nil {
		t.Fatalf("count: %v", err)
	}
	if queued != 0 {
		t.Fatalf("в очереди %d строк для непривязанной формы", queued)
	}
}

// enqueueDelivery ставит событие доставки так же, как это делает приём ответа
// после коммита. Через HTTP это шло бы публичной ручкой с антиспам-токеном —
// тест про доставку, а не про приём.
func enqueueDelivery(t *testing.T, _ *httptest.Server, formID, subID string) {
	t.Helper()
	if err := testIntegrations.EnqueueSubmission(context.Background(),
		uuid.MustParse(formID), uuid.MustParse(subID)); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
}

// publishVersion добавляет форме опубликованную версию с одним вопросом: без
// версии у ответа нет схемы, а у таблицы — колонок.
func publishVersion(t *testing.T, formID string) string {
	t.Helper()
	id := uuid.New().String()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO form_versions (id, form_id, version, schema) VALUES ($1, $2, 1, $3::jsonb)`,
		id, formID, `{"schemaVersion":1,"blocks":[
			{"id":"t1","groupId":"g1","type":"title","text":[{"t":"Имя"}],"settings":{}},
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}}]}`)
	if err != nil {
		t.Fatalf("insert form version: %v", err)
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE forms SET published_version_id = $1, status = 'published' WHERE id = $2`, id, formID); err != nil {
		t.Fatalf("publish form: %v", err)
	}
	return id
}

func newSubmission(t *testing.T, formID, versionID, answers string) string {
	t.Helper()
	// UUIDv7, как в проде (domain.NewID): порядок переноса — по id, и случайный
	// uuid.New() перемешал бы хронологию, которую тест как раз и проверяет.
	id := domain.NewID().String()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO submissions (id, form_id, form_version_id, answers) VALUES ($1, $2, $3, $4::jsonb)`,
		id, formID, versionID, answers)
	if err != nil {
		t.Fatalf("insert submission: %v", err)
	}
	return id
}

// Подключение формы, у которой уже есть ответы: они переносятся в лист сами,
// в хронологическом порядке, и только потом доставка становится живой.
func TestIntegrations_BackfillOnConnect(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)

	formID := newForm(t, wsID, "f-backfill")
	versionID := publishVersion(t, formID)
	first := newSubmission(t, formID, versionID, `{"b1":"Первый"}`)
	second := newSubmission(t, formID, versionID, `{"b1":"Второй"}`)

	r := postWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google")
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	var sheet sheetDTO
	decode(t, r, &sheet)
	if sheet.Status != "backfilling" {
		t.Fatalf("статус сразу после привязки = %q, ожидался перенос", sheet.Status)
	}

	if _, err := testOutbox.Dispatch(context.Background()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(provider.appended) != 2 {
		t.Fatalf("перенесено строк: %d, ожидалось 2", len(provider.appended))
	}
	// Старые сверху: в лист строки ложатся дописыванием, и обратный порядок дал
	// бы автору перевёрнутую хронологию.
	if provider.appended[0][0] != first || provider.appended[1][0] != second {
		t.Fatalf("порядок строк = %v", [][]string{provider.appended[0], provider.appended[1]})
	}

	if got := formStatus(t, owner, srv, formID); len(got.Connections) != 1 || got.Connections[0].Status != "live" {
		t.Fatalf("после переноса состояние = %+v, ожидался live", got.Connections)
	}

	// Дальше работает живая доставка — тем же листом и теми же колонками.
	third := newSubmission(t, formID, versionID, `{"b1":"Третий"}`)
	enqueueDelivery(t, srv, formID, third)
	if _, err := testOutbox.Dispatch(context.Background()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(provider.appended) != 3 || provider.appended[2][0] != third {
		t.Fatalf("живая доставка после переноса = %v", provider.appended)
	}
}

// «Перезалить всё» чистит лист и переносит ответы заново — это лечение дублей и
// ручных правок, поэтому оно доступно и редактору (право — правка форм).
func TestIntegrations_Refill(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)

	formID := newForm(t, wsID, "f-refill")
	versionID := publishVersion(t, formID)
	newSubmission(t, formID, versionID, `{"b1":"Ирина"}`)

	r := postWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google")
	var sheet sheetDTO
	decode(t, r, &sheet)
	if _, err := testOutbox.Dispatch(context.Background()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	before := len(provider.appended)

	r = postWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/"+sheet.ID+"/refill")
	if r.StatusCode != http.StatusAccepted {
		t.Fatalf("перезалив: статус %d, ожидалось 202", r.StatusCode)
	}
	closeBody(t, r)
	if provider.cleared == "" {
		t.Error("лист не вычищен")
	}

	if _, err := testOutbox.Dispatch(context.Background()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(provider.appended) != before+1 {
		t.Fatalf("после перезалива строк дописано %d, ожидалась одна", len(provider.appended)-before)
	}
}

// Настройки из окна подключения доезжают до базы: подпись связки сохранена, а
// выключенный тумблер переноса означает сразу живую доставку — накопленные
// ответы в таблицу не едут.
func TestIntegrations_ConnectWithOptions(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)

	formID := newForm(t, wsID, "f-options")
	versionID := publishVersion(t, formID)
	newSubmission(t, formID, versionID, `{"b1":"Старый ответ"}`)

	r := postBodyWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google",
		`{"name":"Заявки с лендинга","spreadsheetId":"","backfill":false}`)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	var sheet sheetDTO
	decode(t, r, &sheet)
	if sheet.Status != "live" {
		t.Fatalf("статус = %q, ожидался живой (перенос выключен)", sheet.Status)
	}

	var name, status string
	if err := testPool.QueryRow(context.Background(),
		`SELECT name, status FROM form_integrations WHERE form_id = $1`, formID).Scan(&name, &status); err != nil {
		t.Fatalf("привязка не записана: %v", err)
	}
	if name != "Заявки с лендинга" {
		t.Errorf("подпись связки = %q", name)
	}

	if _, err := testOutbox.Dispatch(context.Background()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(provider.appended) != 0 {
		t.Fatalf("накопленные ответы уехали вопреки выключенному тумблеру: %v", provider.appended)
	}
}

// Список таблиц для окна отдаёт то, что вернул провайдер: под scope drive.file
// это только созданные нами файлы, чужих документов Диска там нет.
func TestIntegrations_ListSpreadsheets(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)
	formID := newForm(t, wsID, "f-list")

	var got struct {
		Spreadsheets []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"spreadsheets"`
	}
	decode(t, do(t, owner, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/integrations/google/spreadsheets"), &got)

	if len(got.Spreadsheets) != 1 || got.Spreadsheets[0].ID != "ss-old" {
		t.Fatalf("список таблиц = %+v", got.Spreadsheets)
	}
}

// Аккаунт не подключён — окно всё равно открывается, и список приходит пустым,
// а не ошибкой: выбирать пока не из чего, но это не сбой.
func TestIntegrations_ListSpreadsheetsWithoutAccount(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	formID := newForm(t, wsID, "f-list-empty")

	r := do(t, owner, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/integrations/google/spreadsheets")
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("статус = %d, ожидалось 200", r.StatusCode)
	}
	var got struct {
		Spreadsheets []struct{} `json:"spreadsheets"`
	}
	decode(t, r, &got)
	if len(got.Spreadsheets) != 0 {
		t.Fatalf("список = %+v, ожидался пустой", got.Spreadsheets)
	}
}

// Тумблер связки: выключенная не получает новых ответов, но сохраняет таблицу,
// колонки и историю — «выключить на время» и «удалить навсегда» разные
// намерения.
func TestIntegrations_ToggleConnection(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)

	formID := newForm(t, wsID, "f-toggle")
	versionID := publishVersion(t, formID)
	r := postBodyWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google",
		`{"name":"","spreadsheetId":"","sheetId":null,"backfill":false}`)
	var sheet sheetDTO
	decode(t, r, &sheet)

	r = patchWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/"+sheet.ID,
		`{"name":"Архив","enabled":false}`)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("правка связки: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	got := formStatus(t, owner, srv, formID)
	if len(got.Connections) != 1 || got.Connections[0].Enabled || got.Connections[0].Name != "Архив" {
		t.Fatalf("связка = %+v", got.Connections)
	}

	// Ответ выключенной связке события не порождает — не «заводим и гасим», а
	// не заводим вовсе: копить их до возврата тумблера значит однажды вывалить
	// в таблицу всё разом.
	enqueueDelivery(t, srv, formID, newSubmission(t, formID, versionID, `{"b1":"Ирина"}`))
	var queued int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbox WHERE channel = $1`, integrations.ChannelSheets).Scan(&queued); err != nil {
		t.Fatalf("count: %v", err)
	}
	if queued != 0 {
		t.Fatalf("выключенной связке заведено %d событий", queued)
	}

	if _, err := testOutbox.Dispatch(context.Background()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(provider.appended) != 0 {
		t.Fatalf("выключенная связка получила ответ: %v", provider.appended)
	}
}

// Две связки одной формы получают КАЖДАЯ свою копию ответа: правил доставки
// может быть сколько угодно, и они не мешают друг другу.
func TestIntegrations_TwoConnectionsBothDeliver(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)

	formID := newForm(t, wsID, "f-two")
	versionID := publishVersion(t, formID)
	for range 2 {
		r := postBodyWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google",
			`{"name":"","spreadsheetId":"","sheetId":null,"backfill":false}`)
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("связка: статус %d, ожидалось 201", r.StatusCode)
		}
		closeBody(t, r)
	}

	enqueueDelivery(t, srv, formID, newSubmission(t, formID, versionID, `{"b1":"Ирина"}`))
	if _, err := testOutbox.Dispatch(context.Background()); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if len(provider.appended) != 2 {
		t.Fatalf("строк дописано %d, ожидалось две (по одной на связку)", len(provider.appended))
	}
}

// Связка чужой формы не трогается и не раскрывается: 404 на обе операции.
func TestIntegrations_ConnectionOfAnotherForm(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	connectAccount(t, owner, srv, wsID)

	formID := newForm(t, wsID, "f-mine")
	otherID := newForm(t, wsID, "f-other")
	r := postWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google")
	var sheet sheetDTO
	decode(t, r, &sheet)

	// id связки чужой формы в адресе своей — 404, а не «получилось».
	r = deleteWithCSRF(t, owner, srv, "/api/v1/forms/"+otherID+"/integrations/"+sheet.ID)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("удаление чужой связки: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)

	r = patchWithCSRF(t, owner, srv, "/api/v1/forms/"+otherID+"/integrations/"+sheet.ID, `{"name":"чужое"}`)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("правка чужой связки: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)
}

func patchWithCSRF(t *testing.T, c *http.Client, srv *httptest.Server, path, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPatch, srv.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv.URL))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", http.MethodPatch, path, err)
	}
	return resp
}
