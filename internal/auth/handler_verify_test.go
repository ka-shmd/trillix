package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

func TestVerifyEmail_Success204(t *testing.T) {
	svc := &fakeAuthService{}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/verify-email", `{"token":"raw-token"}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ожидалось 204; тело=%s", rec.Code, rec.Body)
	}
	if svc.verifyToken != "raw-token" {
		t.Errorf("до сервиса дошёл токен %q", svc.verifyToken)
	}
}

func TestVerifyEmail_InvalidToken422(t *testing.T) {
	svc := &fakeAuthService{verifyErr: domain.ErrValidation}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/verify-email", `{"token":"bad"}`)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422", rec.Code)
	}
}

func TestVerifyEmail_IPRateLimited(t *testing.T) {
	svc := &fakeAuthService{}
	srv := newTestHandlerVerify(svc, denyLimiter{}, ratelimit.AllowAll{})

	rec := postJSON(srv, "/api/v1/auth/verify-email", `{"token":"raw-token"}`)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ожидалось 429", rec.Code)
	}
}

func TestResendVerification_Succeeds204(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/resend-verification", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ожидалось 204; тело=%s", rec.Code, rec.Body)
	}
	if !svc.resendCalled || svc.resendUser.ID != user.ID {
		t.Errorf("ResendVerification вызван неверно (called=%v user=%v)", svc.resendCalled, svc.resendUser.ID)
	}
}

func TestResendVerification_RequiresCSRF(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	// Живая сессия есть, но нет CSRF-заголовка → 403 (эндпоинт мутирующий и должен
	// быть за RequireCSRF). Сторожит именно навешенность middleware на этот роут:
	// снять обёртку — тест краснеет.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/resend-verification", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("без CSRF-заголовка статус = %d, ожидалось 403", rec.Code)
	}
	if svc.resendCalled {
		t.Error("ResendVerification не должен вызываться при провале CSRF")
	}
}

func TestResendVerification_RequiresAuth(t *testing.T) {
	svc := &fakeAuthService{}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	// Нет сессии → 401, сервис не трогаем.
	rec := postJSON(srv, "/api/v1/auth/resend-verification", ``)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
	if svc.resendCalled {
		t.Error("ResendVerification не должен вызываться без сессии")
	}
}

func TestResendVerification_UserRateLimited(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	// verify-ведро пропускает, resend-ведро режет — проверяем лимит по пользователю.
	srv := newTestHandlerVerify(svc, ratelimit.AllowAll{}, denyLimiter{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/resend-verification", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ожидалось 429", rec.Code)
	}
	if svc.resendCalled {
		t.Error("при сработавшем лимите ResendVerification не должен вызываться")
	}
}
