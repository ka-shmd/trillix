//go:build integration

package answerfiles_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/ka-shmd/trillix/internal/answerfiles"
	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/token"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

var testSecret = []byte("dev-only-form-token-secret-not-a-real-key")

// freshToken — токен возрастом 5 секунд: прошёл минимальное время заполнения и не
// просрочен. Так же, как в тестах приёма ответа, — sleep в тестах запрещён.
func freshToken() string { return token.Issue(testSecret, time.Now().Add(-5*time.Second)) }

func startMinIO(ctx context.Context) (endpoint string, stop func(), err error) {
	req := testcontainers.ContainerRequest{
		Image:        "minio/minio:RELEASE.2024-01-16T16-07-38Z",
		Cmd:          []string{"server", "/data"},
		Env:          map[string]string{"MINIO_ROOT_USER": "minioadmin", "MINIO_ROOT_PASSWORD": "minioadmin"},
		ExposedPorts: []string{"9000/tcp"},
		WaitingFor:   wait.ForHTTP("/minio/health/live").WithPort("9000/tcp").WithStartupTimeout(60 * time.Second),
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{ContainerRequest: req, Started: true})
	if err != nil {
		return "", nil, err
	}
	stop = func() { _ = testcontainers.TerminateContainer(c) }
	host, err := c.Host(ctx)
	if err != nil {
		stop()
		return "", nil, err
	}
	port, err := c.MappedPort(ctx, "9000")
	if err != nil {
		stop()
		return "", nil, err
	}
	return fmt.Sprintf("http://%s:%s", host, port.Port()), stop, nil
}

func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, form_versions, submissions, submission_files CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack собирает реальную вертикаль auth+forms+answerfiles+submissions поверх
// контейнерных Postgres и MinIO. Лимитеры пермиссивные (инвариант 6: лимит ради
// тестов не ослабляется, а подменяется реализацией).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	entSvc := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
		entSvc, pgtest.MailService(testPool), "http://localhost:5173")
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{}, wsSvc, entSvc)
	formsH := forms.NewHandler(formsSvc, authH.RequireAuth, authH.RequireCSRF)

	filesSvc := answerfiles.NewService(testPool, answerfiles.Repo{},
		answerfiles.NewBucket(blob.New(testS3), filesBucket), formsSvc, entSvc)
	filesPublic := answerfiles.NewPublicHandler(filesSvc, ratelimit.AllowAll{}, testSecret,
		submissions.DefaultMinFillTime, false)

	subSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc,
		noopVisits{}, pgtest.MailService(testPool), entSvc, submissions.Repo{}, "http://localhost:5173").
		WithFiles(filesSvc)
	subPublic := submissions.NewPublicHandler(subSvc, ratelimit.AllowAll{}, testSecret,
		submissions.DefaultMinFillTime, false)

	mux := http.NewServeMux()
	authH.Routes(mux)
	formsH.Routes(mux)
	filesPublic.Routes(mux)
	subPublic.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// noopVisits — конверсия визита к файлам отношения не имеет, а поднимать ради неё
// ещё один модуль значит проверять не то, что заявлено тестом.
type noopVisits struct{}

func (noopVisits) MarkSubmitted(context.Context, uuid.UUID, uuid.UUID) error { return nil }

func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	return &http.Client{Jar: jar}
}

func registerUser(t *testing.T, srv *httptest.Server, email string) *http.Client {
	t.Helper()
	c := newClient(t)
	r, err := c.Post(srv.URL+"/api/v1/auth/register", "application/json",
		bytes.NewReader([]byte(`{"email":"`+email+`","password":"supersecret1"}`)))
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: статус %d, ожидался 201", email, r.StatusCode)
	}
	_ = r.Body.Close()
	return c
}

func csrf(t *testing.T, c *http.Client, srv *httptest.Server) string {
	t.Helper()
	u, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	for _, ck := range c.Jar.Cookies(u.URL) {
		if ck.Name == "csrf_token" {
			return ck.Value
		}
	}
	t.Fatal("csrf_token cookie не выдан")
	return ""
}

func doJSON(t *testing.T, c *http.Client, srv *httptest.Server, method, path, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv))
	r, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return r
}

// publishFileForm заводит форму с вопросом-файлом и публикует её; возвращает slug.
func publishFileForm(t *testing.T, c *http.Client, srv *httptest.Server) string {
	t.Helper()
	r := doJSON(t, c, srv, http.MethodPost, "/api/v1/forms", `{}`)
	var created struct {
		ID        string    `json:"id"`
		Slug      string    `json:"slug"`
		UpdatedAt time.Time `json:"updatedAt"`
	}
	decodeInto(t, r, http.StatusCreated, &created)

	patch, _ := json.Marshal(map[string]any{
		"draftSchema": json.RawMessage(fileFormSchema),
		"updatedAt":   created.UpdatedAt,
	})
	r = doJSON(t, c, srv, http.MethodPatch, "/api/v1/forms/"+created.ID, string(patch))
	decodeInto(t, r, http.StatusOK, &struct{}{})

	r = doJSON(t, c, srv, http.MethodPost, "/api/v1/forms/"+created.ID+"/publish", `{}`)
	decodeInto(t, r, http.StatusOK, &struct{}{})
	return created.Slug
}

func decodeInto(t *testing.T, r *http.Response, want int, out any) {
	t.Helper()
	defer func() { _ = r.Body.Close() }()
	if r.StatusCode != want {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(r.Body)
		t.Fatalf("статус %d, ожидался %d: %s", r.StatusCode, want, buf.String())
	}
	if out != nil {
		_ = json.NewDecoder(r.Body).Decode(out)
	}
}

type slotBody struct {
	Token       string `json:"token"`
	BlockID     string `json:"block_id"`
	FileName    string `json:"file_name"`
	SizeBytes   int64  `json:"size_bytes"`
	ContentType string `json:"content_type"`
}

type slotResult struct {
	UploadID    string `json:"upload_id"`
	URL         string `json:"url"`
	ContentType string `json:"content_type"`
	ExpiresIn   int    `json:"expires_in"`
}

func issueSlotRaw(t *testing.T, srv *httptest.Server, slug string, body slotBody) *http.Response {
	t.Helper()
	payload, _ := json.Marshal(body)
	r, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/uploads", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("issue slot: %v", err)
	}
	return r
}

func issueSlot(t *testing.T, srv *httptest.Server, slug string, body slotBody) slotResult {
	t.Helper()
	var out slotResult
	decodeInto(t, issueSlotRaw(t, srv, slug, body), http.StatusOK, &out)
	return out
}

// putObject кладёт байты по выданной подписи — тем же путём, что браузер: мимо
// нашего процесса, прямо в хранилище.
func putObject(t *testing.T, url string, body []byte, contentType string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = int64(len(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put object: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		t.Fatalf("put object: статус %d: %s", resp.StatusCode, buf.String())
	}
}

func submitAnswer(t *testing.T, srv *httptest.Server, slug, tok string, answers map[string]any, want int) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"submission_id": uuid.Must(uuid.NewV7()).String(),
		"token":         tok,
		"answers":       answers,
		"website":       "",
		"visit_id":      "",
	})
	r, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/submissions", "application/json", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	decodeInto(t, r, want, nil)
}
