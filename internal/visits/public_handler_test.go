package visits

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
	"github.com/ka-shmd/trierra/internal/httpserver"
	"github.com/ka-shmd/trierra/internal/token"
)

var testSecret = []byte("dev-only-form-token-secret-not-a-real-key")

// fixedNow — момент «сейчас» в тестах; токены выпускаются относительно него.
var fixedNow = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

type fakeSvc struct {
	err error
	got Visit
	// gotSlug пишется даже при ошибке — тесты отличают «не дошло до сервиса» от
	// «сервис отказал».
	gotSlug string
	called  bool
}

func (f *fakeSvc) Record(_ context.Context, slug string, v Visit) error {
	f.gotSlug, f.got, f.called = slug, v, true
	return f.err
}

type denyLimiter struct{}

func (denyLimiter) Allow(string) bool { return false }

type allowLimiter struct{}

func (allowLimiter) Allow(string) bool { return true }

func newHandler(svc recordService, limiter httpserver.RateLimiter) *PublicHandler {
	h := NewPublicHandler(svc, limiter, testSecret, false)
	h.now = func() time.Time { return fixedNow }
	return h
}

func do(t *testing.T, h *PublicHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	h.Routes(mux)
	req := httptest.NewRequest(http.MethodPost, "/public/v1/forms/abc/visits", strings.NewReader(body))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func bodyWith(t *testing.T, mutate func(*visitRequest)) string {
	t.Helper()
	req := visitRequest{
		VisitID: uuid.New().String(),
		Token:   token.Issue(testSecret, fixedNow),
		Version: 1,
	}
	if mutate != nil {
		mutate(&req)
	}
	b, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return string(b)
}

// Бикон «открыли» уходит через миллисекунды после выдачи токена. Именно поэтому
// визиты не применяют нижнюю границу возраста токена (минимальное время заполнения)
// — иначе ручка отбрасывала бы ровно те визиты, ради которых заведена.
func TestRecord_FreshTokenAccepted(t *testing.T) {
	svc := &fakeSvc{}
	rec := do(t, newHandler(svc, allowLimiter{}), bodyWith(t, nil))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ждали 204; тело %s", rec.Code, rec.Body)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("тело = %q, ждали пустое (бикон ответ не читает)", rec.Body)
	}
	if svc.gotSlug != "abc" {
		t.Errorf("slug = %q, ждали abc", svc.gotSlug)
	}
}

// Верхняя граница возраста токена (TD-6) визитам нужна: без неё бот получает форму
// один раз и накручивает просмотры тем же токеном неограниченно.
func TestRecord_StaleTokenRejected(t *testing.T) {
	svc := &fakeSvc{}
	body := bodyWith(t, func(r *visitRequest) {
		r.Token = token.Issue(testSecret, fixedNow.Add(-maxTokenAge-time.Minute))
	})
	rec := do(t, newHandler(svc, allowLimiter{}), body)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ждали 422", rec.Code)
	}
	if svc.called {
		t.Error("сервис вызван при протухшем токене — запись не должна дойти до БД")
	}
}

func TestRecord_ForgedTokenRejected(t *testing.T) {
	svc := &fakeSvc{}
	body := bodyWith(t, func(r *visitRequest) { r.Token = "1767268800000.deadbeef" })
	rec := do(t, newHandler(svc, allowLimiter{}), body)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ждали 422", rec.Code)
	}
	if svc.called {
		t.Error("сервис вызван при поддельной подписи")
	}
}

// Тело бикона не имеет поля submitted, и попытка его передать обязана отвалиться на
// разборе (DisallowUnknownFields): иначе конверсия подделывается с клиента.
func TestRecord_SubmittedFieldRejected(t *testing.T) {
	svc := &fakeSvc{}
	body := `{"visit_id":"` + uuid.New().String() + `","token":"` +
		token.Issue(testSecret, fixedNow) + `","version":1,"submitted":true}`
	rec := do(t, newHandler(svc, allowLimiter{}), body)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ждали 422 (лишнее поле)", rec.Code)
	}
	if svc.called {
		t.Error("сервис вызван с телом, содержащим submitted")
	}
}

func TestRecord_BodyOverLimitRejected(t *testing.T) {
	svc := &fakeSvc{}
	body := bodyWith(t, func(r *visitRequest) {
		r.UTM = map[string]string{"utm_source": strings.Repeat("x", maxVisitBodyBytes+1)}
	})
	rec := do(t, newHandler(svc, allowLimiter{}), body)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("статус = %d, ждали 413", rec.Code)
	}
}

func TestRecord_RateLimited(t *testing.T) {
	svc := &fakeSvc{}
	rec := do(t, newHandler(svc, denyLimiter{}), bodyWith(t, nil))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ждали 429", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "60" {
		t.Errorf("Retry-After = %q, ждали 60", got)
	}
	if svc.called {
		t.Error("сервис вызван при сработавшем лимитере")
	}
}

func TestRecord_BadVisitID(t *testing.T) {
	svc := &fakeSvc{}
	rec := do(t, newHandler(svc, allowLimiter{}), bodyWith(t, func(r *visitRequest) { r.VisitID = "not-a-uuid" }))

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ждали 422", rec.Code)
	}
}

// Поля last_block_id/seq/utm доезжают до сервиса без искажения — транспорт их не
// трактует, только переносит.
func TestRecord_PassesPayloadThrough(t *testing.T) {
	svc := &fakeSvc{}
	block := "blk_9f2k1x"
	body := bodyWith(t, func(r *visitRequest) {
		r.LastBlockID = &block
		r.Seq = 3
		r.Version = 7
		r.UTM = map[string]string{"utm_source": "telegram"}
	})
	if rec := do(t, newHandler(svc, allowLimiter{}), body); rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ждали 204", rec.Code)
	}

	if svc.got.LastBlockID == nil || *svc.got.LastBlockID != block {
		t.Errorf("last_block_id = %v, ждали %q", svc.got.LastBlockID, block)
	}
	if svc.got.Seq != 3 {
		t.Errorf("seq = %d, ждали 3", svc.got.Seq)
	}
	if svc.got.Version != 7 {
		t.Errorf("version = %d, ждали 7", svc.got.Version)
	}
	if svc.got.UTM["utm_source"] != "telegram" {
		t.Errorf("utm_source = %q, ждали telegram", svc.got.UTM["utm_source"])
	}
}

// Закрытая форма → 410, как и на приёме ответа: транспорт доменную ошибку не
// переводит сам, это делает respond.go.
func TestRecord_ClosedFormGone(t *testing.T) {
	svc := &fakeSvc{err: domain.ErrFormClosed}
	rec := do(t, newHandler(svc, allowLimiter{}), bodyWith(t, nil))

	if rec.Code != http.StatusGone {
		t.Fatalf("статус = %d, ждали 410", rec.Code)
	}
}

// Черновик и несуществующая форма неотличимы — 404 (инвариант безопасности 5).
func TestRecord_DraftIsNotFound(t *testing.T) {
	svc := &fakeSvc{err: domain.ErrNotFound}
	rec := do(t, newHandler(svc, allowLimiter{}), bodyWith(t, nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("статус = %d, ждали 404", rec.Code)
	}
}
