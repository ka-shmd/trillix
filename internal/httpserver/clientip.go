package httpserver

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP возвращает IP клиента без порта для нужд rate-limit'а.
//
// Прямое подключение (trustedProxy=false) — берём host из r.RemoteAddr: это
// адрес того, кто открыл TCP-соединение, и он подделке не поддаётся.
//
// За доверенным прокси (trustedProxy=true, напр. наш Caddy) r.RemoteAddr — это
// всегда адрес самого прокси, одинаковый для всех клиентов; настоящий адрес
// прокси кладёт в X-Forwarded-For. Берём ПРАВЫЙ (last-hop) элемент списка —
// тот, что вписал ближайший к нам хоп, то есть наш собственный прокси. Левые
// значения клиент подставляет свободно, поэтому доверять можно только правому,
// и только когда мы точно знаем, что стоим за своим прокси. Если заголовка нет
// или он пуст — фолбэк на RemoteAddr.
func ClientIP(r *http.Request, trustedProxy bool) string {
	if trustedProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			last := strings.TrimSpace(parts[len(parts)-1])
			if last != "" {
				return last
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
