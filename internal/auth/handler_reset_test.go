package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

func postJSON(srv http.Handler, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	srv.ServeHTTP(rec, req)
	return rec
}

func TestForgotPassword_Always204(t *testing.T) {
	// Сервис возвращает nil и для существующего, и для несуществующего адреса —
	// хендлер обязан ответить одинаково (204), не раскрывая существование.
	svc := &fakeAuthService{}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/forgot-password", `{"email":"user@example.com"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ожидалось 204; тело=%s", rec.Code, rec.Body)
	}
	if svc.forgotEmail != "user@example.com" {
		t.Errorf("до сервиса дошёл email %q", svc.forgotEmail)
	}
}

func TestForgotPassword_EmailRateLimited(t *testing.T) {
	svc := &fakeAuthService{}
	// IP-ведро пропускает, email-ведро режет — проверяем именно лимит по адресу.
	srv := newTestHandlerReset(svc, ratelimit.AllowAll{}, denyLimiter{}, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/forgot-password", `{"email":"user@example.com"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ожидалось 429", rec.Code)
	}
}

func TestForgotPassword_IPRateLimited(t *testing.T) {
	svc := &fakeAuthService{}
	srv := newTestHandlerReset(svc, denyLimiter{}, ratelimit.AllowAll{}, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/forgot-password", `{"email":"user@example.com"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ожидалось 429", rec.Code)
	}
}

func TestResetPassword_Success204(t *testing.T) {
	svc := &fakeAuthService{}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/reset-password", `{"token":"t","password":"brand-new-password"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ожидалось 204; тело=%s", rec.Code, rec.Body)
	}
	if !svc.resetCalled {
		t.Error("сервис ResetPassword не вызван")
	}
}

func TestResetPassword_InvalidToken422(t *testing.T) {
	svc := &fakeAuthService{resetErr: domain.ErrValidation}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/reset-password", `{"token":"bad","password":"brand-new-password"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422", rec.Code)
	}
}

func TestResetPassword_BadBody422(t *testing.T) {
	svc := &fakeAuthService{}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/reset-password", `{"token":123}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422", rec.Code)
	}
}
