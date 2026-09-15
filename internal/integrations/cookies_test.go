package integrations

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Cookie похода за согласием Google живут на домене кабинета и на контуре с
// Secure носят префикс `__Host-` (ADR §10).
func TestFlowCookie_SecureContourUsesHostPrefix(t *testing.T) {
	h := &Handler{cookieSecure: true}

	rec := httptest.NewRecorder()
	h.setFlowCookie(rec, stateCookie, "state:verifier")
	c := rec.Result().Cookies()
	if len(c) != 1 || c[0].Name != "__Host-integration_state" || !c[0].Secure || c[0].Path != "/" || c[0].Domain != "" {
		t.Fatalf("cookie состояния выставлена не по правилам префикса: %+v", c)
	}

	// Подложенная с соседнего поддомена cookie без префикса не читается.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/integrations/google/callback", nil)
	req.AddCookie(&http.Cookie{Name: stateCookie, Value: "state:verifier"})
	if _, _, ok := h.readFlowCookie(req, stateCookie); ok {
		t.Fatal("прочитана cookie состояния без префикса")
	}

	req = httptest.NewRequest(http.MethodGet, "/api/v1/integrations/google/callback", nil)
	req.AddCookie(&http.Cookie{Name: "__Host-integration_state", Value: "state:verifier"})
	if state, verifier, ok := h.readFlowCookie(req, stateCookie); !ok || state != "state" || verifier != "verifier" {
		t.Fatalf("cookie с префиксом не прочитана: %q %q %v", state, verifier, ok)
	}
}
