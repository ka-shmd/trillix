package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/oauth"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

// newLinkHandler — стенд для привязки из настроек: нужны ОБА сервиса, потому
// что колбэк спрашивает у auth «чья сессия» и у oauth «привяжи».
func newLinkHandler(t *testing.T, p *fakeProvider, authSvc *fakeAuthService, oauthSvc *fakeOAuthService) (*Handler, *http.ServeMux) {
	t.Helper()
	h := NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false).
		WithAccount(AccountLimits{PasswordChange: ratelimit.AllowAll{}, TwoFactor: ratelimit.AllowAll{}, DeleteAccount: ratelimit.AllowAll{}, Avatar: ratelimit.AllowAll{}}).
		WithOAuth(oauthSvc, map[string]oauth.Provider{"fake": p}, ratelimit.AllowAll{}, []byte("test-secret-key-at-least-16"))
	mux := http.NewServeMux()
	h.AccountRoutes(mux)
	h.OAuthRoutes(mux)
	return h, mux
}

func withSession(req *http.Request) *http.Request {
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	return req
}

func TestListIdentities_ReturnsCards(t *testing.T) {
	email := "ivan@yandex.ru"
	svc := &fakeAuthService{
		user:       User{ID: domain.NewID(), Email: "a@b.com"},
		identities: []Identity{{Provider: "yandex", ProviderEmail: &email}},
	}
	srv := newTestAccountHandler(svc)

	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, withSession(httptest.NewRequest(http.MethodGet, "/api/v1/account/identities", nil)))

	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}
	var got []identityResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("тело не разбирается: %v", err)
	}
	if len(got) != 1 || got[0].Provider != "yandex" || got[0].ProviderEmail != email {
		t.Fatalf("карточки = %+v", got)
	}
	// Идентификатор у провайдера наружу не отдаётся: человеку он ничего не
	// говорит, а знать его посторонним незачем.
	if strings.Contains(rec.Body.String(), "providerUserId") {
		t.Error("в ответе оказался provider_user_id")
	}
}

func TestUnlinkIdentity_RequiresCSRF(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/account/identities/yandex", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("без CSRF-заголовка статус = %d, ожидалось 403", rec.Code)
	}
	if svc.unlinkedName != "" {
		t.Error("сервис вызван при провале CSRF")
	}
}

func TestStartIdentityLink_SetsSignedIntentAndRedirects(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	h, mux := newLinkHandler(t, &fakeProvider{}, &fakeAuthService{user: user}, &fakeOAuthService{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, withSession(httptest.NewRequest(http.MethodGet, "/api/v1/account/identities/fake/start", nil)))

	if rec.Code != http.StatusFound {
		t.Fatalf("статус = %d, ожидалось 302", rec.Code)
	}
	link := cookieByName(rec.Result().Cookies(), oauthLinkCookie)
	if link == nil {
		t.Fatal("намерение привязки не выставлено — колбэк примет поход за обычный вход")
	}
	// HttpOnly — суть защиты: JS не должен ни прочитать, ни подделать намерение.
	if !link.HttpOnly {
		t.Fatal("cookie намерения доступна из JS")
	}
	got, ok := h.readLinkIntent(&http.Request{Header: http.Header{"Cookie": []string{oauthLinkCookie + "=" + link.Value}}})
	if !ok || got != user.ID {
		t.Fatalf("в намерении id = %v (ok=%v), ожидался id текущего аккаунта %v", got, ok, user.ID)
	}
}

func TestStartIdentityLink_RequiresAuth(t *testing.T) {
	_, mux := newLinkHandler(t, &fakeProvider{}, &fakeAuthService{userByTokenErr: domain.ErrUnauthorized}, &fakeOAuthService{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/account/identities/fake/start", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("без сессии выставлены cookie — намерение привязки смог бы поставить кто угодно")
	}
}

// callbackWithIntent прогоняет колбэк с валидным state и намерением привязки,
// подписанным на intentUser; сессия в запросе — та, что вернёт authSvc.
func callbackWithIntent(t *testing.T, h *Handler, mux *http.ServeMux, intentUser uuid.UUID, withSessionCookie bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/callback?code=abc&state=st", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "st:verifier"})
	req.AddCookie(&http.Cookie{Name: oauthLinkCookie, Value: h.signLinkIntent(intentUser)})
	if withSessionCookie {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func TestOAuthCallback_LinkIntentLinksToCurrentAccount(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	p := &fakeProvider{profile: oauth.Profile{ID: "prov-1", Email: "ivan@yandex.ru", FirstName: "Иван"}}
	oauthSvc := &fakeOAuthService{}
	h, mux := newLinkHandler(t, p, &fakeAuthService{user: user}, oauthSvc)

	rec := callbackWithIntent(t, h, mux, user.ID, true)

	if rec.Code != http.StatusFound || rec.Header().Get("Location") != testAppOrigin+"/settings/account?link=ok" {
		t.Fatalf("статус=%d Location=%q", rec.Code, rec.Header().Get("Location"))
	}
	if oauthSvc.linkedUser != user.ID {
		t.Fatalf("привязка ушла к %v, ожидался %v", oauthSvc.linkedUser, user.ID)
	}
	if oauthSvc.linkedProfile.ProviderUserID != "prov-1" || oauthSvc.linkedProfile.Email != "ivan@yandex.ru" {
		t.Fatalf("профиль до сервиса не доехал: %+v", oauthSvc.linkedProfile)
	}
	// Вход при этом НЕ выполняется: сессия у человека уже есть, и подменять её
	// на новую незачем.
	if oauthSvc.called {
		t.Error("вызван вход вместо привязки")
	}
	// Намерение одноразовое: cookie гасится тем же ответом.
	if c := cookieByName(rec.Result().Cookies(), oauthLinkCookie); c == nil || c.MaxAge >= 0 {
		t.Errorf("cookie намерения не погашена: %+v", c)
	}
}

// Ключевая проверка слайса: намерение, подписанное на ЧУЖОЙ аккаунт, не даёт
// привязать личность к тому, кто сидит в браузере. Без сверки с сессией это
// рабочая атака — жертву заманивают пройти привязку, к её аккаунту цепляется
// личность атакующего, и дальше он входит как она.
func TestOAuthCallback_LinkIntentForAnotherAccountRefused(t *testing.T) {
	victim := User{ID: domain.NewID(), Email: "victim@b.com"}
	attacker := domain.NewID()
	p := &fakeProvider{profile: oauth.Profile{ID: "attacker-identity", Email: "attacker@yandex.ru"}}
	oauthSvc := &fakeOAuthService{}
	h, mux := newLinkHandler(t, p, &fakeAuthService{user: victim}, oauthSvc)

	rec := callbackWithIntent(t, h, mux, attacker, true)

	if got := rec.Header().Get("Location"); got != testAppOrigin+"/settings/account?link=expired" {
		t.Fatalf("Location = %q, ожидался отказ", got)
	}
	if oauthSvc.linkedUser != uuid.Nil {
		t.Fatalf("привязка выполнена вопреки расхождению сессии и намерения: user=%v", oauthSvc.linkedUser)
	}
}

func TestOAuthCallback_LinkIntentWithoutSessionRefused(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	p := &fakeProvider{profile: oauth.Profile{ID: "prov-1", Email: "ivan@yandex.ru"}}
	oauthSvc := &fakeOAuthService{}
	h, mux := newLinkHandler(t, p, &fakeAuthService{user: user}, oauthSvc)

	// Сессия истекла, пока человек ходил к провайдеру: привязывать не к чему.
	rec := callbackWithIntent(t, h, mux, user.ID, false)

	if got := rec.Header().Get("Location"); got != testAppOrigin+"/settings/account?link=expired" {
		t.Fatalf("Location = %q, ожидался отказ", got)
	}
	if oauthSvc.linkedUser != uuid.Nil {
		t.Fatal("привязка выполнена без живой сессии")
	}
}

func TestOAuthCallback_ForgedIntentIsIgnored(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	p := &fakeProvider{profile: oauth.Profile{ID: "prov-1", Email: "ivan@yandex.ru"}}
	oauthSvc := &fakeOAuthService{}
	_, mux := newLinkHandler(t, p, &fakeAuthService{user: user}, oauthSvc)

	// Подпись не сходится → намерения нет, это обычный вход. Не 500 и не отказ:
	// подделать намерение нельзя, а сломать вход подделкой — тем более.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/callback?code=abc&state=st", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "st:verifier"})
	req.AddCookie(&http.Cookie{Name: oauthLinkCookie, Value: user.ID.String() + ":9999999999:not-a-signature"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if !oauthSvc.called {
		t.Fatal("подделанное намерение не должно мешать обычному входу")
	}
	if oauthSvc.linkedUser != uuid.Nil {
		t.Fatal("подделанное намерение привело к привязке")
	}
}
