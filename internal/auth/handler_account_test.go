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
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false)
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
