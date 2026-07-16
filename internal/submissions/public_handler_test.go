package submissions

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/token"
)

var testSecret = []byte("dev-only-form-token-secret-not-a-real-key")

// fixedNow — момент «сейчас» в тестах; токены выпускаются относительно него.
var fixedNow = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

type fakeSvc struct {
	err      error
	gotID    uuid.UUID
	gotSlug  string
	gotMeta  Meta
	callback func()
}

func (f *fakeSvc) Submit(_ context.Context, slug string, id uuid.UUID, _ map[string]json.RawMessage, meta Meta) error {
	f.gotSlug, f.gotID, f.gotMeta = slug, id, meta
	if f.callback != nil {
		f.callback()
	}
	return f.err
}

type denyLimiter struct{}

func (denyLimiter) Allow(string) bool { return false }

type allowLimiter struct{}

func (allowLimiter) Allow(string) bool { return true }

// newHandler собирает транспорт с фиксированным now и пермиссивным лимитером.
func newHandler(svc submitService, limiter RateLimiter) *PublicHandler {
	h := NewPublicHandler(svc, limiter, testSecret, DefaultMinFillTime, false)
	h.now = func() time.Time { return fixedNow }
	return h
}

// freshToken — токен, выданный достаточно давно, чтобы пройти минимальное время.
func freshToken() string { return token.Issue(testSecret, fixedNow.Add(-5*time.Second)) }

func do(t *testing.T, h *PublicHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	h.Routes(mux)
	req := httptest.NewRequest(http.MethodPost, "/public/v1/forms/abc/submissions", strings.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func validBody(t *testing.T) string {
	t.Helper()
	b, _ := json.Marshal(submitRequest{
		SubmissionID: uuid.New().String(),
		Token:        freshToken(),
		Answers:      map[string]json.RawMessage{"blk": json.RawMessage(`"привет"`)},
	})
	return string(b)
}

func TestSubmit_Valid_Returns201(t *testing.T) {
	svc := &fakeSvc{}
	rec := do(t, newHandler(svc, allowLimiter{}), validBody(t))

	if rec.Code != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201; тело: %s", rec.Code, rec.Body)
	}
	if svc.gotSlug != "abc" {
		t.Fatalf("slug = %q, ожидался abc", svc.gotSlug)
	}
	var resp submitResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil || resp.ID != svc.gotID.String() {
		t.Fatalf("тело ответа неожиданно: %s (err %v)", rec.Body, err)
	}
}

func TestSubmit_Honeypot_SilentOKNoInsert(t *testing.T) {
	svc := &fakeSvc{}
	b, _ := json.Marshal(submitRequest{
		SubmissionID: uuid.New().String(),
		Token:        freshToken(),
		Answers:      map[string]json.RawMessage{},
		Website:      "http://spam.example",
	})
	rec := do(t, newHandler(svc, allowLimiter{}), string(b))

	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200 (молчаливый отброс honeypot)", rec.Code)
	}
	if svc.gotSlug != "" {
		t.Fatal("honeypot-ответ не должен доходить до сервиса (запись в БД)")
	}
}

func TestSubmit_TooFast_Returns422(t *testing.T) {
	svc := &fakeSvc{}
	b, _ := json.Marshal(submitRequest{
		SubmissionID: uuid.New().String(),
		Token:        token.Issue(testSecret, fixedNow), // возраст 0 < 3 с
		Answers:      map[string]json.RawMessage{},
	})
	rec := do(t, newHandler(svc, allowLimiter{}), string(b))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422 (слишком быстро)", rec.Code)
	}
	if svc.gotSlug != "" {
		t.Fatal("слишком быстрый ответ не должен доходить до сервиса")
	}
}

func TestSubmit_TokenTooOld_Returns422(t *testing.T) {
	svc := &fakeSvc{}
	// Токен старше суток — переиспользование выданного давно токена (TD-6).
	b, _ := json.Marshal(submitRequest{
		SubmissionID: uuid.New().String(),
		Token:        token.Issue(testSecret, fixedNow.Add(-DefaultMaxTokenAge-time.Second)),
		Answers:      map[string]json.RawMessage{},
	})
	rec := do(t, newHandler(svc, allowLimiter{}), string(b))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422 (токен слишком старый)", rec.Code)
	}
	if svc.gotSlug != "" {
		t.Fatal("ответ по устаревшему токену не должен доходить до сервиса")
	}
}

func TestSubmit_BadToken_Returns422(t *testing.T) {
	svc := &fakeSvc{}
	b, _ := json.Marshal(submitRequest{
		SubmissionID: uuid.New().String(),
		Token:        "не.токен",
		Answers:      map[string]json.RawMessage{},
	})
	rec := do(t, newHandler(svc, allowLimiter{}), string(b))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422 (битый токен)", rec.Code)
	}
}

func TestSubmit_ValidationError_MapsFields(t *testing.T) {
	svc := &fakeSvc{err: domain.AnswerErrors{"blk": "обязательное поле"}}
	rec := do(t, newHandler(svc, allowLimiter{}), validBody(t))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422", rec.Code)
	}
	var env struct {
		Error struct {
			Code   string            `json:"code"`
			Fields map[string]string `json:"fields"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("тело не парсится: %v", err)
	}
	if env.Error.Fields["blk"] == "" {
		t.Fatalf("ожидалась карта полей block_id→сообщение, получено: %s", rec.Body)
	}
}

func TestSubmit_NotFound_Returns404(t *testing.T) {
	svc := &fakeSvc{err: domain.ErrNotFound}
	rec := do(t, newHandler(svc, allowLimiter{}), validBody(t))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404 (черновик/закрытая не раскрывается)", rec.Code)
	}
}

func TestSubmit_TooLarge_Returns413(t *testing.T) {
	svc := &fakeSvc{}
	big := strings.Repeat("a", maxSubmitBodyBytes+1)
	body := `{"submission_id":"` + uuid.New().String() + `","token":"` + freshToken() +
		`","answers":{"blk":"` + big + `"}}`
	rec := do(t, newHandler(svc, allowLimiter{}), body)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("статус %d, ожидалось 413 (тело > 256 КБ)", rec.Code)
	}
}

func TestSubmit_RateLimited_Returns429(t *testing.T) {
	svc := &fakeSvc{}
	rec := do(t, newHandler(svc, denyLimiter{}), validBody(t))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус %d, ожидалось 429", rec.Code)
	}
	if svc.gotSlug != "" {
		t.Fatal("лимитированный запрос не должен доходить до сервиса")
	}
}

func TestSubmit_UnknownField_Returns422(t *testing.T) {
	svc := &fakeSvc{}
	body := `{"submission_id":"` + uuid.New().String() + `","token":"` + freshToken() +
		`","answers":{},"extra":1}`
	rec := do(t, newHandler(svc, allowLimiter{}), body)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422 (лишнее поле)", rec.Code)
	}
}
