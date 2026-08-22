//go:build integration

// Интеграционный тест workspaces против настоящего Postgres в контейнере: реальная
// вертикаль auth+workspaces. Регистрация заводит личный воркспейс (транзакция
// auth), GET /workspaces возвращает его владельцу; чужой пользователь видит только
// свой (членство — инвариант доступа, а не все воркспейсы подряд).
package workspaces_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
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
		`TRUNCATE users, workspaces, workspace_members, sessions, invitations, outbox CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack собирает реальную вертикаль auth+workspaces поверх контейнерного пула.
// Лимитер auth — пермиссивный (инвариант 6).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	plans := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, plans,
		pgtest.MailService(testPool), "http://localhost:5173")
	// Лимитер приглашений — пермиссивный (инвариант 6: лимит не ослабляется
	// ради теста, а инжектируется).
	wsH := workspaces.NewHandler(wsSvc, ratelimit.AllowAll{}, authH.RequireAuth, authH.RequireCSRF)

	mux := http.NewServeMux()
	authH.Routes(mux)
	wsH.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

type workspaceDTO struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	IsPersonal bool   `json:"isPersonal"`
	FormCount  int64  `json:"formCount"`
}

type listDTO struct {
	Workspaces []workspaceDTO `json:"workspaces"`
}

// Владелец получает своё личное пространство (созданное при регистрации).
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
	if got.Workspaces[0].Name != "Личное пространство" || got.Workspaces[0].ID == "" {
		t.Fatalf("воркспейс = %+v, ожидалось «Личное пространство» с непустым id", got.Workspaces[0])
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

// post отправляет тело с CSRF-заголовком: запись за RequireCSRF.
func post(t *testing.T, c *http.Client, srv *httptest.Server, path, jsonBody string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srv.URL+path, strings.NewReader(jsonBody))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv.URL))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

// patch — как post, другим методом: запись тоже за RequireCSRF.
func patch(t *testing.T, c *http.Client, srv *httptest.Server, path, jsonBody string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPatch, srv.URL+path, strings.NewReader(jsonBody))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
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

// setWorkspaceLimit включает лимит числа пространств на плане free тем же
// UPDATE, каким его включит владелец на проде (гейты приезжают выключенными).
func setWorkspaceLimit(t *testing.T, limit string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, '{workspaces}', $1::jsonb) WHERE code = 'free'`,
		limit); err != nil {
		t.Fatalf("set workspace limit: %v", err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE plans SET limits = jsonb_set(limits, '{workspaces}', 'null') WHERE code = 'free'`); err != nil {
			t.Fatalf("reset workspace limit: %v", err)
		}
	})
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

// Владелец у пространства РОВНО один: «не больше одного» держит БД (частичный
// уникальный индекс 0016), потому что план пространства резолвится через
// владельца — два owner'а означали бы два ответа на вопрос «чей это тариф».
// Проверяется на настоящем Postgres: правило живёт в схеме, а не в Go.
func TestWorkspaceMembers_SecondOwnerRejected(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	registerUser(t, srv, "owner@example.com")

	ctx := context.Background()
	var wsID string
	if err := testPool.QueryRow(ctx, `SELECT id FROM workspaces LIMIT 1`).Scan(&wsID); err != nil {
		t.Fatalf("личное пространство не найдено: %v", err)
	}

	// Второй пользователь — законный участник, но вторым владельцем стать не может.
	var secondID string
	if err := testPool.QueryRow(ctx,
		`INSERT INTO users (id, email) VALUES (gen_random_uuid(), 'second@example.com') RETURNING id`,
	).Scan(&secondID); err != nil {
		t.Fatalf("insert user: %v", err)
	}

	if _, err := testPool.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')`,
		wsID, secondID); err != nil {
		t.Fatalf("второй участник ролью editor должен заводиться: %v", err)
	}

	_, err := testPool.Exec(ctx,
		`UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`,
		wsID, secondID)
	if err == nil {
		t.Fatal("второй owner в пространстве заведён — уникальный индекс не работает")
	}
	if !strings.Contains(err.Error(), "idx_workspace_members_owner") {
		t.Errorf("отказ пришёл не от индекса владельца: %v", err)
	}
}

// Создание пространства: 201, владельцем становится создатель,
// пространство появляется в его списке и НЕ помечено личным.
func TestCreateWorkspace_AppearsInListAsTeam(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	r := post(t, c, srv, "/api/v1/workspaces", `{"name":"  Команда  "}`)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создание: статус %d, ожидалось 201", r.StatusCode)
	}
	var created workspaceDTO
	decode(t, r, &created)
	if created.Name != "Команда" {
		t.Errorf("имя = %q, ждали обрезанное «Команда»", created.Name)
	}
	if created.IsPersonal {
		t.Error("созданное пространство помечено личным — личное заводит только регистрация")
	}

	var got listDTO
	decode(t, do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces"), &got)
	if len(got.Workspaces) != 2 {
		t.Fatalf("пространств = %d, ожидалось 2: %+v", len(got.Workspaces), got.Workspaces)
	}
	// Личное первое: оно старше любого другого (сортировка по created_at).
	if !got.Workspaces[0].IsPersonal || got.Workspaces[1].IsPersonal {
		t.Errorf("порядок и пометки = %+v, ждали личное первым", got.Workspaces)
	}

	// Владелец ровно один и это создатель: пространство работает по его плану.
	var owners int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`,
		created.ID).Scan(&owners); err != nil {
		t.Fatalf("count owners: %v", err)
	}
	if owners != 1 {
		t.Errorf("владельцев = %d, ждали ровно одного", owners)
	}
}

// Гейт тарифа: на плане с лимитом в одно пространство второе не заводится, и
// отказ приходит как 402 (plan_required), а не 400 или 403.
func TestCreateWorkspace_PlanLimit(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")
	setWorkspaceLimit(t, "1")

	r := post(t, c, srv, "/api/v1/workspaces", `{"name":"Команда"}`)
	if r.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("статус = %d, ожидалось 402 (личное уже занимает единственное место)", r.StatusCode)
	}
	closeBody(t, r)

	var got listDTO
	decode(t, do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces"), &got)
	if len(got.Workspaces) != 1 {
		t.Fatalf("пространств = %d, ожидалось 1 — отказ не должен ничего создавать", len(got.Workspaces))
	}
}

// Лимит считает пространства, которыми аккаунт ВЛАДЕЕТ. Членство в чужом место
// не занимает — иначе владелец Pro не смог бы позвать никого с Free.
func TestCreateWorkspace_MembershipInForeignDoesNotConsumeLimit(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	registerUser(t, srv, "bob@example.com")

	// Алиса заводит дополнительное; Боб — просто участник (роль editor).
	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 SELECT $1, id, 'editor' FROM users WHERE email = 'bob@example.com'`, team.ID); err != nil {
		t.Fatalf("добавить участника: %v", err)
	}

	setWorkspaceLimit(t, "2")

	// У Боба во владении одно (личное), значит второе место свободно, хотя
	// состоит он уже в двух пространствах.
	bob := loginUser(t, srv, "bob@example.com")
	r := post(t, bob, srv, "/api/v1/workspaces", `{"name":"Боб и Ко"}`)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("статус = %d, ожидалось 201: членство в чужом пространстве съело место", r.StatusCode)
	}
	closeBody(t, r)
}

// Пустое имя — 422 (ошибка валидации), а не пространство без названия.
func TestCreateWorkspace_EmptyNameRejected(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	r := post(t, c, srv, "/api/v1/workspaces", `{"name":"   "}`)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)
}

// Без CSRF-заголовка запись не проходит (инвариант: мутация за RequireCSRF).
func TestCreateWorkspace_RequiresCSRF(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	r := doBody(t, c, http.MethodPost, srv.URL+"/api/v1/workspaces", `{"name":"Команда"}`)
	if r.StatusCode == http.StatusCreated {
		t.Fatal("пространство создано без CSRF-токена")
	}
	closeBody(t, r)
}

func loginUser(t *testing.T, srv *httptest.Server, email string) *http.Client {
	t.Helper()
	c := newClient(t)
	r := doBody(t, c, http.MethodPost, srv.URL+"/api/v1/auth/login",
		`{"email":"`+email+`","password":"supersecret1"}`)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("login %s: статус %d, ожидалось 200", email, r.StatusCode)
	}
	closeBody(t, r)
	return c
}

// Права против настоящей БД: роль читается запросом, а решение принимает
// матрица. Три исхода, которые нельзя путать, — и все три видны снаружи.
func TestCan_RolesAgainstDB(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	registerUser(t, srv, "editor@example.com")
	registerUser(t, srv, "stranger@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	teamID := uuid.MustParse(team.ID)

	ctx := context.Background()
	editorID := userIDByEmail(t, "editor@example.com")
	strangerID := userIDByEmail(t, "stranger@example.com")
	if _, err := testPool.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')`,
		teamID, editorID); err != nil {
		t.Fatalf("добавить редактора: %v", err)
	}

	plans := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	svc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, plans,
		pgtest.MailService(testPool), "http://localhost:5173")

	// Редактор правит формы…
	if err := svc.Can(ctx, teamID, editorID, domain.ActionFormWrite); err != nil {
		t.Errorf("редактору запрещено править формы: %v", err)
	}
	// …и удаляет их (решение владельца 2026-08-02)…
	if err := svc.Can(ctx, teamID, editorID, domain.ActionFormDelete); err != nil {
		t.Errorf("редактору запрещено удалять формы: %v", err)
	}
	// …но тариф и участники — не его дело: 403, а не 404. Пространство он видит,
	// скрывать нечего.
	for _, action := range []domain.Action{domain.ActionBillingView, domain.ActionMemberManage} {
		err := svc.Can(ctx, teamID, editorID, action)
		if !errors.Is(err, domain.ErrForbidden) {
			t.Errorf("редактор и %q: err = %v, ждали ErrForbidden (403)", action, err)
		}
	}

	// Посторонний получает 404 на всё: существование пространства не раскрываем.
	err := svc.Can(ctx, teamID, strangerID, domain.ActionFormRead)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("посторонний: err = %v, ждали ErrNotFound (404)", err)
	}
}

func userIDByEmail(t *testing.T, email string) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := testPool.QueryRow(context.Background(),
		`SELECT id FROM users WHERE email = $1`, email).Scan(&id); err != nil {
		t.Fatalf("пользователь %s: %v", email, err)
	}
	return id
}

// Сквозной путь приглашения против настоящей БД и настоящего outbox:
// пригласили → письмо в очереди → приняли → участник появился → повтор по той
// же ссылке отбит.
func TestInvitation_EndToEnd(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)

	r := post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("приглашение: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	// Письмо и токен — одной транзакцией: в outbox лежит ровно одно приглашение.
	var queued int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbox WHERE payload::jsonb->>'template' = 'workspace_invite'`).Scan(&queued); err != nil {
		t.Fatalf("outbox: %v", err)
	}
	if queued != 1 {
		t.Fatalf("писем приглашения в очереди = %d, ожидалось 1", queued)
	}

	token := inviteTokenFromDB(t)

	// Чужой человек по ссылке не входит: звали не его — 403, а не молчаливый вход.
	stranger := registerUser(t, srv, "stranger@example.com")
	r = post(t, stranger, srv, "/api/v1/invitations/"+token+"/accept", "")
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("посторонний по ссылке: статус %d, ожидалось 403", r.StatusCode)
	}
	closeBody(t, r)

	// Приглашённый принимает и видит пространство в своём списке.
	r = post(t, bob, srv, "/api/v1/invitations/"+token+"/accept", "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("принятие: статус %d, ожидалось 200", r.StatusCode)
	}
	closeBody(t, r)

	var got listDTO
	decode(t, do(t, bob, http.MethodGet, srv.URL+"/api/v1/workspaces"), &got)
	if len(got.Workspaces) != 2 {
		t.Fatalf("у приглашённого пространств = %d, ожидалось 2 (личное + команда)", len(got.Workspaces))
	}

	// Повтор по той же ссылке — 410: одноразовость держит атомарный UPDATE.
	r = post(t, bob, srv, "/api/v1/invitations/"+token+"/accept", "")
	if r.StatusCode != http.StatusGone {
		t.Fatalf("повтор по использованной ссылке: статус %d, ожидалось 410", r.StatusCode)
	}
	closeBody(t, r)

	// Второй раз позвать того же — 409: он уже участник, и ждать письма незачем.
	r = post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`)
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("повторное приглашение участника: статус %d, ожидалось 409", r.StatusCode)
	}
	closeBody(t, r)
}

// Приглашать может только владелец: редактор получает 403, и письма не будет.
func TestInvitation_EditorCannotInvite(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	editor := registerUser(t, srv, "editor@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 SELECT $1, id, 'editor' FROM users WHERE email = 'editor@example.com'`, team.ID); err != nil {
		t.Fatalf("добавить редактора: %v", err)
	}

	r := post(t, editor, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"third@example.com","role":"editor"}`)
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("редактор приглашает: статус %d, ожидалось 403", r.StatusCode)
	}
	closeBody(t, r)
}

// Гейт мест: на плане с лимитом в одного участника приглашение отбивается 402.
func TestInvitation_SeatLimit(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	setMemberLimit(t, "1")

	r := post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`)
	if r.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("статус = %d, ожидалось 402 (владелец уже занимает единственное место)", r.StatusCode)
	}
	closeBody(t, r)
}

// Ссылку показывают БЕЗ входа: аккаунта у приглашённого может ещё не быть, и
// понять, куда его зовут, он должен до регистрации.
func TestInvitation_PreviewWithoutAuth(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	closeBody(t, post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"newbie@example.com","role":"editor"}`))

	token := inviteTokenFromDB(t)
	anon := newClient(t) // без сессии вовсе
	r := do(t, anon, http.MethodGet, srv.URL+"/api/v1/invitations/"+token)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("просмотр без входа: статус %d, ожидалось 200", r.StatusCode)
	}
	var inv struct {
		WorkspaceName string `json:"workspaceName"`
		Email         string `json:"email"`
		State         string `json:"state"`
	}
	decode(t, r, &inv)
	if inv.WorkspaceName != "Команда" || inv.Email != "newbie@example.com" || inv.State != "usable" {
		t.Fatalf("приглашение = %+v, ждали Команда/newbie@example.com/usable", inv)
	}
}

// inviteTokenFromDB достаёт сырой токен единственного живого приглашения.
// В БД лежит только его SHA-256, поэтому тест выдаёт себе токен сам: подменяет
// хеш на хеш известной строки. Так проверяется настоящий путь «токен → хеш →
// строка», а не суррогат с токеном в открытом виде.
func inviteTokenFromDB(t *testing.T) string {
	t.Helper()
	const raw = "test-invite-token"
	sum := sha256.Sum256([]byte(raw))
	if _, err := testPool.Exec(context.Background(),
		`UPDATE invitations SET token_hash = $1 WHERE used_at IS NULL`, sum[:]); err != nil {
		t.Fatalf("подменить хеш токена: %v", err)
	}
	return raw
}

func setMemberLimit(t *testing.T, limit string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, '{members_per_workspace}', $1::jsonb) WHERE code = 'free'`,
		limit); err != nil {
		t.Fatalf("set member limit: %v", err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE plans SET limits = jsonb_set(limits, '{members_per_workspace}', 'null') WHERE code = 'free'`); err != nil {
			t.Fatalf("reset member limit: %v", err)
		}
	})
}

// Состав пространства, снятие доступа и краевые случаи — против настоящей БД:
// сторож последнего владельца стоит в самом запросе, и проверять его надо там.
func TestMembers_ListRemoveAndOwnerGuard(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	closeBody(t, post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`))
	closeBody(t, post(t, bob, srv, "/api/v1/invitations/"+inviteTokenFromDB(t)+"/accept", ""))

	// Владелец видит обоих участников и свои права.
	var got membersDTO
	decode(t, do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces/"+team.ID+"/members"), &got)
	if len(got.Members) != 2 || got.Members[0].Role != "owner" {
		t.Fatalf("состав = %+v, ждали двоих с владельцем первым", got.Members)
	}
	if !slices.Contains(got.Permissions, "member.manage") {
		t.Errorf("владельцу не отдано право member.manage: %v", got.Permissions)
	}

	// Редактор состав видит, но управлять им не может.
	var asEditor membersDTO
	decode(t, do(t, bob, http.MethodGet, srv.URL+"/api/v1/workspaces/"+team.ID+"/members"), &asEditor)
	if len(asEditor.Members) != 2 {
		t.Errorf("редактор не видит состав: %+v", asEditor.Members)
	}
	if slices.Contains(asEditor.Permissions, "member.manage") {
		t.Error("редактору отдано право управлять участниками")
	}

	bobID := userIDByEmail(t, "bob@example.com").String()
	aliceID := userIDByEmail(t, "alice@example.com").String()

	// Редактор не снимает доступ никому — 403.
	r := doBody(t, bob, http.MethodDelete, srv.URL+"/api/v1/workspaces/"+team.ID+"/members/"+aliceID, "")
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("редактор снимает доступ владельцу: статус %d, ожидалось 403", r.StatusCode)
	}
	closeBody(t, r)

	// Владельца не снимает даже он сам: пространство без владельца не имеет плана.
	r = del(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/members/"+aliceID)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("владелец снимает себя: статус %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)

	// Владелец не может и выйти — по той же причине.
	r = post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/leave", "")
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("владелец выходит: статус %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)

	// А редактору доступ снимают — и пространство пропадает из его списка.
	r = del(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/members/"+bobID)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("снятие доступа: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	var bobSpaces listDTO
	decode(t, do(t, bob, http.MethodGet, srv.URL+"/api/v1/workspaces"), &bobSpaces)
	if len(bobSpaces.Workspaces) != 1 || !bobSpaces.Workspaces[0].IsPersonal {
		t.Fatalf("у отозванного осталось = %+v, ждали только личное", bobSpaces.Workspaces)
	}

	// И формы пространства ему больше не видны — 404, а не 403.
	r = do(t, bob, http.MethodGet, srv.URL+"/api/v1/workspaces/"+team.ID+"/members")
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("отозванный смотрит состав: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)
}

// Редактор выходит сам — и теряет пространство.
// Профиль участника доезжает до списка: по нему рисуется кружок с картинкой или
// инициалами. Колонки приезжают одним JOIN'ом к users, и перепутанный порядок в
// выборке виден только здесь — типы у всех трёх строковые.
func TestMembers_ProfileReachesList(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")

	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET first_name = $2, last_name = $3, avatar_key = $4 WHERE email = $1`,
		"alice@example.com", "Алиса", "Иванова", "avatars/abc.png"); err != nil {
		t.Fatalf("проставить профиль: %v", err)
	}

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)

	var got membersDTO
	decode(t, do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces/"+team.ID+"/members"), &got)
	if len(got.Members) != 1 {
		t.Fatalf("состав = %+v, ждали одного", got.Members)
	}
	m := got.Members[0]
	if m.FirstName != "Алиса" || m.LastName != "Иванова" || m.AvatarKey != "avatars/abc.png" {
		t.Fatalf("профиль участника = %+v", m)
	}
}

func TestMembers_EditorLeaves(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	closeBody(t, post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`))
	closeBody(t, post(t, bob, srv, "/api/v1/invitations/"+inviteTokenFromDB(t)+"/accept", ""))

	r := post(t, bob, srv, "/api/v1/workspaces/"+team.ID+"/leave", "")
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("выход редактора: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	var bobSpaces listDTO
	decode(t, do(t, bob, http.MethodGet, srv.URL+"/api/v1/workspaces"), &bobSpaces)
	if len(bobSpaces.Workspaces) != 1 {
		t.Fatalf("после выхода осталось %d пространств, ждали одно личное", len(bobSpaces.Workspaces))
	}
}

// Удалённый аккаунт исчезает из чужого пространства целиком: и из состава, и из
// счёта мест. Строка членства переживает пометку (удаление аккаунта — пометка, а
// не снос данных), поэтому слепота обязана быть в запросах — и в списке, и в
// подсчёте квоты, иначе владелец видит непонятную строку и не может позвать
// замену на освободившееся место.
func TestMembers_DeletedAccountLeavesNeitherRowNorSeat(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")
	registerUser(t, srv, "carol@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	closeBody(t, post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`))
	closeBody(t, post(t, bob, srv, "/api/v1/invitations/"+inviteTokenFromDB(t)+"/accept", ""))

	// Мест ровно два, и оба заняты: позвать третьего сейчас нельзя.
	setMemberLimit(t, "2")
	r := post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"carol@example.com","role":"editor"}`)
	if r.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("приглашение при занятых местах: статус %d, ожидалось 402", r.StatusCode)
	}
	closeBody(t, r)

	// Боб удаляет аккаунт. Пометкой напрямую: сам эндпоинт удаления живёт в auth
	// и здесь не зарегистрирован, а проверяем мы следствие пометки, не её саму.
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET deleted_at = now() WHERE email = 'bob@example.com'`); err != nil {
		t.Fatalf("пометить аккаунт удалённым: %v", err)
	}

	var got membersDTO
	decode(t, do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces/"+team.ID+"/members"), &got)
	if len(got.Members) != 1 || got.Members[0].Email != "alice@example.com" {
		t.Fatalf("состав = %+v, ждали одну владелицу — удалённый аккаунт в списке не показывается", got.Members)
	}

	// Место освободилось: замена зовётся на тот же лимит в двоих.
	r = post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"carol@example.com","role":"editor"}`)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("приглашение замены: статус %d, ожидалось 204 — место удалённого аккаунта осталось занятым", r.StatusCode)
	}
	closeBody(t, r)
}

// Приглашать удалённый аккаунт нельзя, и отказ приходит не как «он уже здесь»:
// в составе его нет, и «уже в пространстве» противоречило бы тому, что видно на
// экране. Адрес при этом занят навсегда — письмо просто уходит в никуда.
func TestInvitation_DeletedAccountIsNotAMember(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	closeBody(t, post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`))
	closeBody(t, post(t, bob, srv, "/api/v1/invitations/"+inviteTokenFromDB(t)+"/accept", ""))

	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET deleted_at = now() WHERE email = 'bob@example.com'`); err != nil {
		t.Fatalf("пометить аккаунт удалённым: %v", err)
	}

	r := post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`)
	if r.StatusCode == http.StatusConflict {
		t.Fatal("отказ «он уже в пространстве» про аккаунт, которого в составе не видно")
	}
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("приглашение удалённого адреса: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)
}

// Посторонний «выходит» из чужого пространства — 404: существование не
// раскрывается даже отказом.
func TestMembers_StrangerLeaveIsNotFound(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	stranger := registerUser(t, srv, "stranger@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)

	r := post(t, stranger, srv, "/api/v1/workspaces/"+team.ID+"/leave", "")
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("посторонний выходит: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)
}

type memberDTO struct {
	UserID    string `json:"userId"`
	Email     string `json:"email"`
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	AvatarKey string `json:"avatarKey"`
	Role      string `json:"role"`
}

type membersDTO struct {
	Members     []memberDTO `json:"members"`
	Permissions []string    `json:"permissions"`
}

func del(t *testing.T, c *http.Client, srv *httptest.Server, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, srv.URL+path, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv.URL))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

// Заморозка при даунгрейде против настоящей БД: тариф владельца упал — дополнительное
// пространство закрылось для ВСЕХ его участников, личное осталось доступным.
func TestFreeze_OnOwnerDowngrade(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	closeBody(t, post(t, alice, srv, "/api/v1/workspaces/"+team.ID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`))
	closeBody(t, post(t, bob, srv, "/api/v1/invitations/"+inviteTokenFromDB(t)+"/accept", ""))

	// Пока лимит не включён — пространство работает у обоих.
	for _, c := range []*http.Client{alice, bob} {
		r := do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces/"+team.ID+"/members")
		if r.StatusCode != http.StatusOK {
			t.Fatalf("до даунгрейда: статус %d, ожидалось 200", r.StatusCode)
		}
		closeBody(t, r)
	}

	// Даунгрейд: на плане помещается одно пространство — его занимает личное.
	setWorkspaceLimit(t, "1")

	// Закрылось для обоих: и для владельца, и для приглашённого редактора.
	for name, c := range map[string]*http.Client{"владелец": alice, "редактор": bob} {
		r := do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces/"+team.ID+"/members")
		if r.StatusCode != http.StatusPaymentRequired {
			t.Fatalf("%s после даунгрейда: статус %d, ожидалось 402", name, r.StatusCode)
		}
		closeBody(t, r)
	}

	// Личное пространство владельца открыто как обычно: заморозка его не
	// касается. Проверяется тем же путём через Can — составом участников.
	var spaces listDTO
	decode(t, do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces"), &spaces)
	var personalID string
	for _, w := range spaces.Workspaces {
		if w.IsPersonal {
			personalID = w.ID
		}
	}
	r := do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces/"+personalID+"/members")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("личное пространство после даунгрейда: статус %d, ожидалось 200", r.StatusCode)
	}
	closeBody(t, r)

	// Данные не пропали: и пространство, и членство на месте — вернётся тариф,
	// вернётся доступ.
	var members int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM workspace_members WHERE workspace_id = $1`, team.ID).Scan(&members); err != nil {
		t.Fatalf("count members: %v", err)
	}
	if members != 2 {
		t.Fatalf("участников после заморозки = %d, ждали 2 — никого не выгоняют", members)
	}
}

// Лишние участники замерзают против настоящей БД: ранг считает запрос, и
// владелец в нём всегда первый. Пространство ЛИЧНОЕ — чтобы было видно, что
// заморозка мест работает и там, где заморозка пространств не работает никогда.
func TestFreeze_ExtraMembersInPersonalWorkspace(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	var spaces listDTO
	decode(t, do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces"), &spaces)
	personalID := spaces.Workspaces[0].ID

	closeBody(t, post(t, alice, srv, "/api/v1/workspaces/"+personalID+"/invitations",
		`{"email":"bob@example.com","role":"editor"}`))
	closeBody(t, post(t, bob, srv, "/api/v1/invitations/"+inviteTokenFromDB(t)+"/accept", ""))

	// Пока мест хватает — работают оба.
	for name, c := range map[string]*http.Client{"владелец": alice, "приглашённый": bob} {
		r := do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces/"+personalID+"/members")
		if r.StatusCode != http.StatusOK {
			t.Fatalf("%s до даунгрейда: статус %d, ожидалось 200", name, r.StatusCode)
		}
		closeBody(t, r)
	}

	// Даунгрейд: одно место — его занимает владелец.
	setMemberLimit(t, "1")

	r := do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces/"+personalID+"/members")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("владелец после даунгрейда: статус %d — его нельзя отрезать от своих форм", r.StatusCode)
	}
	closeBody(t, r)

	r = do(t, bob, http.MethodGet, srv.URL+"/api/v1/workspaces/"+personalID+"/members")
	if r.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("лишний участник после даунгрейда: статус %d, ожидалось 402", r.StatusCode)
	}
	closeBody(t, r)

	// Никого не выгнало: вернётся тариф — вернутся все.
	var members int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM workspace_members WHERE workspace_id = $1`, personalID).Scan(&members); err != nil {
		t.Fatalf("count members: %v", err)
	}
	if members != 2 {
		t.Fatalf("участников = %d, ждали 2 — заморозка не удаляет членство", members)
	}
}

// Переименование: владелец правит вывеску, редактор — нет (403), и отказ ничего
// не меняет. Пространство адресуется id, но право даёт роль, а не знание адреса.
func TestRenameWorkspace_OwnerRenamesEditorCannot(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 SELECT $1, id, 'editor' FROM users WHERE email = 'bob@example.com'`, team.ID); err != nil {
		t.Fatalf("добавить участника: %v", err)
	}

	var renamed workspaceDTO
	decode(t, patch(t, alice, srv, "/api/v1/workspaces/"+team.ID, `{"name":"  Отдел маркетинга  "}`), &renamed)
	if renamed.Name != "Отдел маркетинга" {
		t.Errorf("имя = %q, ждали обрезанное «Отдел маркетинга»", renamed.Name)
	}

	bob := loginUser(t, srv, "bob@example.com")
	r := patch(t, bob, srv, "/api/v1/workspaces/"+team.ID, `{"name":"Бобово"}`)
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("статус у редактора = %d, ожидалось 403", r.StatusCode)
	}
	closeBody(t, r)

	var got listDTO
	decode(t, do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces"), &got)
	if got.Workspaces[1].Name != "Отдел маркетинга" {
		t.Errorf("в списке имя = %q, ждали «Отдел маркетинга»", got.Workspaces[1].Name)
	}
}

// Без CSRF-заголовка переименование не проходит (инвариант: мутация за RequireCSRF).
func TestRenameWorkspace_RequiresCSRF(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	var got listDTO
	decode(t, do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces"), &got)
	r := doBody(t, c, http.MethodPatch, srv.URL+"/api/v1/workspaces/"+got.Workspaces[0].ID, `{"name":"Другое"}`)
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("статус = %d, ожидалось 403 (нет CSRF-заголовка)", r.StatusCode)
	}
	closeBody(t, r)
}

// Чужому пространство не переименовать и не подтвердить его существование:
// не участник получает 404, а не 403 (инвариант безопасности 5).
func TestRenameWorkspace_StrangerGetsNotFound(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)

	bob := loginUser(t, srv, "bob@example.com")
	r := patch(t, bob, srv, "/api/v1/workspaces/"+team.ID, `{"name":"Бобово"}`)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("статус = %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)
}

// formCount в списке считает формы своего пространства и только их: подпись
// рядом с названием в обзоре кабинета берётся отсюда.
func TestWorkspaces_FormCountInList(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	var before listDTO
	decode(t, do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces"), &before)
	personalID := before.Workspaces[0].ID
	if before.Workspaces[0].FormCount != 0 {
		t.Fatalf("у нового аккаунта форм = %d, ждали 0", before.Workspaces[0].FormCount)
	}

	var team workspaceDTO
	decode(t, post(t, c, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	for i, ws := range []string{personalID, personalID, team.ID} {
		if _, err := testPool.Exec(context.Background(),
			`INSERT INTO forms (id, workspace_id, slug) VALUES ($1, $2, $3)`,
			uuid.New(), ws, "slug"+strconv.Itoa(i)); err != nil {
			t.Fatalf("вставить форму: %v", err)
		}
	}

	var got listDTO
	decode(t, do(t, c, http.MethodGet, srv.URL+"/api/v1/workspaces"), &got)
	if got.Workspaces[0].FormCount != 2 || got.Workspaces[1].FormCount != 1 {
		t.Errorf("формы = %d и %d, ждали 2 (личное) и 1 (команда)",
			got.Workspaces[0].FormCount, got.Workspaces[1].FormCount)
	}
}

// Удаление пространства уносит его формы каскадом и убирает его из списка.
// Редактор удалять не может, личное не удаляется вовсе.
func TestDeleteWorkspace_CascadesAndRefusesPersonal(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 SELECT $1, id, 'editor' FROM users WHERE email = 'bob@example.com'`, team.ID); err != nil {
		t.Fatalf("добавить участника: %v", err)
	}
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO forms (id, workspace_id, slug) VALUES ($1, $2, 'del-1')`,
		uuid.New(), team.ID); err != nil {
		t.Fatalf("вставить форму: %v", err)
	}

	// Редактору нельзя: пространство остаётся на месте.
	bob := loginUser(t, srv, "bob@example.com")
	r := del(t, bob, srv, "/api/v1/workspaces/"+team.ID)
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("статус у редактора = %d, ожидалось 403", r.StatusCode)
	}
	closeBody(t, r)

	// Личное не удаляется — 422, а не молчаливое «удалено».
	var list listDTO
	decode(t, do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces"), &list)
	r = del(t, alice, srv, "/api/v1/workspaces/"+list.Workspaces[0].ID)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус на личном = %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)

	// Владелец сносит командное — вместе с формами.
	r = del(t, alice, srv, "/api/v1/workspaces/"+team.ID)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("статус = %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)

	var after listDTO
	decode(t, do(t, alice, http.MethodGet, srv.URL+"/api/v1/workspaces"), &after)
	if len(after.Workspaces) != 1 || !after.Workspaces[0].IsPersonal {
		t.Fatalf("после удаления осталось %+v, ждали одно личное", after.Workspaces)
	}
	var forms int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM forms WHERE workspace_id = $1`, team.ID).Scan(&forms); err != nil {
		t.Fatalf("count forms: %v", err)
	}
	if forms != 0 {
		t.Errorf("форм осталось %d — каскад не сработал", forms)
	}
}

// Чужому пространству не подтверждают даже существования: не участник получает
// 404, а не 403 (инвариант безопасности 5).
func TestDeleteWorkspace_StrangerGetsNotFound(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	registerUser(t, srv, "bob@example.com")

	var team workspaceDTO
	decode(t, post(t, alice, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)

	bob := loginUser(t, srv, "bob@example.com")
	r := del(t, bob, srv, "/api/v1/workspaces/"+team.ID)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("статус = %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)
}

// Без CSRF-заголовка снос не проходит.
func TestDeleteWorkspace_RequiresCSRF(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	var team workspaceDTO
	decode(t, post(t, c, srv, "/api/v1/workspaces", `{"name":"Команда"}`), &team)

	r := doBody(t, c, http.MethodDelete, srv.URL+"/api/v1/workspaces/"+team.ID, "")
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("статус = %d, ожидалось 403 (нет CSRF-заголовка)", r.StatusCode)
	}
	closeBody(t, r)
}
