package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

// newTestAccountHandler поднимает mux с ОДНИМИ настройками аккаунта: маршруты
// /api/v1/account/* регистрирует AccountRoutes, и обычный newTestHandler их не
// знает.
func newTestAccountHandler(svc authService) http.Handler {
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false).
		WithAccount(ratelimit.AllowAll{}, ratelimit.AllowAll{}, ratelimit.AllowAll{})
	mux := http.NewServeMux()
	h.AccountRoutes(mux)
	return mux
}

func patchProfile(srv http.Handler, body string, authed bool) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/account/profile", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if authed {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
		req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
		req.Header.Set(csrfHeaderName, "tok")
	}
	srv.ServeHTTP(rec, req)
	return rec
}

func TestUpdateProfile_ReturnsUpdatedUser(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	srv := newTestAccountHandler(svc)

	rec := patchProfile(srv, `{"firstName":"Иван","lastName":"Петров"}`, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200; тело=%s", rec.Code, rec.Body)
	}

	var got userResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("тело не разбирается: %v", err)
	}
	if got.FirstName != "Иван" || got.LastName != "Петров" {
		t.Errorf("в ответе имя=%q фамилия=%q, ожидалось Иван/Петров", got.FirstName, got.LastName)
	}
	// Кабинет патчит кэш профиля ответом этого запроса — значит ответ обязан
	// нести весь объект пользователя, а не одни изменённые поля.
	if got.Email != user.Email {
		t.Errorf("в ответе email=%q, ожидался %q", got.Email, user.Email)
	}
}

func TestUpdateProfile_IdentityFromSessionNotBody(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	svc := &fakeAuthService{user: user}
	srv := newTestAccountHandler(svc)

	// Чужой id в теле не должен ни приниматься, ни игнорироваться молча: поля
	// userId в контракте нет, DisallowUnknownFields отвергает запрос целиком.
	rec := patchProfile(srv, `{"firstName":"Иван","lastName":"Петров","userId":"00000000-0000-0000-0000-000000000001"}`, true)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422 на неизвестное поле; тело=%s", rec.Code, rec.Body)
	}

	// А в законном запросе сервис получает id ИЗ СЕССИИ (инвариант 1).
	rec = patchProfile(srv, `{"firstName":"Иван","lastName":"Петров"}`, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("статус = %d, ожидалось 200", rec.Code)
	}
	if svc.profileUser != user.ID {
		t.Errorf("в сервис уехал id=%v, ожидался id сессии %v", svc.profileUser, user.ID)
	}
}

func TestUpdateProfile_RequiresAuth(t *testing.T) {
	svc := &fakeAuthService{}
	srv := newTestAccountHandler(svc)

	rec := patchProfile(srv, `{"firstName":"Иван","lastName":"Петров"}`, false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
	if svc.profileFirstName != "" {
		t.Error("сервис не должен вызываться без сессии")
	}
}

func TestUpdateProfile_RequiresCSRF(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	// Сессия живая, CSRF-заголовка нет → 403. Сторожит навешенность RequireCSRF
	// именно на этот роут: снять обёртку — тест краснеет.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/api/v1/account/profile", strings.NewReader(`{"firstName":"И","lastName":"П"}`))
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	srv.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("без CSRF-заголовка статус = %d, ожидалось 403", rec.Code)
	}
	if svc.profileFirstName != "" {
		t.Error("сервис не должен вызываться при провале CSRF")
	}
}

func TestUpdateProfile_RejectsOversizedBody(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	// MaxBytesReader на месте: тело больше 4 КБ не доезжает до сервиса.
	huge := `{"firstName":"` + strings.Repeat("я", 5000) + `","lastName":""}`
	rec := patchProfile(srv, huge, true)
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("статус = %d, ожидалось 422 на превышение лимита тела", rec.Code)
	}
	if svc.profileFirstName != "" {
		t.Error("сервис не должен вызываться при превышении лимита тела")
	}
}

func postPassword(srv http.Handler, body string, authed bool, csrf bool) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/account/password", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if authed {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
		req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	}
	if csrf {
		req.Header.Set(csrfHeaderName, "tok")
	}
	srv.ServeHTTP(rec, req)
	return rec
}

func TestChangePassword_ReissuesSessionCookie(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	rec := postPassword(srv, `{"currentPassword":"old-password","newPassword":"new-password"}`, true, true)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d, ожидалось 204; тело=%s", rec.Code, rec.Body)
	}

	// Сервис рвёт ВСЕ сессии, включая текущую, и возвращает токен новой.
	// Не переставить cookie здесь — значит разлогинить человека в тот момент,
	// когда он сменил себе пароль.
	session := cookieByName(rec.Result().Cookies(), sessionCookieName)
	if session == nil || session.Value != "new-session-token" {
		t.Fatalf("cookie сессии не переставлена: %+v", session)
	}
	if session.Value == "live-session" {
		t.Fatal("осталась прежняя сессия — ротация не произошла")
	}
	// CSRF-токен выдаётся парой к сессии: без него следующая мутация получит 403.
	if csrf := cookieByName(rec.Result().Cookies(), csrfCookieName); csrf == nil {
		t.Fatal("csrf-cookie не переставлена вместе с сессией")
	}
	// Тело пустое: токен сессии в JSON не отдаётся никогда.
	if rec.Body.Len() != 0 {
		t.Fatalf("тело ответа не пустое: %s", rec.Body)
	}
}

func TestChangePassword_WrongCurrentGives401(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}, passwordErr: domain.ErrInvalidCredentials}
	srv := newTestAccountHandler(svc)

	rec := postPassword(srv, `{"currentPassword":"wrong","newPassword":"new-password"}`, true, true)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("статус = %d, ожидалось 401", rec.Code)
	}
	// Провал не должен трогать cookie: человек остаётся в кабинете.
	if cookieByName(rec.Result().Cookies(), sessionCookieName) != nil {
		t.Error("при неверном текущем пароле переставлена cookie сессии")
	}
}

func TestChangePassword_RequiresAuthAndCSRF(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	srv := newTestAccountHandler(svc)

	if rec := postPassword(srv, `{"currentPassword":"a","newPassword":"b"}`, false, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("без сессии статус = %d, ожидалось 401", rec.Code)
	}
	if rec := postPassword(srv, `{"currentPassword":"a","newPassword":"b"}`, true, false); rec.Code != http.StatusForbidden {
		t.Fatalf("без CSRF-заголовка статус = %d, ожидалось 403", rec.Code)
	}
	if svc.passwordNew != "" {
		t.Error("сервис вызван при провале авторизации или CSRF")
	}
}

func TestChangePassword_RateLimitedPerUser(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}}
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false).
		WithAccount(denyLimiter{}, ratelimit.AllowAll{}, ratelimit.AllowAll{})
	mux := http.NewServeMux()
	h.AccountRoutes(mux)

	// Ведро по пользователю — щит не от подбора (сессия своя), а от argon2id:
	// 64 МиБ на вызов, и кнопка в цикле кладёт процесс.
	rec := postPassword(mux, `{"currentPassword":"old-password","newPassword":"new-password"}`, true, true)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("статус = %d, ожидалось 429", rec.Code)
	}
	if svc.passwordNew != "" {
		t.Error("сервис вызван, хотя ведро пусто — argon2 всё равно отработал")
	}
}
