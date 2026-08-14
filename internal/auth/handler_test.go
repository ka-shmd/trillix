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

	// Смена адреса (фаза 23, слайс D).
	emailChangeErr     error
	emailChangeNew     string
	emailChangeUser    uuid.UUID
	confirmEmailErr    error
	confirmEmailToken  string
	confirmEmailCalled bool

	// Способы входа (фаза 23, слайс E).
	identities    []Identity
	identitiesErr error
	unlinkErr     error
	unlinkedName  string
	unlinkedUser  uuid.UUID
	linkErr       error
	linkedUser    uuid.UUID
	linkedProfile IdentityProfile

	// Второй фактор (фаза 23, слайс F).
	twoFactorOn      bool
	twoFactorErr     error
	setupSecret      string
	setupErr         error
	enableCodes      []string
	enableErr        error
	disableErr       error
	disabledCode     string
	disabledPassword string
	completeErr      error
	completedCode    string
	completedUser    uuid.UUID

	// Удаление аккаунта (фаза 23, слайс G).
	deleteErr      error
	deletedUser    uuid.UUID
	deletedPass    string
	deletedCode    string
	deleteRequests int
}

func (f *fakeAuthService) DeleteAccount(_ context.Context, user User, currentPassword, code string) error {
	f.deleteRequests++
	f.deletedUser = user.ID
	f.deletedPass = currentPassword
	f.deletedCode = code
	return f.deleteErr
}

func (f *fakeAuthService) TwoFactorEnabled(_ context.Context, _ uuid.UUID) (bool, error) {
	return f.twoFactorOn, f.twoFactorErr
}

func (f *fakeAuthService) SetupTOTP(_ context.Context, _ User) (string, string, error) {
	if f.setupErr != nil {
		return "", "", f.setupErr
	}
	return f.setupSecret, "otpauth://totp/Trillix:a@b.com?secret=" + f.setupSecret, nil
}

func (f *fakeAuthService) EnableTOTP(_ context.Context, _ User, _ string) ([]string, error) {
	if f.enableErr != nil {
		return nil, f.enableErr
	}
	return f.enableCodes, nil
}

func (f *fakeAuthService) DisableTOTP(_ context.Context, _ User, currentPassword, code string) error {
	f.disabledPassword = currentPassword
	f.disabledCode = code
	return f.disableErr
}

func (f *fakeAuthService) CompleteTwoFactorLogin(_ context.Context, userID uuid.UUID, code string) (User, string, error) {
	f.completedUser = userID
	f.completedCode = code
	if f.completeErr != nil {
		return User{}, "", f.completeErr
	}
	return f.user, "session-token", nil
}

func (f *fakeAuthService) Identities(_ context.Context, _ uuid.UUID) ([]Identity, error) {
	return f.identities, f.identitiesErr
}

func (f *fakeAuthService) UnlinkIdentity(_ context.Context, user User, provider string) error {
	f.unlinkedUser = user.ID
	f.unlinkedName = provider
	return f.unlinkErr
}

func (f *fakeAuthService) RequestEmailChange(_ context.Context, user User, newEmail, _ string) error {
	f.emailChangeUser = user.ID
	f.emailChangeNew = newEmail
	return f.emailChangeErr
}

func (f *fakeAuthService) ConfirmEmailChange(_ context.Context, token string) error {
	f.confirmEmailCalled = true
	f.confirmEmailToken = token
	return f.confirmEmailErr
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
		// Пользователь возвращается ВМЕСТЕ с ошибкой — так делает и настоящий
		// сервис при ErrTwoFactorRequired: транспорту нужно, кого спрашивать код.
		return f.user, "", f.loginErr
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
