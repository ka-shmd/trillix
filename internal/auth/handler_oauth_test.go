package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/oauth"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

// fakeProvider — провайдер, который не ходит в сеть.
type fakeProvider struct {
	profile   oauth.Profile
	exchanged bool
}

func (f *fakeProvider) Name() string { return "fake" }

func (f *fakeProvider) AuthURL(state, verifier string) string {
	return "https://provider.example/auth?state=" + url.QueryEscape(state)
}

func (f *fakeProvider) Exchange(_ context.Context, _, _ string) (oauth.Profile, error) {
	f.exchanged = true
	return f.profile, nil
}

// fakeOAuthService фиксирует, дошёл ли до сервиса вход вообще, и с каким
// профилем (фаза 23: имя обязано доехать от провайдера до сервиса целиком).
type fakeOAuthService struct {
	called  bool
	err     error
	profile IdentityProfile

	// Код второго фактора, доехавший до сервиса на шаге привязки паролем.
	linkCode string

	// Привязка из настроек (фаза 23, слайс E).
	linkErr       error
	linkedUser    uuid.UUID
	linkedProfile IdentityProfile
}

func (f *fakeOAuthService) LoginWithIdentity(_ context.Context, p IdentityProfile) (User, string, error) {
	f.called = true
	f.profile = p
	return User{}, "session-token", f.err
}

func (f *fakeOAuthService) LinkIdentityWithPassword(_ context.Context, _, _, code, _, _ string) (User, string, error) {
	f.called = true
	f.linkCode = code
	return User{}, "session-token", f.err
}

func (f *fakeOAuthService) LinkIdentity(_ context.Context, userID uuid.UUID, p IdentityProfile) error {
	f.linkedUser = userID
	f.linkedProfile = p
	return f.linkErr
}

func newOAuthHandler(t *testing.T, p *fakeProvider, svc *fakeOAuthService) (*Handler, *http.ServeMux) {
	t.Helper()
	h := NewHandler(nil, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "https://app.example", false)
	h = h.WithOAuth(svc, map[string]oauth.Provider{"fake": p}, ratelimit.AllowAll{}, []byte("test-secret-key-at-least-16"))
	mux := http.NewServeMux()
	h.OAuthRoutes(mux)
	return h, mux
}

func TestOAuthStart_SetsStateCookieAndRedirects(t *testing.T) {
	p := &fakeProvider{}
	_, mux := newOAuthHandler(t, p, &fakeOAuthService{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/start", nil))

	if rec.Code != http.StatusFound {
		t.Fatalf("код = %d, want 302", rec.Code)
	}
	var stateCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == oauthStateCookie {
			stateCookie = c
		}
	}
	if stateCookie == nil {
		t.Fatal("cookie состояния не выставлена — сверять при возврате будет нечего")
	}
	if !stateCookie.HttpOnly {
		t.Fatal("cookie состояния доступна из JS")
	}
	// Strict не доедет на редиректе с домена провайдера, и вход сломается.
	if stateCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("SameSite = %v, want Lax", stateCookie.SameSite)
	}
}

func TestOAuthStart_UnknownProvider404(t *testing.T) {
	_, mux := newOAuthHandler(t, &fakeProvider{}, &fakeOAuthService{})

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/vk/start", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("код = %d, want 404 (провайдер не включён)", rec.Code)
	}
}

// Ключевая проверка DoD: подменённый или отсутствующий state не даёт сессии.
func TestOAuthCallback_StateMismatch(t *testing.T) {
	cases := map[string]struct{ cookie, query string }{
		"подменённый state":   {cookie: "real-state:verifier", query: "attacker-state"},
		"нет state в запросе": {cookie: "real-state:verifier", query: ""},
		"нет cookie":          {cookie: "", query: "real-state"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			p := &fakeProvider{profile: oauth.Profile{ID: "1", Email: "a@b.ru"}}
			svc := &fakeOAuthService{}
			_, mux := newOAuthHandler(t, p, svc)

			req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/callback?code=abc&state="+c.query, nil)
			if c.cookie != "" {
				req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: c.cookie})
			}
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if p.exchanged {
				t.Fatal("код обменян до сверки state")
			}
			if svc.called {
				t.Fatal("вход дошёл до сервиса при непройденной сверке state")
			}
			for _, ck := range rec.Result().Cookies() {
				if ck.Name == sessionCookieName && ck.Value != "" {
					t.Fatal("выдана сессия при непройденной сверке state")
				}
			}
		})
	}
}

func TestOAuthCallback_HappyPathStartsSession(t *testing.T) {
	p := &fakeProvider{profile: oauth.Profile{ID: "1234567", Email: "user@yandex.ru"}}
	svc := &fakeOAuthService{}
	_, mux := newOAuthHandler(t, p, svc)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/callback?code=abc&state=good-state", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "good-state:verifier"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if !svc.called {
		t.Fatal("сервис не вызван")
	}
	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			session = c
		}
	}
	if session == nil || session.Value == "" {
		t.Fatal("сессия не выдана")
	}
	// Редирект только на свой origin: путь — литерал кода, никогда не значение
	// из запроса (иначе это open redirect).
	if loc := rec.Header().Get("Location"); !strings.HasPrefix(loc, "https://app.example/") {
		t.Fatalf("Location = %q — редирект уводит с нашего origin", loc)
	}
}

// Cookie состояния обязана гаситься в самом ответе колбэка. Через defer это не
// работает: http.Redirect к тому моменту уже записал заголовки, Set-Cookie не
// уезжает, и state с verifier живут все 15 минут TTL — то есть перестают быть
// одноразовыми. Найдено ревью шага 5.
func TestOAuthCallback_ClearsStateCookie(t *testing.T) {
	for name, target := range map[string]string{
		"успех":             "/api/v1/auth/oauth/fake/callback?code=abc&state=good-state",
		"несовпавший state": "/api/v1/auth/oauth/fake/callback?code=abc&state=wrong",
		"отказ провайдера":  "/api/v1/auth/oauth/fake/callback?error=access_denied",
	} {
		t.Run(name, func(t *testing.T) {
			p := &fakeProvider{profile: oauth.Profile{ID: "1", Email: "a@b.ru"}}
			_, mux := newOAuthHandler(t, p, &fakeOAuthService{})

			req := httptest.NewRequest(http.MethodGet, target, nil)
			req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "good-state:verifier"})
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			var cleared bool
			for _, c := range rec.Result().Cookies() {
				if c.Name == oauthStateCookie && c.MaxAge < 0 {
					cleared = true
				}
			}
			if !cleared {
				t.Fatal("cookie состояния не погашена — state и verifier переживают ответ")
			}
		})
	}
}

// Подпись «ожидания привязки» — единственное, что мешает привязать к чужому
// аккаунту произвольную личность у провайдера: сессии на этом шаге ещё нет,
// значит и CSRF-защиты тоже.
func TestPendingSignature_RejectsForgery(t *testing.T) {
	h, _ := newOAuthHandler(t, &fakeProvider{}, &fakeOAuthService{})

	valid := h.signPending("yandex", "1234567")
	if provider, id, ok := h.verifyPending(valid); !ok || provider != "yandex" || id != "1234567" {
		t.Fatalf("своя подпись не принята: %q %q %v", provider, id, ok)
	}

	forged := map[string]string{
		"подменённая личность":  strings.Replace(valid, "1234567", "9999999", 1),
		"подменённый провайдер": strings.Replace(valid, "yandex", "fakeyy", 1),
		"без подписи":           "yandex:1234567:99999999999",
		"мусор":                 "нет-разделителей",
	}
	for name, value := range forged {
		t.Run(name, func(t *testing.T) {
			if _, _, ok := h.verifyPending(value); ok {
				t.Fatal("подделка принята — можно привязать чужую личность к аккаунту")
			}
		})
	}
}

func TestPendingSignature_Expires(t *testing.T) {
	h, _ := newOAuthHandler(t, &fakeProvider{}, &fakeOAuthService{})

	// Срок в прошлом, подпись честная — принимать нельзя.
	payload := "yandex:1234567:1000000000"
	expired := payload + ":" + base64.RawURLEncoding.EncodeToString(h.pendingMAC(payload))
	if _, _, ok := h.verifyPending(expired); ok {
		t.Fatal("просроченное ожидание привязки принято")
	}
}

// Второй фактор на привязке — путь, которого транспорт раньше не знал: ошибка
// уезжала в общий маппинг, а там её нет, и человек получал 500 вместо запроса
// кода. Cookie ожидания при этом обязана дожить до повторного запроса с кодом.
func TestOAuthLink_TwoFactorAsksForCode(t *testing.T) {
	svc := &fakeOAuthService{err: ErrTwoFactorRequired}
	h, mux := newOAuthHandler(t, &fakeProvider{}, svc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/oauth/link",
		strings.NewReader(`{"email":"a@b.ru","password":"secret"}`))
	req.AddCookie(&http.Cookie{Name: oauthPendingCookie, Value: h.signPending("fake", "1234567")})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("код = %d, want 200; тело=%s", rec.Code, rec.Body.String())
	}
	var body map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("разбор тела: %v", err)
	}
	if !body["twoFactorRequired"] {
		t.Fatalf("тело = %v, ожидалось требование кода", body)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName {
			t.Fatal("выдана сессия до второго фактора")
		}
		if c.Name == oauthPendingCookie && c.MaxAge < 0 {
			t.Fatal("cookie ожидания погашена — привязывать на втором шаге будет нечего")
		}
	}
}

// Код из тела доезжает до сервиса: без этого второй шаг формы молча повторял бы
// первый, и человек видел бы «нужен код» на верный код.
func TestOAuthLink_PassesCodeToService(t *testing.T) {
	svc := &fakeOAuthService{}
	h, mux := newOAuthHandler(t, &fakeProvider{}, svc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/oauth/link",
		strings.NewReader(`{"email":"a@b.ru","password":"secret","code":"123456"}`))
	req.AddCookie(&http.Cookie{Name: oauthPendingCookie, Value: h.signPending("fake", "1234567")})
	mux.ServeHTTP(httptest.NewRecorder(), req)

	if svc.linkCode != "123456" {
		t.Fatalf("до сервиса доехал код %q, ожидался 123456", svc.linkCode)
	}
}

func TestOAuthLink_WithoutPendingCookie401(t *testing.T) {
	svc := &fakeOAuthService{}
	_, mux := newOAuthHandler(t, &fakeProvider{}, svc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/oauth/link",
		strings.NewReader(`{"email":"a@b.ru","password":"secret"}`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("код = %d, want 401", rec.Code)
	}
	if svc.called {
		t.Fatal("пароль пошёл в проверку без начатой привязки")
	}
}

// Вход из отдельного окна (попап). Режим помечается на старте и хранится в
// cookie: параметр в колбэке подконтролен тому, кто подсунул ссылку.
func TestOAuthStart_PopupModeMarksFlow(t *testing.T) {
	cases := map[string]struct {
		target  string
		wantSet bool
	}{
		"окно":            {target: "/api/v1/auth/oauth/fake/start?mode=popup", wantSet: true},
		"обычный переход": {target: "/api/v1/auth/oauth/fake/start", wantSet: false},
		"мусор в режиме":  {target: "/api/v1/auth/oauth/fake/start?mode=nonsense", wantSet: false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, mux := newOAuthHandler(t, &fakeProvider{}, &fakeOAuthService{})

			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, c.target, nil))

			var mode *http.Cookie
			for _, ck := range rec.Result().Cookies() {
				if ck.Name == oauthModeCookie {
					mode = ck
				}
			}
			if mode == nil {
				t.Fatal("метка режима не тронута — обычный поход обязан гасить чужую метку явно")
			}
			if c.wantSet {
				if mode.Value != oauthModePopup || mode.MaxAge <= 0 {
					t.Fatalf("метка окна = %q (MaxAge %d), want %q со сроком", mode.Value, mode.MaxAge, oauthModePopup)
				}
				if !mode.HttpOnly {
					t.Fatal("метка режима доступна из JS")
				}
				return
			}
			// Метка живёт 15 минут: брошенное окно не должно уводить следующий
			// вход в той же вкладке на /oauth/done, где опекуна нет.
			if mode.MaxAge >= 0 {
				t.Fatalf("метка окна не погашена на обычном походе: %q (MaxAge %d)", mode.Value, mode.MaxAge)
			}
		})
	}
}

// Исход попапа приезжает кодом на служебный /oauth/done — экран кабинета в окне
// 560×680 не рисуется. Коды закрытым перечнем: по ним вкладка-опекун выбирает
// экран сама.
func TestOAuthCallback_PopupReturnsOutcomeToDonePage(t *testing.T) {
	cases := map[string]struct {
		target string
		err    error
		want   string
	}{
		"успех":             {target: "?code=abc&state=good-state", want: "ok"},
		"отказ провайдера":  {target: "?error=access_denied", want: "denied"},
		"подменённый state": {target: "?code=abc&state=wrong", want: "state"},
		"второй фактор":     {target: "?code=abc&state=good-state", err: ErrTwoFactorRequired, want: "two_factor"},
		"нужен пароль":      {target: "?code=abc&state=good-state", err: ErrPasswordLinkRequired, want: "link_required"},
		"только провайдер":  {target: "?code=abc&state=good-state", err: ErrProviderOnlyAccount, want: "provider_only"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			p := &fakeProvider{profile: oauth.Profile{ID: "1", Email: "a@b.ru"}}
			_, mux := newOAuthHandler(t, p, &fakeOAuthService{err: c.err})

			req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/callback"+c.target, nil)
			req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "good-state:verifier"})
			req.AddCookie(&http.Cookie{Name: oauthModeCookie, Value: oauthModePopup})
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			want := "https://app.example/oauth/done?r=" + c.want
			if got := rec.Header().Get("Location"); got != want {
				t.Fatalf("Location = %q, want %q", got, want)
			}
			// Метка одноразовая: следующий поход не должен наследовать режим.
			var cleared bool
			for _, ck := range rec.Result().Cookies() {
				if ck.Name == oauthModeCookie && ck.MaxAge < 0 {
					cleared = true
				}
			}
			if !cleared {
				t.Fatal("метка режима не погашена — переживает ответ колбэка")
			}
		})
	}
}

// Без метки поведение колбэка обязано остаться прежним: переход в той же
// вкладке — путь по умолчанию, и он же фолбэк, когда браузер заблокировал окно.
func TestOAuthCallback_WithoutPopupGoesToScreens(t *testing.T) {
	cases := map[string]struct {
		target string
		err    error
		want   string
	}{
		"успех":            {target: "?code=abc&state=good-state", want: "https://app.example/"},
		"отказ провайдера": {target: "?error=access_denied", want: "https://app.example/login?oauth=denied"},
		"второй фактор":    {target: "?code=abc&state=good-state", err: ErrTwoFactorRequired, want: "https://app.example/two-factor"},
		"нужен пароль":     {target: "?code=abc&state=good-state", err: ErrPasswordLinkRequired, want: "https://app.example/link-account?provider=fake"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			p := &fakeProvider{profile: oauth.Profile{ID: "1", Email: "a@b.ru"}}
			_, mux := newOAuthHandler(t, p, &fakeOAuthService{err: c.err})

			req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/oauth/fake/callback"+c.target, nil)
			req.AddCookie(&http.Cookie{Name: oauthStateCookie, Value: "good-state:verifier"})
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)

			if got := rec.Header().Get("Location"); got != c.want {
				t.Fatalf("Location = %q, want %q", got, c.want)
			}
		})
	}
}
