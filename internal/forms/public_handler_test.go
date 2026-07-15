package forms

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/token"
)

type fakePublicSvc struct {
	pf  PublicForm
	err error
}

func (f fakePublicSvc) PublicForm(_ context.Context, _ string) (PublicForm, error) {
	return f.pf, f.err
}

var testSecret = []byte("dev-only-form-token-secret-not-a-real-key")

const (
	testBaseURL = "http://localhost:5174"
	testOGImage = "http://localhost:5174/og-preview.png"
)

// builtIndexFixture — реалистичный собранный index.html рендерера: хешированные
// имена ассетов (как их отдаёт vite-дефолт), favicon и — намеренно — лишний
// <link rel="preload">, которого Go «не знает». Тесты формы проверяют, что ВСЁ это
// доезжает в ответ дословно: доказательство, что добавление ассета в сборку не
// требует правок Go (DoD фазы 8, шаг 7). Плейсхолдер <!--og-meta--> — точка вставки.
const builtIndexFixture = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!--og-meta-->
    <link rel="preload" href="/assets/font-a1b2c3.woff2" as="font" type="font/woff2" crossorigin>
    <script type="module" crossorigin src="/assets/index-ByZMBI6C.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-mIztBLt-.css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`

// writeFixtureIndex кладёт собранный index.html во временный файл и отдаёт путь.
func writeFixtureIndex(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "index.html")
	if err := os.WriteFile(path, []byte(builtIndexFixture), 0o600); err != nil {
		t.Fatalf("запись фикстуры index.html: %v", err)
	}
	return path
}

// newPublicMux — mux без страницы формы (indexHTMLPath пуст, как в dev): /r не
// регистрируется, обслуживается только JSON-ручка /public/v1.
func newPublicMux(t *testing.T, svc publicFormService) *http.ServeMux {
	t.Helper()
	h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, "")
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.Routes(mux)
	return mux
}

// newPublicHTMLMux — mux прод-контура: index.html задан, поэтому Go обслуживает /r.
func newPublicHTMLMux(t *testing.T, svc publicFormService) *http.ServeMux {
	t.Helper()
	h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, writeFixtureIndex(t))
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.Routes(mux)
	return mux
}

func TestPublicGet_Published_ReturnsSchemaAndValidToken(t *testing.T) {
	vid := uuid.New()
	svc := fakePublicSvc{pf: PublicForm{
		Title:     "Опрос",
		Version:   2,
		Schema:    json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID: vid,
	}}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", rec.Code)
	}
	if got := rec.Header().Get("ETag"); got != `"`+vid.String()+`"` {
		t.Fatalf("ETag = %q, ожидался id версии", got)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "public, max-age=60" {
		t.Fatalf("Cache-Control = %q", cc)
	}

	var body publicFormResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("тело не парсится: %v", err)
	}
	if body.Title != "Опрос" || body.Version != 2 {
		t.Fatalf("неожиданное тело: %+v", body)
	}
	// token подписан нашим ключом — проверяется тем же секретом.
	if _, err := token.IssuedAt(testSecret, body.Token); err != nil {
		t.Fatalf("token невалиден: %v", err)
	}
}

func TestPublicGet_NotPublished_Returns404(t *testing.T) {
	svc := fakePublicSvc{err: domain.ErrNotFound}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/draft", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404 (черновик/закрытая не раскрывается)", rec.Code)
	}
}

func TestPublicGet_IfNoneMatch_Returns304(t *testing.T) {
	vid := uuid.New()
	svc := fakePublicSvc{pf: PublicForm{Title: "x", Version: 1, Schema: json.RawMessage(`{}`), VersionID: vid}}
	req := httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil)
	req.Header.Set("If-None-Match", `"`+vid.String()+`"`)

	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("статус %d, ожидалось 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 не должен нести тело, получено %d байт", rec.Body.Len())
	}
}

// В dev (indexHTMLPath пуст) Go не обслуживает /r — форму отдаёт vite-dev.
func TestPublicHTML_NoIndex_DoesNotServeR(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{Title: "x", Version: 1, Schema: json.RawMessage(`{}`), VersionID: uuid.New()}}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/abc", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404 (в dev /r не регистрируется)", rec.Code)
	}
}

// Fail-fast: собранный index.html без плейсхолдера — ошибка старта, а не молчаливо
// битая форма на первом запросе краулера.
func TestNewPublicHandler_IndexMissingMarker_Errors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.html")
	if err := os.WriteFile(path, []byte(`<html><head></head><body><div id="root"></div></body></html>`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewPublicHandler(fakePublicSvc{}, testSecret, testBaseURL, testOGImage, path); err == nil {
		t.Fatal("ожидалась ошибка старта для index.html без плейсхолдера <!--og-meta-->")
	}
}

// Fail-fast: нечитаемый/несуществующий путь — ошибка старта.
func TestNewPublicHandler_IndexUnreadable_Errors(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope", "index.html")
	if _, err := NewPublicHandler(fakePublicSvc{}, testSecret, testBaseURL, testOGImage, missing); err == nil {
		t.Fatal("ожидалась ошибка старта для несуществующего index.html")
	}
}
