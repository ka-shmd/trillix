//go:build integration

// Интеграционный тест эндпоинта media против настоящих Postgres и MinIO (PROCESS
// §3: каждый эндпоинт покрыт тестом). Реальная вертикаль auth+forms+media: автор
// загружает картинку в свою форму, чужой — получает 404 (изоляция воркспейсов).
package media_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/media"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

const testBucket = "app-media"

var (
	testPool *pgxpool.Pool
	testS3   blob.Config
)

func TestMain(m *testing.M) {
	ctx := context.Background()

	pool, stopPG, err := pgtest.Start(ctx)
	if err != nil {
		panic(err)
	}
	testPool = pool

	endpoint, stopMinio, err := startMinIO(ctx)
	if err != nil {
		stopPG()
		panic(err)
	}
	testS3 = blob.Config{
		Endpoint:  endpoint,
		Region:    "us-east-1",
		AccessKey: "minioadmin",
		SecretKey: "minioadmin",
		PathStyle: true,
	}
	// Бакет создаём один раз на пакет (методом клиента; в проде — init-контейнер mc).
	if err := blob.New(testS3).CreateBucket(ctx, testBucket); err != nil {
		stopMinio()
		stopPG()
		panic(err)
	}

	code := m.Run()
	stopMinio()
	stopPG()
	os.Exit(code)
}

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
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, form_versions CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack собирает реальную вертикаль auth+forms+media поверх контейнерных
// Postgres и MinIO. Лимитер auth — пермиссивный (инвариант 6).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"))
	formsH := forms.NewHandler(formsSvc, authH.RequireAuth, authH.RequireCSRF)

	mediaSvc := media.NewService(formsSvc, blob.New(testS3), testBucket)
	mediaH := media.NewHandler(mediaSvc, authH.RequireAuth, authH.RequireCSRF)

	mux := http.NewServeMux()
	authH.Routes(mux)
	formsH.Routes(mux)
	mediaH.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestMedia_UploadRoundTrip(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "author@example.com")
	formID := createForm(t, c, srv)

	key := uploadOK(t, c, srv, formID, makePNG(t, 4, 4))
	// Ключ — контент-адресный: <workspaceUUID>/<64 hex>.png.
	if len(key) != 36+1+64+4 || key[36] != '/' || key[len(key)-4:] != ".png" {
		t.Fatalf("ключ %q: ожидался вид <workspaceUUID>/<sha256>.png", key)
	}

	// Объект реально лёг в бакет и извлекается валидной PNG (полный путь до S3).
	data, ct, err := blob.New(testS3).GetObject(context.Background(), testBucket, key)
	if err != nil {
		t.Fatalf("GetObject %q: %v", key, err)
	}
	if ct != "image/png" {
		t.Fatalf("content-type = %q, ожидался image/png", ct)
	}
	if _, err := png.Decode(bytes.NewReader(data)); err != nil {
		t.Fatalf("объект не декодируется как PNG: %v", err)
	}
}

// Изоляция воркспейсов: bob грузит в форму alice → 404 (не 403; существование не
// раскрывается), объект в бакет не попадает.
func TestMedia_WorkspaceIsolation(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")
	formID := createForm(t, alice, srv)

	r := uploadRaw(t, bob, srv, formID, "x.png", makePNG(t, 2, 2))
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("чужая загрузка: статус %d, ожидался 404", r.StatusCode)
	}
	_ = r.Body.Close()
}

func TestMedia_RejectsNonImage(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "author@example.com")
	formID := createForm(t, c, srv)

	r := uploadRaw(t, c, srv, formID, "note.txt", []byte("это не картинка, а текст"))
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("не-картинка: статус %d, ожидался 422", r.StatusCode)
	}
	_ = r.Body.Close()
}

func TestMedia_RejectsOversizedBody(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "author@example.com")
	formID := createForm(t, c, srv)

	big := make([]byte, media.MaxImageBytes+1024) // > 5 МиБ
	r := uploadRaw(t, c, srv, formID, "big.png", big)
	if r.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("большое тело: статус %d, ожидался 413", r.StatusCode)
	}
	_ = r.Body.Close()
}

// --- helpers ---

func makePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

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

func createForm(t *testing.T, c *http.Client, srv *httptest.Server) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/forms", bytes.NewReader([]byte(`{}`)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv))
	r, err := c.Do(req)
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	defer func() { _ = r.Body.Close() }()
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create form: статус %d, ожидался 201", r.StatusCode)
	}
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
		t.Fatalf("decode form: %v", err)
	}
	return out.ID
}

func uploadRaw(t *testing.T, c *http.Client, srv *httptest.Server, formID, filename string, content []byte) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", filename)
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatalf("write content: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/forms/"+formID+"/media", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv))
	r, err := c.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	return r
}

func uploadOK(t *testing.T, c *http.Client, srv *httptest.Server, formID string, content []byte) string {
	t.Helper()
	r := uploadRaw(t, c, srv, formID, "pic.png", content)
	defer func() { _ = r.Body.Close() }()
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("upload: статус %d, ожидался 201", r.StatusCode)
	}
	var out struct {
		ImageKey string `json:"imageKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&out); err != nil {
		t.Fatalf("decode upload: %v", err)
	}
	return out.ImageKey
}
