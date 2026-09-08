package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

// newTestAuthHandler — публичные маршруты auth (вход и второй шаг) с
// пермиссивными вёдрами.
func newTestAuthHandler(svc authService) (*Handler, *http.ServeMux) {
	return newTestAuthHandlerLimited(svc, ratelimit.AllowAll{})
}

// newTestAuthHandlerLimited — то же, но со своим ведром второго шага по
// аккаунту. Ведро по IP при этом остаётся пермиссивным: тест лимита по
// аккаунту не должен проходить за счёт соседнего ведра.
func newTestAuthHandlerLimited(svc authService, twoFactorLogin RateLimiter) (*Handler, *http.ServeMux) {
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false).
		WithPasswordReset(ratelimit.AllowAll{}, ratelimit.AllowAll{}, ratelimit.AllowAll{}).
		WithEmailVerification(ratelimit.AllowAll{}, ratelimit.AllowAll{}).
		WithOAuth(&fakeOAuthService{}, nil, ratelimit.AllowAll{}, []byte("test-secret-key-at-least-16")).
		WithTwoFactorLogin(twoFactorLogin)
	mux := http.NewServeMux()
	h.Routes(mux)
	return h, mux
}

func TestLogin_TwoFactorRequiredGivesChallengeNotSession(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user, loginErr: ErrTwoFactorRequired}
	h, mux := newTestAuthHandler(svc)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"a@b.com","password":"supersecret1"}`)))

	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}
	var body map[string]bool
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || !body["twoFactorRequired"] {
		t.Fatalf("тело = %s (err=%v)", rec.Body, err)
	}
	// Сессии быть не должно: иначе первый шаг сам по себе даёт доступ, и второй
	// фактор становится украшением.
	if c := cookieByName(rec.Result().Cookies(), sessionCookieName); c != nil {
		t.Fatalf("выдана cookie сессии до второго шага: %+v", c)
	}
	challenge := cookieByName(rec.Result().Cookies(), twoFactorCookie)
	if challenge == nil || !challenge.HttpOnly {
		t.Fatalf("пропуск на второй шаг не выставлен или доступен из JS: %+v", challenge)
	}
	// В пропуске — тот, кто вводил пароль.
	got, ok := h.readUserIntent(twoFactorIntentLabel, challenge.Value)
	if !ok || got != user.ID {
		t.Fatalf("в пропуске id = %v (ok=%v), ожидался %v", got, ok, user.ID)
	}
}

func TestLoginTwoFactor_WithoutChallengeIs401(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	_, mux := newTestAuthHandler(svc)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login-2fa",
		strings.NewReader(`{"code":"123456"}`)))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
	if svc.completedCode != "" {
		t.Fatal("сервис вызван без пропуска — код можно было бы перебирать без первого шага")
	}
}

func TestLoginTwoFactor_ForgedChallengeIs401(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	_, mux := newTestAuthHandler(svc)

	// Подпись не сходится — пропуска нет. Иначе достаточно было бы подставить
	// в cookie чужой id и подобрать шестизначный код.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login-2fa", strings.NewReader(`{"code":"123456"}`))
	req.AddCookie(&http.Cookie{Name: twoFactorCookie, Value: user.ID.String() + ":9999999999:not-a-signature"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
	if svc.completedCode != "" {
		t.Fatal("сервис вызван по поддельному пропуску")
	}
}

// Перебор кода ограничен по АККАУНТУ, а не только по адресу. Ведро по IP здесь
// пермиссивно намеренно: атакующий с пула адресов обходит его бесплатно, и
// единственная величина, которую этот эндпоинт обязан ограничивать, — попытки
// по конкретному аккаунту.
func TestLoginTwoFactor_LimitedPerAccount(t *testing.T) {
	victim := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: victim, completeErr: domain.ErrInvalidCredentials}
	// Пополнения нет: ведро отмеряет ровно два неверных кода.
	h, mux := newTestAuthHandlerLimited(svc, ratelimit.NewTokenBucket(0, 2))

	attempt := func(userID uuid.UUID) int {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login-2fa", strings.NewReader(`{"code":"123456"}`))
		req.AddCookie(&http.Cookie{Name: twoFactorCookie, Value: h.signUserIntent(twoFactorIntentLabel, userID)})
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}

	for i := range 2 {
		if code := attempt(victim.ID); code != http.StatusUnauthorized {
			t.Fatalf("попытка %d: статус = %d, ожидалось 401 (неверный код)", i+1, code)
		}
	}

	calls := svc.completeCalls
	if code := attempt(victim.ID); code != http.StatusTooManyRequests {
		t.Fatalf("третья попытка: статус = %d, ожидалось 429", code)
	}
	if svc.completeCalls != calls {
		t.Fatal("код ушёл в проверку сверх лимита — ведро не считает попытки, а только красит ответ")
	}

	// Ключ — аккаунт, а не процесс: сосед, которого никто не перебирает, входит
	// как ни в чём не бывало. Иначе один перебираемый аккаунт запирал бы всех.
	if code := attempt(domain.NewID()); code != http.StatusUnauthorized {
		t.Fatalf("другой аккаунт: статус = %d, ожидалось 401 — ведро оказалось общим", code)
	}
}

func TestLoginTwoFactor_SuccessOpensSessionAndBurnsChallenge(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	h, mux := newTestAuthHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login-2fa", strings.NewReader(`{"code":"123456"}`))
	req.AddCookie(&http.Cookie{Name: twoFactorCookie, Value: h.signUserIntent(twoFactorIntentLabel, user.ID)})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}
	if svc.completedUser != user.ID || svc.completedCode != "123456" {
		t.Fatalf("в сервис уехало user=%v code=%q", svc.completedUser, svc.completedCode)
	}
	if c := cookieByName(rec.Result().Cookies(), sessionCookieName); c == nil {
		t.Fatal("сессия не открыта")
	}
	// Пропуск одноразовый: он выполнил работу и не должен пережить вход.
	if c := cookieByName(rec.Result().Cookies(), twoFactorCookie); c == nil || c.MaxAge >= 0 {
		t.Fatalf("пропуск не погашен: %+v", c)
	}
}

func TestLoginTwoFactor_SuccessSetsDeviceCookie(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	h, mux := newTestAuthHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login-2fa", strings.NewReader(`{"code":"123456"}`))
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0) Chrome/120")
	req.AddCookie(&http.Cookie{Name: twoFactorCookie, Value: h.signUserIntent(twoFactorIntentLabel, user.ID)})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}
	c := cookieByName(rec.Result().Cookies(), knownDeviceCookie)
	if c == nil || c.Value == "" {
		t.Fatalf("cookie знакомого устройства не поставлена: %+v", c)
	}
	// Мина: без неё следующий вход с этой же машины снова потребует код.
	if c.MaxAge <= int(DefaultSessionTTL.Seconds()) {
		t.Fatalf("знакомство живёт не дольше сессии: MaxAge=%d", c.MaxAge)
	}
	if svc.completedDevice.UserAgent == "" {
		t.Fatal("User-Agent не доехал до сервиса — метка устройства будет пустой")
	}
}

// Транспорт обязан довозить cookie знакомого браузера до сервиса: без неё
// знакомое устройство станет незнакомым и код спросят снова.
func TestLogin_CarriesDeviceCookieToService(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	_, mux := newTestAuthHandler(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login",
		strings.NewReader(`{"email":"a@b.com","password":"supersecret"}`))
	req.AddCookie(&http.Cookie{Name: knownDeviceCookie, Value: "device-token"})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}
	if svc.loginDevice.Token != "device-token" {
		t.Fatalf("токен устройства не доехал: %q", svc.loginDevice.Token)
	}
}

func TestResendLoginCode_WithoutChallengeIs401(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	_, mux := newTestAuthHandler(svc)

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login-2fa/resend", nil))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
	if svc.resendCodeUser != uuid.Nil {
		t.Fatal("код отправлен без пропуска на второй шаг")
	}
}

func TestEnableTwoFactor_NeedsPasswordAndReturnsProfile(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	rec := httptest.NewRecorder()
	req := withSession(httptest.NewRequest(http.MethodPost, "/api/v1/account/2fa/enable",
		strings.NewReader(`{"currentPassword":"supersecret"}`)))
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}
	if svc.enabledPassword != "supersecret" {
		t.Fatalf("пароль не доехал до сервиса: %q", svc.enabledPassword)
	}
	var got userResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("тело не разбирается: %v", err)
	}
	// Кабинет патчит этим ответом кэш профиля целиком: соврать про фактор здесь
	// значит показать выключённым только что включённое.
	if !got.TwoFactorEnabled {
		t.Fatal("ответ не отражает включённый фактор")
	}
}

// Забывание устройств гасит и cookie знакомства: оставленная, она пережила бы
// сама себя и на следующем включении ничего не значила.
func TestForgetAllDevices_ExpiresDeviceCookie(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	rec := httptest.NewRecorder()
	req := withSession(httptest.NewRequest(http.MethodDelete, "/api/v1/account/devices", nil))
	req.AddCookie(&http.Cookie{Name: knownDeviceCookie, Value: "device-token"})
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ожидалось 204; тело=%s", rec.Code, rec.Body)
	}
	if svc.forgetAllCalls != 1 {
		t.Fatalf("сервис вызван %d раз", svc.forgetAllCalls)
	}
	if svc.forgetAllSession != "live-session" {
		t.Fatalf("текущая сессия не доехала: %q", svc.forgetAllSession)
	}
	if c := cookieByName(rec.Result().Cookies(), knownDeviceCookie); c == nil || c.MaxAge >= 0 {
		t.Fatalf("cookie устройства не погашена: %+v", c)
	}
}

func TestTwoFactorRoutes_RequireCSRF(t *testing.T) {
	// Все — мутации над собственным аккаунтом; сессии без CSRF-заголовка
	// недостаточно (иначе чужая страница включит или выключит фактор).
	for _, path := range []string{"/api/v1/account/2fa/enable", "/api/v1/account/2fa/disable", "/api/v1/account/2fa/send-code"} {
		t.Run(path, func(t *testing.T) {
			svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
			srv := newTestAccountHandler(svc)

			req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"currentPassword":"x"}`))
			req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
			req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
			rec := httptest.NewRecorder()
			srv.ServeHTTP(rec, req)

			if rec.Code != http.StatusForbidden {
				t.Fatalf("статус = %d, ожидалось 403", rec.Code)
			}
		})
	}
}

// Забывание устройств — тоже мутация, и DELETE без CSRF-заголовка обязан
// отказывать: иначе чужая страница разлогинивает хозяина.
func TestDeviceRoutes_RequireCSRF(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	req := httptest.NewRequest(http.MethodDelete, "/api/v1/account/devices", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("статус = %d, ожидалось 403", rec.Code)
	}
	if svc.forgetAllCalls != 0 {
		t.Fatal("устройства забыты запросом без CSRF")
	}
}
