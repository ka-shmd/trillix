//go:build integration

// Лента уведомлений через HTTP: сессия, сторож членства и отметка прочтения.
// Кабинетные ручки проверяются именно так (эталон — listing_integration_test
// модуля submissions): настоящий auth, настоящая кука, настоящий CSRF.
package notify_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/notify"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// feedStack — auth плюс лента уведомлений. Лимитеры пермиссивные (инвариант 6).
func feedStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{},
		pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173")
	h := notify.NewHandler(notify.NewService(testPool, notify.Repo{}, wsSvc), authH.RequireAuth, authH.RequireCSRF)

	mux := http.NewServeMux()
	authH.Routes(mux)
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// registered регистрирует пользователя по HTTP и отдаёт клиента с его сессией.
func registered(t *testing.T, srv *httptest.Server, email string) (*http.Client, uuid.UUID) {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	c := &http.Client{Jar: jar}
	resp, err := c.Post(srv.URL+"/api/v1/auth/register", "application/json",
		strings.NewReader(`{"email":"`+email+`","password":"supersecret1"}`))
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: статус %d, ожидалось 201", resp.StatusCode)
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode register: %v", err)
	}
	return c, uuid.MustParse(body.ID)
}

func csrfToken(t *testing.T, c *http.Client, base string) string {
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
	t.Fatal("в куках нет csrf_token")
	return ""
}

type feedBody struct {
	Items []struct {
		ID            uuid.UUID `json:"id"`
		WorkspaceName string    `json:"workspaceName"`
		WorkspaceSlug string    `json:"workspaceSlug"`
		Kind          string    `json:"kind"`
		Text          string    `json:"text"`
		Link          string    `json:"link"`
		Count         int32     `json:"count"`
		Read          bool      `json:"read"`
	} `json:"items"`
	Unread     int64  `json:"unread"`
	NextCursor string `json:"nextCursor"`
}

func getFeed(t *testing.T, c *http.Client, srv *httptest.Server, query string) feedBody {
	t.Helper()
	resp, err := c.Get(srv.URL + "/api/v1/notifications" + query)
	if err != nil {
		t.Fatalf("GET ленты: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET ленты: статус %d, ожидалось 200", resp.StatusCode)
	}
	var body feedBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode ленты: %v", err)
	}
	return body
}

func postRead(t *testing.T, c *http.Client, srv *httptest.Server, payload string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/notifications/read", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrfToken(t, c, srv.URL))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("POST отметки: %v", err)
	}
	return resp
}

// raise ставит повод о новых ответах пользователю напрямую: тест про ленту, а не
// про приём ответа.
func raise(t *testing.T, user, workspace, form uuid.UUID, title, slug string) {
	t.Helper()
	svc := notify.NewService(testPool, notify.Repo{}, fixedAccess{users: []uuid.UUID{user}})
	err := svc.Notify(context.Background(), testPool, notify.Event{
		WorkspaceID: workspace, Kind: notify.KindNewSubmissions, FormID: form, SubjectID: form,
		Payload: notify.Payload{FormTitle: title, FormSlug: slug},
	})
	if err != nil {
		t.Fatalf("постановка повода: %v", err)
	}
}

// workspaceOf — личное пространство пользователя (его заводит регистрация).
func workspaceOf(t *testing.T, user uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := testPool.QueryRow(context.Background(),
		`SELECT workspace_id FROM workspace_members WHERE user_id = $1`, user).Scan(&id)
	if err != nil {
		t.Fatalf("пространство пользователя: %v", err)
	}
	return id
}

// formIn заводит форму в пространстве: поводу нужна цель каскада и адрес ссылки.
func formIn(t *testing.T, workspace uuid.UUID, title, slug string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO forms (id, workspace_id, title, slug) VALUES ($1, $2, $3, $4)`,
		id, workspace, title, slug)
	if err != nil {
		t.Fatalf("insert form: %v", err)
	}
	return id
}

// Лента отдаёт готовые к показу строки: текст и ссылку собрал реестр на сервере,
// а не экран.
func TestFeedHTTP_ReturnsRenderedItems(t *testing.T) {
	resetDB(t)
	srv := feedStack(t)
	c, user := registered(t, srv, "feed@example.com")
	ws := workspaceOf(t, user)
	form := formIn(t, ws, "Заявка", "zayavka")
	raise(t, user, ws, form, "Заявка", "zayavka")
	raise(t, user, ws, form, "Заявка", "zayavka")

	body := getFeed(t, c, srv, "")
	if len(body.Items) != 1 {
		t.Fatalf("строк %d, ожидалась одна склеенная", len(body.Items))
	}
	it := body.Items[0]
	if it.Text != "Заявка — 2 новых ответа" {
		t.Errorf("текст = %q", it.Text)
	}
	if it.Link != "/forms/zayavka/submissions" {
		t.Errorf("ссылка = %q", it.Link)
	}
	if it.Kind != "new_submissions" || it.Count != 2 || it.Read {
		t.Errorf("строка = %+v", it)
	}
	if it.WorkspaceSlug == "" || it.WorkspaceName == "" {
		t.Errorf("пространство строки пусто: %+v", it)
	}
	if body.Unread != 1 {
		t.Errorf("непрочитанных %d, ожидалась одна", body.Unread)
	}
}

// Чужая лента невидима: отбор идёт по спрашивающему.
func TestFeedHTTP_ShowsOnlyOwnRows(t *testing.T) {
	resetDB(t)
	srv := feedStack(t)
	_, owner := registered(t, srv, "owner@example.com")
	stranger, _ := registered(t, srv, "stranger@example.com")
	ws := workspaceOf(t, owner)
	form := formIn(t, ws, "Заявка", "zayavka")
	raise(t, owner, ws, form, "Заявка", "zayavka")

	if body := getFeed(t, stranger, srv, ""); len(body.Items) != 0 || body.Unread != 0 {
		t.Fatalf("посторонний видит чужую ленту: %+v", body)
	}
}

// Без сессии ручка не отвечает ничем, кроме 401.
func TestFeedHTTP_RequiresSession(t *testing.T) {
	resetDB(t)
	srv := feedStack(t)

	resp, err := http.Get(srv.URL + "/api/v1/notifications")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("статус %d, ожидалось 401", resp.StatusCode)
	}
}

// Отметка прочтения: названные строки гаснут, счётчик падает.
func TestRead_MarksNamedRows(t *testing.T) {
	resetDB(t)
	srv := feedStack(t)
	c, user := registered(t, srv, "reader@example.com")
	ws := workspaceOf(t, user)
	first := formIn(t, ws, "Первая", "first")
	second := formIn(t, ws, "Вторая", "second")
	raise(t, user, ws, first, "Первая", "first")
	raise(t, user, ws, second, "Вторая", "second")

	body := getFeed(t, c, srv, "")
	if body.Unread != 2 {
		t.Fatalf("непрочитанных %d, ожидалось 2", body.Unread)
	}
	resp := postRead(t, c, srv, `{"ids":["`+body.Items[0].ID.String()+`"]}`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("отметка: статус %d, ожидалось 204", resp.StatusCode)
	}

	after := getFeed(t, c, srv, "")
	if after.Unread != 1 {
		t.Errorf("непрочитанных %d, ожидалась одна", after.Unread)
	}
	// Прочитанная строка из ленты не исчезает — исчезает её непрочитанность.
	if len(after.Items) != 2 {
		t.Errorf("строк %d, ожидалось 2", len(after.Items))
	}
}

// «Прочитать всё» гасит ленту целиком.
func TestRead_All(t *testing.T) {
	resetDB(t)
	srv := feedStack(t)
	c, user := registered(t, srv, "allreader@example.com")
	ws := workspaceOf(t, user)
	raise(t, user, ws, formIn(t, ws, "Первая", "first"), "Первая", "first")
	raise(t, user, ws, formIn(t, ws, "Вторая", "second"), "Вторая", "second")

	resp := postRead(t, c, srv, `{"all":true}`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("отметка: статус %d, ожидалось 204", resp.StatusCode)
	}
	if body := getFeed(t, c, srv, ""); body.Unread != 0 {
		t.Errorf("непрочитанных %d, ожидался ноль", body.Unread)
	}
}

// Чужой id не гасит чужую строку и не отвечает 404: ответ «такая строка есть, но
// не ваша» сам по себе был бы утечкой.
func TestRead_AlienIDDoesNothing(t *testing.T) {
	resetDB(t)
	srv := feedStack(t)
	victim, victimID := registered(t, srv, "victim@example.com")
	attacker, _ := registered(t, srv, "attacker@example.com")
	ws := workspaceOf(t, victimID)
	raise(t, victimID, ws, formIn(t, ws, "Заявка", "zayavka"), "Заявка", "zayavka")

	body := getFeed(t, victim, srv, "")
	resp := postRead(t, attacker, srv, `{"ids":["`+body.Items[0].ID.String()+`"]}`)
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("статус %d, ожидалось 204 (ничего не нашлось — не ошибка)", resp.StatusCode)
	}
	if after := getFeed(t, victim, srv, ""); after.Unread != 1 {
		t.Errorf("чужая отметка погасила строку владельца: %+v", after)
	}
}

// Отметка — изменяющая операция, поэтому за CSRF: без токена она не проходит.
func TestRead_RequiresCSRF(t *testing.T) {
	resetDB(t)
	srv := feedStack(t)
	c, _ := registered(t, srv, "csrf@example.com")

	resp, err := c.Post(srv.URL+"/api/v1/notifications/read", "application/json", strings.NewReader(`{"all":true}`))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNoContent {
		t.Fatal("отметка без CSRF-токена прошла")
	}
}

// Курсор листает ленту: страница берётся с запасом в строку, и по ней виден
// следующий кусок.
func TestFeedHTTP_Pagination(t *testing.T) {
	resetDB(t)
	srv := feedStack(t)
	c, user := registered(t, srv, "pager@example.com")
	ws := workspaceOf(t, user)
	for _, name := range []string{"a", "b", "c"} {
		raise(t, user, ws, formIn(t, ws, name, name), name, name)
	}

	first := getFeed(t, c, srv, "?limit=2")
	if len(first.Items) != 2 || first.NextCursor == "" {
		t.Fatalf("первая страница = %+v", first)
	}
	second := getFeed(t, c, srv, "?limit=2&cursor="+first.NextCursor)
	if len(second.Items) != 1 || second.NextCursor != "" {
		t.Fatalf("вторая страница = %+v", second)
	}
}
