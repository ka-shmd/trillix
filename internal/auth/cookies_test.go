package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/oauth"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

// Контур с Secure (prod-local, прод): cookie кабинета носят префикс `__Host-`,
// и одноимённая cookie без префикса — та, что мог подложить соседний поддомен, —
// не читается (ADR §10).

func newSecureTestHandler(svc authService) http.Handler {
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, true, testAppOrigin, false).
		WithPasswordReset(ratelimit.AllowAll{}, ratelimit.AllowAll{}, ratelimit.AllowAll{}).
		WithEmailVerification(ratelimit.AllowAll{}, ratelimit.AllowAll{})
	mux := http.NewServeMux()
	h.Routes(mux)
	return mux
}

func TestSecureContour_RegisterSetsHostPrefixedCookies(t *testing.T) {
	srv := newSecureTestHandler(&fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}})

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/register",
		strings.NewReader(`{"email":"a@b.com","password":"supersecret"}`)))

	if rec.Code != http.StatusCreated {
		t.Fatalf("статус = %d, ожидалось 201; тело=%s", rec.Code, rec.Body)
	}
	cookies := rec.Result().Cookies()
	for _, name := range []string{"__Host-session", "__Host-csrf_token"} {
		c := cookieByName(cookies, name)
		// Условия префикса: без любого из них браузер cookie отбросит, и вход
		// пропадёт только на прод-контуре.
		if c == nil || !c.Secure || c.Path != "/" || c.Domain != "" {
			t.Fatalf("%s не выставлена по правилам префикса: %+v", name, c)
		}
	}
	if c := cookieByName(cookies, sessionCookieName); c != nil {
		t.Fatalf("выставлена cookie сессии без префикса: %+v", c)
	}
}

func TestSecureContour_UnprefixedSessionDoesNotAuthorize(t *testing.T) {
	srv := newSecureTestHandler(&fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}})

	// Подложенная с соседнего поддомена cookie: имя без префикса, значение —
	// живой токен атакующего. Прочти её кабинет — он вошёл бы в чужой аккаунт.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("cookie без префикса: статус = %d, ожидалось 401", rec.Code)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil)
	req.AddCookie(&http.Cookie{Name: "__Host-session", Value: "live-session"})
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cookie с префиксом: статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}
}

func TestSecureContour_CSRFReadsPrefixedToken(t *testing.T) {
	srv := newSecureTestHandler(&fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}})

	send := func(csrfCookie string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/resend-verification", nil)
		req.AddCookie(&http.Cookie{Name: "__Host-session", Value: "live-session"})
		req.AddCookie(&http.Cookie{Name: csrfCookie, Value: "tok"})
		req.Header.Set(csrfHeaderName, "tok")
		srv.ServeHTTP(rec, req)
		return rec.Code
	}

	if code := send(csrfCookieName); code != http.StatusForbidden {
		t.Fatalf("токен из cookie без префикса: статус = %d, ожидалось 403", code)
	}
	if code := send("__Host-csrf_token"); code != http.StatusNoContent {
		t.Fatalf("токен из cookie с префиксом: статус = %d, ожидалось 204", code)
	}
}

// Поход к провайдеру на контуре с Secure: state едет в `__Host-oauth_state`, и
// колбэк сверяется только с ней.
func TestSecureContour_OAuthFlowUsesPrefixedCookies(t *testing.T) {
	p := &fakeProvider{profile: oauth.Profile{ID: "1234567", Email: "user@yandex.ru"}}
	svc := &fakeOAuthService{}
	h := NewHandler(nil, ratelimit.AllowAll{}, ratelimit.AllowAll{}, true, "https://app.example", false).
		WithOAuth(svc, map[string]oauth.Provider{"fake": p}, ratelimit.AllowAll{}, []byte("test-secret-key-at-least-16"))
	mux := http.NewServeMux()
	h.OAuthRoutes(mux)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/start", nil))
	if c := cookieByName(rec.Result().Cookies(), "__Host-oauth_state"); c == nil || !c.Secure || c.Path != "/" {
		t.Fatalf("cookie состояния выставлена не по правилам префикса: %+v", c)
	}

	callback := func(stateCookie string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/callback?code=abc&state=good-state", nil)
		req.AddCookie(&http.Cookie{Name: stateCookie, Value: "good-state:verifier"})
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	callback(oauthStateCookie)
	if p.exchanged || svc.called {
		t.Fatal("колбэк сверился с cookie состояния без префикса")
	}

	rec = callback("__Host-oauth_state")
	if !svc.called {
		t.Fatal("колбэк с префиксной cookie состояния не дошёл до входа")
	}
	if c := cookieByName(rec.Result().Cookies(), "__Host-session"); c == nil || c.Value == "" {
		t.Fatal("сессия после входа через провайдера выдана не под префиксом")
	}
}
