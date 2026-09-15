package integrations

import (
	"net/http"
	"strings"

	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Cookie похода за согласием провайдера живут на домене кабинета, поэтому
// читаются и ставятся только в этом файле — по той же причине и под тем же
// сторожем, что у auth: на контуре с Secure имя получает префикс `__Host-`
// (httpserver.HostCookie, ADR §10), а путь «/» без Domain — условие префикса.

// readCookie — cookie запроса по имени без префикса.
func (h *Handler) readCookie(r *http.Request, name string) (*http.Cookie, error) {
	return r.Cookie(httpserver.HostCookie(name, h.cookieSecure))
}

func (h *Handler) setFlowCookie(w http.ResponseWriter, name, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     httpserver.HostCookie(name, h.cookieSecure),
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(flowTTL.Seconds()),
	})
}

func (h *Handler) expireCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     httpserver.HostCookie(name, h.cookieSecure),
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func (h *Handler) readFlowCookie(r *http.Request, name string) (first, second string, ok bool) {
	c, err := h.readCookie(r, name)
	if err != nil {
		return "", "", false
	}
	a, b, found := strings.Cut(c.Value, ":")
	if !found || a == "" || b == "" {
		return "", "", false
	}
	return a, b, true
}
