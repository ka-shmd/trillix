package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

type fakeAuthService struct {
	user           User
	registerErr    error
	loginErr       error
	userByTokenErr error
	loggedOut      bool
	forgotErr      error
	resetErr       error
	forgotEmail    string // последний email, дошедший до сервиса
	resetCalled    bool
	verifyErr      error
	verifyToken    string // последний токен, дошедший до VerifyEmail
	resendErr      error
	resendCalled   bool
	resendUser     User // пользователь, дошедший до ResendVerification

	// Профиль (фаза 23, слайс A).
	profileErr       error
	profileUser      uuid.UUID // id, дошедший до сервиса
	profileFirstName string    // строки как есть, до нормализации сервисом
	profileLastName  string

	// Смена пароля (фаза 23, слайс C).
	passwordErr     error
	passwordCurrent string
	passwordNew     string
	passwordUser    uuid.UUID
}

func (f *fakeAuthService) ChangePassword(_ context.Context, user User, currentPassword, newPassword string) (string, error) {
	f.passwordUser = user.ID
	f.passwordCurrent = currentPassword
	f.passwordNew = newPassword
	if f.passwordErr != nil {
		return "", f.passwordErr
	}
	return "new-session-token", nil
}

func (f *fakeAuthService) UpdateProfile(_ context.Context, userID uuid.UUID, firstName, lastName string) (User, error) {
	f.profileUser = userID
	f.profileFirstName = firstName
	f.profileLastName = lastName
	if f.profileErr != nil {
		return User{}, f.profileErr
	}
	u := f.user
	u.FirstName = &firstName
	u.LastName = &lastName
	return u, nil
}

func (f *fakeAuthService) Register(_ context.Context, _, _ string) (User, string, error) {
	if f.registerErr != nil {
		return User{}, "", f.registerErr
	}
	return f.user, "session-token", nil
}

func (f *fakeAuthService) Login(_ context.Context, _, _ string) (User, string, error) {
	if f.loginErr != nil {
		return User{}, "", f.loginErr
	}
	return f.user, "session-token", nil
}

func (f *fakeAuthService) Logout(_ context.Context, _ string) error {
	f.loggedOut = true
	return nil
}

func (f *fakeAuthService) UserByToken(_ context.Context, _ string) (User, error) {
	if f.userByTokenErr != nil {
		return User{}, f.userByTokenErr
	}
	return f.user, nil
}

func (f *fakeAuthService) RequestPasswordReset(_ context.Context, email string) error {
	f.forgotEmail = email
	return f.forgotErr
}

func (f *fakeAuthService) ResetPassword(_ context.Context, _, _ string) error {
	f.resetCalled = true
	return f.resetErr
}

func (f *fakeAuthService) VerifyEmail(_ context.Context, token string) error {
	f.verifyToken = token
	return f.verifyErr
}

func (f *fakeAuthService) ResendVerification(_ context.Context, user User) error {
	f.resendCalled = true
	f.resendUser = user
	return f.resendErr
}

type denyLimiter struct{}

func (denyLimiter) Allow(string) bool { return false }

const testAppOrigin = "http://localhost:5173"

// newTestHandler — один лимитер и на логин, и на регистрацию (большинству тестов
// разграничение вёдер не важно).
func newTestHandler(svc authService, limiter RateLimiter) http.Handler {
	return newTestHandlerLR(svc, limiter, limiter)
}

// newTestHandlerLR — раздельные вёдра логина и регистрации (для проверки, что они
// не общие).
func newTestHandlerLR(svc authService, loginLimiter, registerLimiter RateLimiter) http.Handler {
	h := NewHandler(svc, loginLimiter, registerLimiter, false, testAppOrigin, false)
	// Ведра сброса по умолчанию пермиссивны (инвариант 6): тесты, проверяющие
	// именно лимит сброса, подставляют своё ведро через newTestHandlerReset.
	h = h.WithPasswordReset(ratelimit.AllowAll{}, ratelimit.AllowAll{}, ratelimit.AllowAll{})
	h = h.WithEmailVerification(ratelimit.AllowAll{}, ratelimit.AllowAll{})
	mux := http.NewServeMux()
	h.Routes(mux)
	return mux
}

// newTestHandlerReset — раздельные вёдра сброса (для проверки лимита по email/IP).
func newTestHandlerReset(svc authService, forgotIP, forgotEmail, reset RateLimiter) http.Handler {
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false)
	h = h.WithPasswordReset(forgotIP, forgotEmail, reset)
	h = h.WithEmailVerification(ratelimit.AllowAll{}, ratelimit.AllowAll{})
	mux := http.NewServeMux()
	h.Routes(mux)
	return mux
}

// newTestHandlerVerify — раздельные вёдра подтверждения (для проверки лимита
// verify по IP и resend по пользователю).
func newTestHandlerVerify(svc authService, verify, resend RateLimiter) http.Handler {
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false)
	h = h.WithPasswordReset(ratelimit.AllowAll{}, ratelimit.AllowAll{}, ratelimit.AllowAll{})
	h = h.WithEmailVerification(verify, resend)
	mux := http.NewServeMux()
	h.Routes(mux)
	return mux
}

func cookieByName(cookies []*http.Cookie, name string) *http.Cookie {
	for _, c := range cookies {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func TestRegister_SetsCookies(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register",
		strings.NewReader(`{"email":"a@b.com","password":"supersecret"}`))
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("статус = %d, ожидалось 201; тело=%s", rec.Code, rec.Body)
	}
	cookies := rec.Result().Cookies()
	session := cookieByName(cookies, sessionCookieName)
	if session == nil || !session.HttpOnly {
		t.Fatalf("session cookie отсутствует или не HttpOnly: %+v", session)
	}
	csrf := cookieByName(cookies, csrfCookieName)
	if csrf == nil || csrf.HttpOnly {
		t.Fatalf("csrf cookie должна присутствовать и быть читаемой JS: %+v", csrf)
	}
}

func TestLogin_MapsInvalidCredentials(t *testing.T) {
	svc := &fakeAuthService{loginErr: domain.ErrInvalidCredentials}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"a@b.com","password":"nope"}`))
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
}

func TestLogin_RateLimited(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandler(svc, denyLimiter{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"a@b.com","password":"whatever1"}`))
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ожидалось 429", rec.Code)
	}
}

func TestRegister_RateLimited(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandler(svc, denyLimiter{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register",
		strings.NewReader(`{"email":"a@b.com","password":"supersecret"}`))
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ожидалось 429", rec.Code)
	}
}

// Ведро регистрации отдельное от логина: исчерпанный логин не мешает регистрации.
func TestRegister_BucketSeparateFromLogin(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandlerLR(svc, denyLimiter{}, ratelimit.AllowAll{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register",
		strings.NewReader(`{"email":"a@b.com","password":"supersecret"}`))
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("статус = %d, ожидалось 201 (логин-лимит не должен блокировать регистрацию); тело=%s", rec.Code, rec.Body)
	}
}

func TestMe_RequiresSession(t *testing.T) {
	svc := &fakeAuthService{userByTokenErr: domain.ErrUnauthorized}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	// Без cookie.
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("без cookie статус = %d, ожидалось 401", rec.Code)
	}
}

func TestMe_ReturnsUser(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}
	var body userResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("тело не JSON: %v", err)
	}
	if body.Email != "a@b.com" {
		t.Fatalf("email = %q, ожидалось a@b.com", body.Email)
	}
}

func TestLogout_RequiresCSRF(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	// Есть сессия, но нет CSRF-заголовка → 403.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("без CSRF-заголовка статус = %d, ожидалось 403", rec.Code)
	}
	if svc.loggedOut {
		t.Fatal("Logout не должен вызываться при провале CSRF")
	}
}

func TestLogout_Succeeds(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ожидалось 204; тело=%s", rec.Code, rec.Body)
	}
	if !svc.loggedOut {
		t.Fatal("Logout не был вызван")
	}
	if c := cookieByName(rec.Result().Cookies(), sessionCookieName); c == nil || c.MaxAge != -1 {
		t.Fatalf("session cookie не сброшена: %+v", c)
	}
}

func TestRequireCSRF_RejectsForeignOrigin(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	// Валидный double-submit-токен, но чужой Origin → 403 (проверка Origin бьёт первой).
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	req.Header.Set("Origin", "http://evil.example")
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("чужой Origin: статус = %d, ожидалось 403", rec.Code)
	}
	if svc.loggedOut {
		t.Fatal("Logout не должен вызываться при чужом Origin")
	}
}

func TestRequireCSRF_AllowsMatchingOrigin(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestHandler(svc, ratelimit.AllowAll{})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	req.Header.Set("Origin", testAppOrigin)
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("свой Origin: статус = %d, ожидалось 204; тело=%s", rec.Code, rec.Body)
	}
	if !svc.loggedOut {
		t.Fatal("Logout не был вызван при своём Origin")
	}
}
