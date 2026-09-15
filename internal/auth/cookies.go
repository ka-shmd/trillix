package auth

import (
	"net/http"
	"strings"
	"time"

	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Cookie кабинета читаются и ставятся только в этом файле. На контуре с Secure
// имя получает префикс `__Host-` (httpserver.HostCookie, ADR §10), и чтение мимо
// readCookie в dev и тестах работало бы, а на прод-контуре молча не находило бы
// cookie. Сторож — make check-docs.
//
// Путь «/» и отсутствие Domain у каждой cookie здесь — условие префикса, а не
// выбор: `__Host-` cookie с другим путём браузер отбросит, и вход пропадёт только
// на прод-контуре.

// readCookie — cookie запроса по имени без префикса.
func (h *Handler) readCookie(r *http.Request, name string) (*http.Cookie, error) {
	return r.Cookie(httpserver.HostCookie(name, h.cookieSecure))
}

func (h *Handler) setCookie(w http.ResponseWriter, name, value string, httpOnly bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     httpserver.HostCookie(name, h.cookieSecure),
		Value:    value,
		Path:     "/",
		HttpOnly: httpOnly,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(DefaultSessionTTL.Seconds()),
	})
}

func (h *Handler) expireCookie(w http.ResponseWriter, name string, httpOnly bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     httpserver.HostCookie(name, h.cookieSecure),
		Value:    "",
		Path:     "/",
		HttpOnly: httpOnly,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func (h *Handler) setFlowCookie(w http.ResponseWriter, name, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     httpserver.HostCookie(name, h.cookieSecure),
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(oauthFlowTTL.Seconds()),
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

// setDeviceCookie ставит (или продлевает) знакомство браузера с аккаунтом.
func (h *Handler) setDeviceCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     httpserver.HostCookie(knownDeviceCookie, h.cookieSecure),
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(knownDeviceTTL / time.Second),
	})
}
