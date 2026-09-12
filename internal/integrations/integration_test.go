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
	"errors"
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
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

var testPool *pgxpool.Pool

// testIntegrations — сервис последней собранной вертикали: проход доставщика
// тесты гоняют руками, как это делает periodic-задача в проде.
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
	return newStackWithEgress(t, provider, testEgress())
}

// newStackWithEgress — та же вертикаль, но с заданным исходящим клиентом:
// тестам доставки нужен получатель на loopback, а боевой Guard туда не пустит.
func newStackWithEgress(t *testing.T, provider integrations.Provider, egress integrations.Egress) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, appOrigin, false)

	plans := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, plans, appOrigin)

	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{}, wsSvc, plans)

	svc := integrations.NewService(testPool, postgres.TxRunner{Pool: testPool}, integrations.Repo{},
		wsSvc, formsSvc, provider, testKey).
		WithWebhooks(integrations.Repo{}, egress)
	// Лимитер инжектируется пермиссивной реализацией, а не выключается (инвариант 6).
	h := integrations.NewHandler(svc, authH.RequireAuth, authH.RequireCSRF, appOrigin, false, testKey,
		ratelimit.AllowAll{})

	// Доставка: настоящая очередь связки в Postgres, настоящий submissions как
	// источник строк. Провайдер подставной — живой поход в Google означал бы
	// тест, зелёный только при интернете.
	subsSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, nil,
		pgtest.MailService(testPool), plans, submissions.Repo{}, appOrigin)
	svc = svc.WithDelivery(subsSvc)
	testIntegrations = svc

	mux := http.NewServeMux()
	authH.Routes(mux)
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type accountDTO struct {
	Enabled  bool               `json:"enabled"`
	Accounts []connectedAcctDTO `json:"accounts"`
}

type connectedAcctDTO struct {
	ID             string `json:"id"`
	Email          string `json:"email"`
	NeedsReconnect bool   `json:"needsReconnect"`
	ConnectedAt    string `json:"connectedAt"`
}

type sheetDTO struct {
	ID           string `json:"id"`
	URL          string `json:"url"`
	AccountID    string `json:"accountId"`
	AccountEmail string `json:"accountEmail"`
	Enabled      bool   `json:"enabled"`
	Name         string `json:"name"`
	Status       string `json:"status"`
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
	seedAccountWithForeignToken(t, "owner@example.com")

	got := formStatus(t, owner, srv, newForm(t, wsID, "f-stale"))

	if len(got.Account.Accounts) != 1 {
		t.Fatalf("аккаунты = %+v — строка подключения обязана остаться в списке", got.Account.Accounts)
	}
	if !got.Account.Accounts[0].NeedsReconnect {
		t.Fatalf("аккаунт = %+v, ожидалось требование переподключиться", got.Account.Accounts[0])
	}
}

// seedAccountWithForeignToken кладёт подключение с шифротекстом, который ключом
// контура не открывается. Пройти для этого настоящий OAuth нельзя — он запечатал
// бы токен правильным ключом.
func seedAccountWithForeignToken(t *testing.T, email string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO integration_accounts
		 (id, user_id, provider, external_account_id, external_email, refresh_token, scopes)
		 SELECT $1, id, 'google', 'sub-1', 'author@gmail.com', $3, '' FROM users WHERE email = $2`,
		uuid.New(), email, []byte("шифротекст от прошлого секрета"))
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

// Провайдер настроен, но ничего не подключено — пустой список аккаунтов. Это
// штатное состояние экрана, а не ошибка, и отличается от «интеграции здесь нет»
// (Enabled=false) лечением: там кнопки не появится вовсе.
func TestIntegrations_NothingConnectedYet(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	got := formStatus(t, owner, srv, newForm(t, wsID, "f-owner"))

	if !got.Account.Enabled || len(got.Account.Accounts) != 0 {
		t.Fatalf("аккаунт = %+v, ожидалось «настроено, ничего не подключено»", got.Account)
	}
	if len(got.Connections) != 0 {
		t.Fatalf("связки = %+v, ожидался пустой список", got.Connections)
	}
	if got.WorkspaceID != wsID {
		t.Fatalf("пространство формы = %q, ожидалось %q", got.WorkspaceID, wsID)
	}
}

// Редактор командного пространства подключает СВОЙ аккаунт Google и льёт в него
// ответы чужой формы. Так решено 2026-08-27 (ADR §10): аккаунт личный, и роль в
// пространстве его не гейтит — прежде здесь стоял отказ 403.
//
// Второй половиной решения владелец видит в списке связок чужую почту: связку
// завёл не он, и без подписи «через кого» она выглядела бы интеграцией, которой
// нет ни в чьём селекте.
func TestIntegrations_EditorLinksOwnAccount(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")
	formID := newForm(t, wsID, "f-editor")

	editorAccount := connectAccount(t, editor, srv)

	// В селекте у редактора — его аккаунт; у владельца не подключено ничего.
	if got := formStatus(t, editor, srv, formID).Account; len(got.Accounts) != 1 {
		t.Fatalf("аккаунты редактора = %+v, ожидался ровно свой", got.Accounts)
	}
	if got := formStatus(t, owner, srv, formID).Account; len(got.Accounts) != 0 {
		t.Fatalf("аккаунты владельца = %+v — чужое подключение попало в его селект", got.Accounts)
	}

	r := linkForm(t, editor, srv, formID, editorAccount)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка редактором: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)

	// Владелец связку ВИДИТ и знает, чьим аккаунтом она едет.
	conns := formStatus(t, owner, srv, formID).Connections
	if len(conns) != 1 || conns[0].AccountID != editorAccount {
		t.Fatalf("связки глазами владельца = %+v", conns)
	}
	if conns[0].AccountEmail == "" {
		t.Error("связка не подписана почтой аккаунта — через кого она едет, непонятно")
	}
}

// Чужой аккаунт связке не назначить: id приезжает в теле запроса и правом
// доступа не является. Отказ неотличим от «такого аккаунта нет» — иначе
// перебором id можно было бы узнать, что подключено у соседа.
func TestIntegrations_ForeignAccountRefused(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")

	editorAccount := connectAccount(t, editor, srv)
	formID := newForm(t, wsID, "f-foreign")

	r := linkForm(t, owner, srv, formID, editorAccount)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("привязка чужим аккаунтом: статус %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)

	// И отключить чужой аккаунт тоже нельзя — 204 по идемпотентности, но строка
	// на месте: молчаливый отказ не подтверждает существование чужого.
	r = deleteWithCSRF(t, owner, srv, "/api/v1/integrations/google/accounts/"+editorAccount)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("отключение чужого: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	var left int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM integration_accounts WHERE id = $1`, editorAccount).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 1 {
		t.Fatal("чужой аккаунт отключён из соседнего кабинета")
	}
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

	accountID := connectAccount(t, owner, srv)

	var sealed []byte
	var email, provider string
	var userID uuid.UUID
	err := testPool.QueryRow(context.Background(),
		`SELECT refresh_token, external_email, provider, user_id FROM integration_accounts WHERE id = $1`,
		accountID).Scan(&sealed, &email, &provider, &userID)
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
	if len(got.Accounts) != 1 || got.Accounts[0].Email != "author@gmail.com" || got.Accounts[0].ConnectedAt == "" {
		t.Fatalf("состояние после подключения = %+v", got)
	}

	r := deleteWithCSRF(t, owner, srv, "/api/v1/integrations/google/accounts/"+accountID)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("отключение: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	var left int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM integration_accounts`).Scan(&left); err != nil {
		t.Fatalf("count: %v", err)
	}
	if left != 0 {
		t.Fatalf("после отключения осталось строк: %d", left)
	}

	// Повторное отключение идемпотентно — вторая вкладка не должна краснеть.
	r = deleteWithCSRF(t, owner, srv, "/api/v1/integrations/google/accounts/"+accountID)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("повторное отключение: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)
}

// ГЛАВНАЯ проверка задачи: второй аккаунт ДОБАВЛЯЕТСЯ, а не затирает первый, и
// связки первого продолжают ехать им же.
//
// До 0037 повторное подключение переписывало ту же строку по
// ON CONFLICT (workspace_id, provider), сохраняя её id: связки продолжали на неё
// ссылаться, считались рабочими и начинали писать чужим токеном в таблицы,
// которых тот не видит (scope drive.file), то есть краснели разом.
func TestIntegrations_SecondAccountDoesNotReplaceFirst(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{accounts: []integrations.Account{
		{ID: "sub-1", Email: "personal@gmail.com"},
		{ID: "sub-2", Email: "work@gmail.com"},
	}}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	first := connectAccount(t, owner, srv)
	formID := newForm(t, wsID, "f-two-accounts")
	r := linkForm(t, owner, srv, formID, first)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка к первому аккаунту: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)

	second := connectAccount(t, owner, srv)
	if second == first {
		t.Fatal("второй аккаунт Google переписал первый — ровно тот дефект, ради которого сделано 0037")
	}

	got := formStatus(t, owner, srv, formID)
	if len(got.Account.Accounts) != 2 {
		t.Fatalf("аккаунты = %+v, ожидалось два", got.Account.Accounts)
	}
	if len(got.Connections) != 1 || got.Connections[0].AccountID != first {
		t.Fatalf("связка = %+v — она обязана остаться на первом аккаунте", got.Connections)
	}
	if got.Connections[0].AccountEmail != "personal@gmail.com" {
		t.Errorf("почта связки = %q, ожидалась первого аккаунта", got.Connections[0].AccountEmail)
	}

	// Отключение ВТОРОГО не трогает связки первого: каскад идёт по account_id.
	r = deleteWithCSRF(t, owner, srv, "/api/v1/integrations/google/accounts/"+second)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("отключение второго: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)
	if got := formStatus(t, owner, srv, formID); len(got.Connections) != 1 {
		t.Fatalf("связок после отключения соседнего аккаунта = %d, ожидалась одна", len(got.Connections))
	}
}

// Повторный заход ТЕМ ЖЕ аккаунтом Google обновляет строку, а не плодит вторую:
// так лечится отозванное согласие и пережившая ротацию ключа запись.
func TestIntegrations_ReconnectSameAccountUpdatesRow(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	first := connectAccount(t, owner, srv)
	second := connectAccount(t, owner, srv)

	if first != second {
		t.Fatalf("переподключение тем же аккаунтом завело вторую строку: %s → %s", first, second)
	}
	got := formStatus(t, owner, srv, newForm(t, wsID, "f-reconnect")).Account
	if len(got.Accounts) != 1 {
		t.Fatalf("аккаунты = %+v, ожидался ровно один", got.Accounts)
	}
}

// Подсунутый чужой code с несовпадающим state не подключает ничего: это защита
// от CSRF, без неё атакующий подключает СВОЙ Google к чужому кабинету.
func TestIntegrations_CallbackRejectsForeignState(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")

	startFlow(t, owner, srv)
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
// показывает ссылку. Связок у формы сколько угодно, и удаление одной не трогает
// соседнюю.
func TestIntegrations_LinkFormToSheet(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	accountID := connectAccount(t, owner, srv)
	formID := newForm(t, wsID, "f-link")

	r := linkForm(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка редактором: статус %d, ожидалось 201", r.StatusCode)
	}
	var sheet sheetDTO
	decode(t, r, &sheet)
	if sheet.URL == "" || sheet.Status != "live" {
		t.Fatalf("привязка = %+v", sheet)
	}

	got := formStatus(t, owner, srv, formID)
	if len(got.Connections) != 1 || got.Connections[0].URL != sheet.URL {
		t.Fatalf("состояние формы = %+v, ожидалась одна связка", got.Connections)
	}

	// Вторая связка законна — в том числе в ту же книгу: интеграция это правило
	// доставки, а не состояние формы.
	r = linkForm(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("вторая связка: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)
	if got := formStatus(t, owner, srv, formID); len(got.Connections) != 2 {
		t.Fatalf("связок = %d, ожидалось две", len(got.Connections))
	}

	r = deleteWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/"+sheet.ID)
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

	r := linkForm(t, owner, srv, newForm(t, wsID, "f-noacc"), uuid.New().String())
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
	accountID := connectAccount(t, owner, srv)
	formID := newForm(t, wsID, "f-cascade")

	r := linkForm(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)

	r = deleteWithCSRF(t, owner, srv, "/api/v1/integrations/google/accounts/"+accountID)
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

// connectAccount проходит поход за согласием целиком и отдаёт id подключения:
// адресоваться к аккаунту теперь надо явно, «подразумеваемого» больше нет.
func connectAccount(t *testing.T, c *http.Client, srv *httptest.Server) string {
	t.Helper()
	state := startFlow(t, c, srv)
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/integrations/google/callback?code=auth-code&state="+state)
	assertOutcome(t, r, "integration_ok")

	// Свежайшее подключение этого браузера. Колбэк — навигация и id не отдаёт
	// (он редиректит на служебный экран), поэтому берём из базы.
	var id string
	if err := testPool.QueryRow(context.Background(),
		`SELECT id FROM integration_accounts ORDER BY connected_at DESC, id DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatalf("подключение не записано: %v", err)
	}
	return id
}

// linkForm привязывает форму к таблице названного аккаунта. Тело обязательно:
// accountId подразумевать нечем.
func linkForm(t *testing.T, c *http.Client, srv *httptest.Server, formID, accountID string) *http.Response {
	t.Helper()
	return postBodyWithCSRF(t, c, srv, "/api/v1/forms/"+formID+"/integrations/google",
		`{"accountId":"`+accountID+`"}`)
}

// linkBody — тело привязки с дополнительными настройками окна.
func linkBody(accountID, rest string) string {
	return `{"accountId":"` + accountID + `",` + rest + `}`
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

// Существующую связку можно перевести на ДРУГОЙ свой аккаунт — вместе с целью.
//
// Раздельно нельзя физически (drive.file: прежняя таблица новому аккаунту не
// видна), поэтому account_id и лист переезжают одной записью. Строки, уже
// доставленные в прежний лист, остаются там.
func TestIntegrations_MoveConnectionToAnotherAccount(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{accounts: []integrations.Account{
		{ID: "sub-1", Email: "personal@gmail.com"},
		{ID: "sub-2", Email: "work@gmail.com"},
	}}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	first := connectAccount(t, owner, srv)
	second := connectAccount(t, owner, srv)
	formID := newForm(t, wsID, "f-move")

	r := postBodyWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google",
		linkBody(first, `"backfill":false`))
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	var sheet sheetDTO
	decode(t, r, &sheet)

	r = patchWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/"+sheet.ID,
		`{"name":"Рабочий Диск","accountId":"`+second+`","spreadsheetId":"","backfill":false}`)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("перевод на другой аккаунт: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	conns := formStatus(t, owner, srv, formID).Connections
	if len(conns) != 1 {
		t.Fatalf("связок = %d, ожидалась одна: перевод не должен плодить вторую", len(conns))
	}
	if conns[0].AccountID != second || conns[0].AccountEmail != "work@gmail.com" {
		t.Fatalf("связка = %+v, ожидался второй аккаунт", conns[0])
	}
	if conns[0].ID != sheet.ID {
		t.Error("id связки сменился — переехала не она, а новая")
	}
}

// Чужим аккаунтом связку не перевести, и отказ приходит ДО первой записи: иначе
// подпись сохранилась бы, а человек увидел бы ошибку вместе с новым названием.
func TestIntegrations_MoveConnectionToForeignAccountRefused(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")

	ownerAccount := connectAccount(t, owner, srv)
	editorAccount := connectAccount(t, editor, srv)
	formID := newForm(t, wsID, "f-move-foreign")

	r := postBodyWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google",
		linkBody(ownerAccount, `"backfill":false`))
	var sheet sheetDTO
	decode(t, r, &sheet)

	r = patchWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/"+sheet.ID,
		`{"name":"Чужой","accountId":"`+editorAccount+`","spreadsheetId":"","backfill":false}`)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("перевод на чужой аккаунт: статус %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)

	conns := formStatus(t, owner, srv, formID).Connections
	if len(conns) != 1 || conns[0].AccountID != ownerAccount {
		t.Fatalf("связка = %+v, ожидалась на прежнем аккаунте", conns)
	}
	if conns[0].Name == "Чужой" {
		t.Error("подпись сохранена, хотя правка отклонена")
	}
}

// Переподключение отличается от «подключить ещё один» ровно подсказкой: адрес
// один, а accountId в параметре заставляет сервер передать провайдеру почту
// названного аккаунта. Чужой аккаунт подсказкой не станет — иначе перебором id
// вычитывались бы чужие адреса.
func TestIntegrations_StartWithReconnectHint(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	accountID := connectAccount(t, owner, srv)

	provider.loginHint = ""
	r := do(t, owner, http.MethodGet,
		srv.URL+"/api/v1/integrations/google/start?accountId="+accountID)
	closeBody(t, r)
	if r.StatusCode != http.StatusFound {
		t.Fatalf("start: статус %d, ожидалось 302", r.StatusCode)
	}
	if provider.loginHint != "author@gmail.com" {
		t.Errorf("подсказка = %q, ожидалась почта аккаунта", provider.loginHint)
	}

	// Чужой аккаунт: 422 и никакой почты наружу.
	stranger := registerUser(t, srv, "stranger@example.com")
	provider.loginHint = ""
	r = do(t, stranger, http.MethodGet,
		srv.URL+"/api/v1/integrations/google/start?accountId="+accountID)
	closeBody(t, r)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("start с чужим аккаунтом: статус %d, ожидалось 422", r.StatusCode)
	}
	if provider.loginHint != "" {
		t.Errorf("чужая почта уехала провайдеру: %q", provider.loginHint)
	}
}

// startFlow проходит первый шаг и отдаёт state, который сервер положил в cookie
// (он же уехал в ссылку провайдера).
func startFlow(t *testing.T, c *http.Client, srv *httptest.Server) string {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/integrations/google/start")
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
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-deliver")
	versionID := publishVersion(t, formID)
	r := linkForm(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)

	subID := newSubmission(t, formID, versionID, `{"b1":"Ирина"}`)
	enqueueDelivery(t, srv, formID, subID)

	deliver(t)
	if len(provider.appended) != 1 {
		t.Fatalf("в лист дописано %d строк", len(provider.appended))
	}
	// Порядок колонок листа: id ответа, время, версия, затем вопрос.
	if got := provider.appended[0]; len(got) != 4 || got[0] != subID || got[3] != "Ирина" {
		t.Fatalf("строка = %v", got)
	}

	if got := sheetQueueLen(t, formID); got != 0 {
		t.Fatalf("в очереди осталось %d недоставленных строк", got)
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

	if got := sheetQueueLen(t, formID); got != 0 {
		t.Fatalf("в очереди %d строк для непривязанной формы", got)
	}
}

// enqueueDelivery ставит событие доставки так же, как это делает приём ответа
// после коммита. Через HTTP это шло бы публичной ручкой с антиспам-токеном —
// тест про доставку, а не про приём.
// Участника сняли с пространства — связка его аккаунтом Google встаёт, а
// владелец видит причину текстом. Это плата за личные аккаунты, названная в
// ADR §10 и закрытая сторожем доставки: без него ответы команды продолжали бы
// течь в Диск бывшего участника.
func TestIntegrations_DeliveryStopsAfterMemberRemoved(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")

	editorAccount := connectAccount(t, editor, srv)
	formID := newForm(t, wsID, "f-left")
	versionID := publishVersion(t, formID)
	r := postBodyWithCSRF(t, editor, srv, "/api/v1/forms/"+formID+"/integrations/google",
		linkBody(editorAccount, `"backfill":false`))
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	closeBody(t, r)

	removeMember(t, wsID, "editor@example.com")

	enqueueDelivery(t, srv, formID, newSubmission(t, formID, versionID, `{"b1":"Ирина"}`))
	deliver(t)

	if len(provider.appended) != 0 {
		t.Fatalf("ответ уехал в Диск бывшего участника: %v", provider.appended)
	}
	conns := formStatus(t, owner, srv, formID).Connections
	if len(conns) != 1 || conns[0].Status != "broken" {
		t.Fatalf("связка = %+v, ожидался статус broken", conns)
	}

	// Ответ ОСТАЁТСЯ в очереди: сломанную связку доставщик не берёт вовсе, а
	// заведённая заново своим аккаунтом увезёт накопленное. Погасить его, как
	// событие outbox, значило бы потерять ответ навсегда.
	if got := sheetQueueLen(t, formID); got != 1 {
		t.Fatalf("в очереди %d строк, ожидалась одна", got)
	}
}

// removeMember снимает доступ напрямую: проходить ручку кабинета ради проверки
// доставки было бы тестом про участников, а не про интеграции.
func removeMember(t *testing.T, wsID, email string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`DELETE FROM workspace_members
		  WHERE workspace_id = $1 AND user_id = (SELECT id FROM users WHERE email = $2)`,
		wsID, email)
	if err != nil {
		t.Fatalf("снятие участника: %v", err)
	}
}

// enqueueDelivery ставит ответ в очередь связок формы ровно так, как это делает
// ветка CTE приёма (internal/submissions/queries.sql): тесты ниже вставляют
// ответы напрямую, минуя публичную ручку с антиспам-токеном, — они про доставку,
// а не про приём. Саму ветку проверяет свой интеграционный тест в submissions.
func enqueueDelivery(t *testing.T, _ *httptest.Server, formID, subID string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO sheet_queue (link_id, submission_id)
		 SELECT fi.id, $2 FROM form_integrations fi WHERE fi.form_id = $1 AND fi.enabled
		 ON CONFLICT DO NOTHING`, formID, subID)
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
}

// deliver гоняет проход доставщика Таблиц — тот же, что крутит периодическая
// задача sheet-delivery.
func deliver(t *testing.T) {
	t.Helper()
	if _, err := testIntegrations.DeliverSheets(context.Background()); err != nil {
		t.Fatalf("проход доставщика: %v", err)
	}
}

// sheetQueueLen — длина очереди связок формы: ею тесты проверяют и «доставлено»,
// и «копится до починки».
func sheetQueueLen(t *testing.T, formID string) int {
	t.Helper()
	var n int
	err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM sheet_queue q JOIN form_integrations fi ON fi.id = q.link_id
		  WHERE fi.form_id = $1`, formID).Scan(&n)
	if err != nil {
		t.Fatalf("count sheet queue: %v", err)
	}
	return n
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
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-backfill")
	versionID := publishVersion(t, formID)
	first := newSubmission(t, formID, versionID, `{"b1":"Первый"}`)
	second := newSubmission(t, formID, versionID, `{"b1":"Второй"}`)

	r := linkForm(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("привязка: статус %d, ожидалось 201", r.StatusCode)
	}
	var sheet sheetDTO
	decode(t, r, &sheet)
	// Отдельного статуса у переноса больше нет (0065): он виден очередью, и
	// пока она не разобрана, связка живая и просто занятая.
	if sheet.Status != "live" {
		t.Fatalf("статус сразу после привязки = %q", sheet.Status)
	}
	if got := sheetQueueLen(t, formID); got != 2 {
		t.Fatalf("накопленных в очереди %d, ожидалось 2", got)
	}

	deliver(t)
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
	deliver(t)
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
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-refill")
	versionID := publishVersion(t, formID)
	newSubmission(t, formID, versionID, `{"b1":"Ирина"}`)

	r := linkForm(t, owner, srv, formID, accountID)
	var sheet sheetDTO
	decode(t, r, &sheet)
	dispatchAll(t)
	before := len(provider.appended)

	r = postWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/"+sheet.ID+"/refill")
	if r.StatusCode != http.StatusAccepted {
		t.Fatalf("перезалив: статус %d, ожидалось 202", r.StatusCode)
	}
	closeBody(t, r)
	if provider.cleared == "" {
		t.Error("лист не вычищен")
	}

	dispatchAll(t)
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
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-options")
	versionID := publishVersion(t, formID)
	newSubmission(t, formID, versionID, `{"b1":"Старый ответ"}`)

	r := postBodyWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google",
		linkBody(accountID, `"name":"Заявки с лендинга","spreadsheetId":"","backfill":false`))
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

	deliver(t)
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
	accountID := connectAccount(t, owner, srv)

	var got struct {
		Spreadsheets []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"spreadsheets"`
	}
	decode(t, do(t, owner, http.MethodGet, srv.URL+"/api/v1/integrations/google/accounts/"+accountID+"/spreadsheets"), &got)

	if len(got.Spreadsheets) != 1 || got.Spreadsheets[0].ID != "ss-old" {
		t.Fatalf("список таблиц = %+v", got.Spreadsheets)
	}
}

// Список спрашивают у КОНКРЕТНОГО аккаунта, и несуществующий отвечает 422, а не
// пустым списком: окно сначала выбирает аккаунт, и спрашивать список до выбора
// незачем.
func TestIntegrations_ListSpreadsheetsOfUnknownAccount(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")

	r := do(t, owner, http.MethodGet,
		srv.URL+"/api/v1/integrations/google/accounts/"+uuid.New().String()+"/spreadsheets")
	defer closeBody(t, r)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422", r.StatusCode)
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
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-toggle")
	versionID := publishVersion(t, formID)
	r := postBodyWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google",
		linkBody(accountID, `"name":"","spreadsheetId":"","sheetId":null,"backfill":false`))
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
	if got := sheetQueueLen(t, formID); got != 0 {
		t.Fatalf("выключенной связке заведено %d строк очереди", got)
	}

	deliver(t)
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
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-two")
	versionID := publishVersion(t, formID)
	for range 2 {
		r := postBodyWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/integrations/google",
			linkBody(accountID, `"name":"","spreadsheetId":"","sheetId":null,"backfill":false`))
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("связка: статус %d, ожидалось 201", r.StatusCode)
		}
		closeBody(t, r)
	}

	enqueueDelivery(t, srv, formID, newSubmission(t, formID, versionID, `{"b1":"Ирина"}`))
	deliver(t)
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
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-mine")
	otherID := newForm(t, wsID, "f-other")
	r := linkForm(t, owner, srv, formID, accountID)
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

// Журнал доставок против настоящей БД: успех оставляет строку, отказ оставляет
// строку с причиной, а повтор доставляет ответ заново — обычным событием
// очереди, через те же проверки.
func TestIntegrations_DeliveryLogAndRetry(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-log")
	versionID := publishVersion(t, formID)
	closeBody(t, linkForm(t, owner, srv, formID, accountID))

	// 1. Обычная доставка: в журнале появляется успех.
	subID := newSubmission(t, formID, versionID, `{"b1":"Ирина"}`)
	enqueueDelivery(t, srv, formID, subID)
	dispatchAll(t)

	linkID := onlyLinkID(t, owner, srv, formID)
	page := deliveriesPage(t, owner, srv, formID, linkID, "")
	if len(page.Deliveries) != 1 {
		t.Fatalf("записей в журнале %d, ждали одну: %+v", len(page.Deliveries), page.Deliveries)
	}
	if got := page.Deliveries[0]; got.Outcome != integrations.OutcomeDelivered || got.SubmissionID != subID {
		t.Fatalf("первая запись = %+v", got)
	}

	// 2. Временный отказ: строка в журнале с причиной, связка НЕ красная.
	provider.appendErr = errors.New("статус 503")
	failed := newSubmission(t, formID, versionID, `{"b1":"Пётр"}`)
	enqueueDelivery(t, srv, formID, failed)
	dispatchAll(t)

	page = deliveriesPage(t, owner, srv, formID, linkID, "")
	if len(page.Deliveries) != 2 {
		t.Fatalf("записей в журнале %d, ждали две: %+v", len(page.Deliveries), page.Deliveries)
	}
	top := page.Deliveries[0]
	if top.Outcome != integrations.OutcomeFailed || top.SubmissionID != failed {
		t.Fatalf("верхняя запись = %+v, ждали неудачу по второму ответу", top)
	}
	if top.Detail == "" {
		t.Error("неудача без текста: автору формы нечего прочитать")
	}

	// 3. Повтор: причина устранена, кнопка ставит событие заново, ответ уезжает.
	provider.appendErr = nil
	before := len(provider.appended)
	r := postWithCSRF(t, owner, srv,
		"/api/v1/forms/"+formID+"/integrations/"+linkID+"/deliveries/"+top.ID+"/retry")
	if r.StatusCode != http.StatusAccepted {
		t.Fatalf("повтор: статус %d, ожидалось 202", r.StatusCode)
	}
	closeBody(t, r)
	dispatchAll(t)

	if len(provider.appended) != before+1 {
		t.Fatalf("строк в листе %d, ждали +1 после повтора", len(provider.appended))
	}
	page = deliveriesPage(t, owner, srv, formID, linkID, "")
	if len(page.Deliveries) != 3 {
		t.Fatalf("записей в журнале %d, ждали три: %+v", len(page.Deliveries), page.Deliveries)
	}
	if got := page.Deliveries[0]; got.Outcome != integrations.OutcomeDelivered || got.SubmissionID != failed {
		t.Fatalf("верхняя запись после повтора = %+v", got)
	}
}

// Журнал — не публичное чтение: чужой формы для постороннего не существует
// (инвариант 5), а повтор чужой доставки не заводится и подавно.
func TestIntegrations_DeliveryLogHiddenFromStranger(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	accountID := connectAccount(t, owner, srv)
	formID := newForm(t, wsID, "f-log-private")
	publishVersion(t, formID)
	closeBody(t, linkForm(t, owner, srv, formID, accountID))
	linkID := onlyLinkID(t, owner, srv, formID)

	stranger := registerUser(t, srv, "stranger@example.com")
	r := do(t, stranger, http.MethodGet,
		srv.URL+"/api/v1/forms/"+formID+"/integrations/"+linkID+"/deliveries")
	defer closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("посторонний читает журнал: статус %d, ожидалось 404", r.StatusCode)
	}
}

// Повтор у СЛОМАННОЙ связки отказывает, а не ставит событие: Deliver гасит
// события такой связки первой же проверкой, и кнопка молча ничего не делала бы.
func TestIntegrations_RetryRefusedWhileBroken(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	accountID := connectAccount(t, owner, srv)
	formID := newForm(t, wsID, "f-log-broken")
	versionID := publishVersion(t, formID)
	closeBody(t, linkForm(t, owner, srv, formID, accountID))
	linkID := onlyLinkID(t, owner, srv, formID)

	provider.appendErr = integrations.ErrPermanent
	enqueueDelivery(t, srv, formID, newSubmission(t, formID, versionID, `{"b1":"Ирина"}`))
	dispatchAll(t)

	page := deliveriesPage(t, owner, srv, formID, linkID, "")
	if len(page.Deliveries) != 1 || page.Deliveries[0].Outcome != integrations.OutcomeFailed {
		t.Fatalf("журнал = %+v, ждали одну неудачу", page.Deliveries)
	}
	r := postWithCSRF(t, owner, srv,
		"/api/v1/forms/"+formID+"/integrations/"+linkID+"/deliveries/"+page.Deliveries[0].ID+"/retry")
	defer closeBody(t, r)
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("повтор на сломанной связке: статус %d, ожидалось 409", r.StatusCode)
	}
}

// deliveryItem — строка ленты, как её видит кабинет.
type deliveryItem struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	SubmissionID string `json:"submissionId"`
	Outcome      string `json:"outcome"`
	Detail       string `json:"detail"`
	Rows         int32  `json:"rows"`
	HTTPStatus   int32  `json:"httpStatus"`
	CreatedAt    string `json:"createdAt"`
}

type deliveryPage struct {
	Deliveries []deliveryItem `json:"deliveries"`
	NextCursor string         `json:"nextCursor"`
}

func deliveriesPage(t *testing.T, c *http.Client, srv *httptest.Server, formID, linkID, cursor string) deliveryPage {
	t.Helper()
	u := srv.URL + "/api/v1/forms/" + formID + "/integrations/" + linkID + "/deliveries"
	if cursor != "" {
		u += "?cursor=" + cursor
	}
	r := do(t, c, http.MethodGet, u)
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("журнал доставок: статус %d, ожидалось 200", r.StatusCode)
	}
	var page deliveryPage
	decode(t, r, &page)
	return page
}

// onlyLinkID — id единственной связки формы. Тесты журнала не про список, а id
// связки нужен им в адресе.
func onlyLinkID(t *testing.T, c *http.Client, srv *httptest.Server, formID string) string {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/integrations")
	var status struct {
		Connections []struct {
			ID string `json:"id"`
		} `json:"connections"`
	}
	decode(t, r, &status)
	if len(status.Connections) != 1 {
		t.Fatalf("связок у формы %d, ждали одну", len(status.Connections))
	}
	return status.Connections[0].ID
}

// dispatchAll крутит доставщик, пока он разбирает очередь: за проход связка
// увозит пачку, и длинная очередь требует нескольких.
func dispatchAll(t *testing.T) {
	t.Helper()
	for range 10 {
		n, err := testIntegrations.DeliverSheets(context.Background())
		if err != nil {
			t.Fatalf("проход доставщика: %v", err)
		}
		if n == 0 {
			return
		}
	}
}

// Смерть согласия помечает ПОДКЛЮЧЕНИЕ, и экран узнаёт об этом во ВСЕХ формах,
// а не только в той, где упала доставка. Переподключение пометку снимает — той
// же строкой аккаунта, без второй привязки формы.
//
// Это тот самый случай владельца (2026-09-10): аккаунт отвалился, а кабинет
// показывал его рабочим, потому что признак жил в статусе одной связки.
func TestIntegrations_AccessLostSurfacesEverywhere(t *testing.T) {
	resetDB(t)
	provider := &fakeProvider{}
	srv := newStack(t, provider)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	accountID := connectAccount(t, owner, srv)

	// Две формы одним аккаунтом: доставка упадёт только в первой.
	withDelivery := newForm(t, wsID, "f-dead-1")
	versionID := publishVersion(t, withDelivery)
	closeBody(t, linkForm(t, owner, srv, withDelivery, accountID))
	quiet := newForm(t, wsID, "f-dead-2")
	publishVersion(t, quiet)
	closeBody(t, linkForm(t, owner, srv, quiet, accountID))

	provider.refreshErr = integrations.ErrAccessLost
	enqueueDelivery(t, srv, withDelivery, newSubmission(t, withDelivery, versionID, `{"b1":"Ирина"}`))
	dispatchAll(t)

	// Форма, в которой доставок не было вовсе, обязана сказать правду.
	if !needsReconnect(t, owner, srv, quiet, accountID) {
		t.Fatal("в тихой форме аккаунт всё ещё выглядит рабочим — ровно тот дефект, ради которого заводилась пометка")
	}

	// Переподключение: тот же аккаунт, та же строка, пометки больше нет.
	provider.refreshErr = nil
	if again := connectAccount(t, owner, srv); again != accountID {
		t.Fatalf("переподключение завело новую строку %s вместо %s", again, accountID)
	}
	if needsReconnect(t, owner, srv, quiet, accountID) {
		t.Fatal("после переподключения аккаунт всё ещё просит переподключиться")
	}
}

// needsReconnect — что экран формы говорит про названный аккаунт.
func needsReconnect(t *testing.T, c *http.Client, srv *httptest.Server, formID, accountID string) bool {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/integrations")
	var status struct {
		Account struct {
			Accounts []struct {
				ID             string `json:"id"`
				NeedsReconnect bool   `json:"needsReconnect"`
			} `json:"accounts"`
		} `json:"account"`
	}
	decode(t, r, &status)
	for _, a := range status.Account.Accounts {
		if a.ID == accountID {
			return a.NeedsReconnect
		}
	}
	t.Fatalf("аккаунт %s пропал из состояния формы", accountID)
	return false
}

// ⚠ Граница версии строки живёт в САМОМ запросе, а не в коде вокруг него:
// снятие с очереди не имеет права трогать строку, поставленную ПОЗЖЕ той, что
// читал доставщик. Между чтением очереди и снятием лежат два-три похода в
// Google, и перезалив, успевший в это окно, ставит те же ответы заново — уже
// под новый лист. Без границы они уехали бы в старый и пропали для нового.
//
// Проверяется против настоящего Postgres: в фейке это условие можно случайно
// повторить неверно, а `<=` против `<` на равных метках виден только здесь.
func TestIntegrations_QueueDropSpareRowsRequeuedLater(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	accountID := connectAccount(t, owner, srv)

	formID := newForm(t, wsID, "f-requeue")
	versionID := publishVersion(t, formID)
	closeBody(t, linkForm(t, owner, srv, formID, accountID))
	linkID := uuid.MustParse(onlyLinkID(t, owner, srv, formID))

	subID := uuid.MustParse(newSubmission(t, formID, versionID, `{"b1":"Ирина"}`))
	enqueueDelivery(t, srv, formID, subID.String())

	var enqueued time.Time
	err := testPool.QueryRow(context.Background(),
		`SELECT enqueued_at FROM sheet_queue WHERE link_id = $1 AND submission_id = $2`,
		linkID, subID).Scan(&enqueued)
	if err != nil {
		t.Fatalf("строка очереди не найдена: %v", err)
	}

	// Доставщик читал строку СЕКУНДОЙ РАНЬШЕ — значит, эта уже чужая.
	repo := integrations.Repo{}
	if err := repo.DropSheetQueued(context.Background(), testPool, linkID,
		[]uuid.UUID{subID}, enqueued.Add(-time.Second)); err != nil {
		t.Fatalf("снятие с очереди: %v", err)
	}
	if got := sheetQueueLen(t, formID); got != 1 {
		t.Fatal("снята строка, поставленная позже прочитанной: перезалив потерял бы свою очередь")
	}

	// Та же строка, что читали, снимается как обычно.
	if err := repo.DropSheetQueued(context.Background(), testPool, linkID,
		[]uuid.UUID{subID}, enqueued); err != nil {
		t.Fatalf("снятие с очереди: %v", err)
	}
	if got := sheetQueueLen(t, formID); got != 0 {
		t.Fatalf("в очереди осталось %d строк — доставленное не снимается", got)
	}
}
