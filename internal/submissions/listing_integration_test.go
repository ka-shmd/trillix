//go:build integration

// Интеграционный тест приватного листинга ответов против настоящего Postgres:
// вертикаль «опубликовать → принять N ответов → пролистать в кабинете». Упор на
// демо-критерий фазы 6 (новые сверху), корректность курсорной пагинации на границах
// страниц (без дублей и потерь), общий счётчик и анти-IDOR (чужая форма → 404).
package submissions_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/forms"
	"github.com/ka-shmd/trierra/internal/postgres"
	"github.com/ka-shmd/trierra/internal/ratelimit"
	"github.com/ka-shmd/trierra/internal/submissions"
)

// fullStack поднимает auth + приватный листинг + публичный приём поверх контейнерного
// пула. Лимитеры пермиссивные (инвариант 6).
func fullStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, time.Hour)
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})
	subSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, submissions.Repo{})
	subPublic := submissions.NewPublicHandler(subSvc, ratelimit.AllowAll{}, testSecret, submissions.DefaultMinFillTime, false)
	subPrivate := submissions.NewHandler(subSvc, authH.RequireAuth, authH.RequireCSRF)

	mux := http.NewServeMux()
	authH.Routes(mux)
	subPublic.Routes(mux)
	subPrivate.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// authedClient регистрирует пользователя по HTTP и возвращает клиента с его сессией
// и его id (для создания формы под этим пользователем).
func authedClient(t *testing.T, srv *httptest.Server, email string) (*http.Client, uuid.UUID) {
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
	id, err := uuid.Parse(body.ID)
	if err != nil {
		t.Fatalf("parse user id: %v", err)
	}
	return c, id
}

// publishFormFor создаёт и публикует форму schema под пользователем userID; возвращает
// её slug. В отличие от publishedForm, владелец — переданный пользователь (нужно, чтобы
// HTTP-клиент из authedClient имел право листать её ответы).
func publishFormFor(t *testing.T, userID uuid.UUID, schema string) string {
	t.Helper()
	ctx := context.Background()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})
	form, err := formsSvc.Create(ctx, userID, "Анкета")
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, userID, form.ID, json.RawMessage(schema), form.UpdatedAt); err != nil {
		t.Fatalf("save schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, userID, form.ID); err != nil {
		t.Fatalf("publish: %v", err)
	}
	return form.Slug
}

// submitN отправляет n ответов на форму slug с UUIDv7-id (как рендерер: монотонны по
// времени → ORDER BY id DESC = хронология). Возвращает id в порядке отправки.
func submitN(t *testing.T, srv *httptest.Server, slug string, n int) []uuid.UUID {
	t.Helper()
	ids := make([]uuid.UUID, n)
	for i := range ids {
		id := domain.NewID()
		ids[i] = id
		body := `{"submission_id":"` + id.String() + `","token":"` + freshToken() + `","answers":{"b1":"Ответ"}}`
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("submit #%d: статус %d, ожидалось 201", i, resp.StatusCode)
		}
	}
	return ids
}

type listResp struct {
	Submissions []struct {
		ID          string          `json:"id"`
		FormVersion int32           `json:"formVersion"`
		Answers     json.RawMessage `json:"answers"`
	} `json:"submissions"`
	NextCursor *string `json:"nextCursor"`
	Total      int64   `json:"total"`
}

func getList(t *testing.T, c *http.Client, srv *httptest.Server, formID, cursor string) listResp {
	t.Helper()
	u := srv.URL + "/api/v1/forms/" + formID + "/submissions?limit=2"
	if cursor != "" {
		u += "&cursor=" + cursor
	}
	resp, err := c.Get(u)
	if err != nil {
		t.Fatalf("get list: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get list: статус %d, ожидалось 200", resp.StatusCode)
	}
	var out listResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	return out
}

// formID достаёт id формы владельца по slug (тест публикует форму через сервис,
// который slug знает, а HTTP-листинг адресуется по id).
func formIDBySlug(t *testing.T, slug string) string {
	t.Helper()
	var id uuid.UUID
	if err := testPool.QueryRow(context.Background(), `SELECT id FROM forms WHERE slug = $1`, slug).Scan(&id); err != nil {
		t.Fatalf("form id by slug: %v", err)
	}
	return id.String()
}

// Демо-критерий фазы: пять ответов листаются страницами по 2, новые сверху, без
// дублей и потерь на границах; total = 5 на каждой странице; версия формы у каждого.
func TestListSubmissions_Pagination(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)

	sent := submitN(t, srv, slug, 5) // порядок отправки; «новые сверху» = обратный

	var got []string
	cursor := ""
	for pages := 0; ; pages++ {
		if pages > 10 {
			t.Fatal("пагинация не сходится (защита от бесконечного цикла)")
		}
		page := getList(t, owner, srv, fid, cursor)
		if page.Total != 5 {
			t.Fatalf("total = %d, ожидалось 5", page.Total)
		}
		for _, s := range page.Submissions {
			got = append(got, s.ID)
			if s.FormVersion != 1 {
				t.Fatalf("formVersion = %d, ожидалась 1", s.FormVersion)
			}
		}
		if page.NextCursor == nil {
			break
		}
		if len(page.Submissions) != 2 {
			t.Fatalf("непоследняя страница вернула %d строк, ожидалось 2 (limit)", len(page.Submissions))
		}
		cursor = *page.NextCursor
	}

	// Ожидаемый порядок: обратный порядку отправки (новые сверху).
	want := make([]string, len(sent))
	for i, id := range sent {
		want[len(sent)-1-i] = id.String()
	}
	if len(got) != len(want) {
		t.Fatalf("получено %d ответов, ожидалось %d (дубли/потери на границах)", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("порядок разошёлся на позиции %d: получен %s, ожидался %s", i, got[i], want[i])
		}
	}
}

// Анти-IDOR: чужой пользователь получает 404 на форму, где он не член воркспейса —
// существование формы и её ответов не раскрывается.
func TestListSubmissions_ForeignForm_404(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	slug, _ := publishedForm(t, requiredNameSchema) // владелец — внутренний пользователь helper'а
	fid := formIDBySlug(t, slug)
	submitN(t, srv, slug, 1)

	attacker, _ := authedClient(t, srv, "attacker-"+uuid.NewString()[:8]+"@example.com")
	resp, err := attacker.Get(srv.URL + "/api/v1/forms/" + fid + "/submissions")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("чужая форма: статус %d, ожидалось 404", resp.StatusCode)
	}
}
