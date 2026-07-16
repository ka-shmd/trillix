//go:build integration

// Интеграционный тест приёма ответов против настоящего Postgres: сквозная вертикаль
// «создать → опубликовать → отправить ответ → проверить БД». Сетап формы идёт через
// сервисы напрямую (быстрее и без HTTP-обвязки auth), а сам публичный эндпоинт приёма
// — через HTTP, как его увидит рендерер. Живая документация DoD фазы 5.
package submissions_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/forms"
	"github.com/ka-shmd/trierra/internal/pgtest"
	"github.com/ka-shmd/trierra/internal/postgres"
	"github.com/ka-shmd/trierra/internal/ratelimit"
	"github.com/ka-shmd/trierra/internal/submissions"
	"github.com/ka-shmd/trierra/internal/token"
)

var (
	testPool   *pgxpool.Pool
	testSecret = []byte("dev-only-form-token-secret-not-a-real-key")
)

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
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, form_versions, submissions CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newServer поднимает публичный эндпоинт приёма поверх реального сервиса и пула.
// Лимитер пермиссивный (инвариант 6).
func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})
	subSvc := submissions.NewService(testPool, formsSvc, submissions.Repo{})
	h := submissions.NewPublicHandler(subSvc, ratelimit.AllowAll{}, testSecret, submissions.DefaultMinFillTime, submissions.DefaultMaxTokenAge, false)

	mux := http.NewServeMux()
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// publishedForm создаёт пользователя и форму с одним обязательным полем b1, публикует
// её и возвращает slug и id опубликованной версии.
func publishedForm(t *testing.T, schema string) (slug string, versionID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, time.Hour)
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})

	user, _, err := authSvc.Register(ctx, "resp-"+uuid.NewString()[:8]+"@example.com", "supersecret1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	form, err := formsSvc.Create(ctx, user.ID, "Анкета")
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, user.ID, form.ID, json.RawMessage(schema), form.UpdatedAt); err != nil {
		t.Fatalf("save schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, user.ID, form.ID); err != nil {
		t.Fatalf("publish: %v", err)
	}
	pf, err := formsSvc.PublicForm(ctx, form.Slug)
	if err != nil {
		t.Fatalf("resolve published: %v", err)
	}
	return form.Slug, pf.VersionID
}

func freshToken() string { return token.Issue(testSecret, time.Now().Add(-5*time.Second)) }

func postSubmission(t *testing.T, srv *httptest.Server, slug, body string) *http.Response {
	t.Helper()
	resp, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/submissions", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post submission: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func countSubmissions(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM submissions`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

const requiredNameSchema = `{"blocks":[{"id":"b1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}}]}`

// Сквозной успех: валидный ответ ложится в БД с id опубликованной версии.
func TestSubmit_EndToEnd_StoresAnswerWithVersion(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, versionID := publishedForm(t, requiredNameSchema)

	subID := uuid.NewString()
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	resp := postSubmission(t, srv, slug, body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}

	var gotVersion uuid.UUID
	var answers []byte
	err := testPool.QueryRow(context.Background(),
		`SELECT form_version_id, answers FROM submissions WHERE id = $1`, subID).Scan(&gotVersion, &answers)
	if err != nil {
		t.Fatalf("read submission: %v", err)
	}
	if gotVersion != versionID {
		t.Fatalf("form_version_id = %s, ожидался id опубликованной версии %s", gotVersion, versionID)
	}
	var parsed map[string]any
	if err := json.Unmarshal(answers, &parsed); err != nil || parsed["b1"] != "Анна" {
		t.Fatalf("answers в БД неожиданны: %s (err %v)", answers, err)
	}
}

// Идемпотентность: повтор с тем же submission_id (ретрай после сбоя сети) не создаёт
// второй строки — оба ответа успешны.
func TestSubmit_Idempotent_NoDuplicate(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)

	subID := uuid.NewString()
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	for i := 0; i < 2; i++ {
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("отправка #%d: статус %d, ожидалось 201", i+1, resp.StatusCode)
		}
	}
	if n := countSubmissions(t); n != 1 {
		t.Fatalf("в БД %d строк, ожидалась ровно одна (идемпотентность)", n)
	}
}

// Невалидный ответ (пропущено обязательное поле) → 422, в БД ничего.
func TestSubmit_InvalidAnswer_422NoInsert(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{}}`
	resp := postSubmission(t, srv, slug, body)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422", resp.StatusCode)
	}
	var env struct {
		Error struct {
			Fields map[string]string `json:"fields"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil || env.Error.Fields["b1"] == "" {
		t.Fatalf("ожидалась карта полей с b1, тело/ошибка: %v", err)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("невалидный ответ не должен писаться, в БД %d строк", n)
	}
}

// Honeypot: заполненное скрытое поле → молчаливый 200, в БД ничего.
func TestSubmit_Honeypot_NoInsert(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() +
		`","answers":{"b1":"Анна"},"website":"http://spam.example"}`
	resp := postSubmission(t, srv, slug, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200 (молчаливый honeypot)", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("honeypot-ответ не должен писаться, в БД %d строк", n)
	}
}

// Ответ на закрытую/несуществующую форму → 404 (приватное не раскрывается).
func TestSubmit_UnknownSlug_404(t *testing.T) {
	resetDB(t)
	srv := newServer(t)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{}}`
	resp := postSubmission(t, srv, "nope", body)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404", resp.StatusCode)
	}
}
