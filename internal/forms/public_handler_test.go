package forms

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	testScript  = "/src/main.tsx"
)

func newPublicMux(svc publicFormService) *http.ServeMux {
	mux := http.NewServeMux()
	NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, testScript).Routes(mux)
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
	newPublicMux(svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/abc", nil))

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
	newPublicMux(svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/public/v1/forms/draft", nil))

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
	newPublicMux(svc).ServeHTTP(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Fatalf("статус %d, ожидалось 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 не должен нести тело, получено %d байт", rec.Body.Len())
	}
}
