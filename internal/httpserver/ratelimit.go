package httpserver

import (
	"fmt"
	"net/http"

	"github.com/ka-shmd/trierra/internal/domain"
)

// RateLimiter — ведро лимитера, каким его видит транспорт. Реализация —
// ratelimit.TokenBucket; в тестах подменяется пермиссивной (инвариант 6: лимит не
// ослабляется «чтобы тест прошёл», а инжектируется другой реализацией).
type RateLimiter interface {
	Allow(key string) bool
}

// RateLimitByIP — middleware «своё ведро на эндпоинт», ключ — IP клиента.
//
// Вынесено сюда на третьем потребителе (приём ответа, логин/регистрация, визиты):
// до этого обёртка жила копией в каждом модуле, и копии уже начали расходиться —
// вычисление IP за прокси (TD-1) чинилось в одной из них. Ведро остаётся у модуля
// (у каждого эндпоинта своя ёмкость), общий здесь только способ его применить.
//
// msg уходит клиенту, поэтому он у каждого свой: «слишком много отправок» на приёме
// ответа и «слишком много запросов» на биконе — respond.go отдаст 429.
func RateLimitByIP(limiter RateLimiter, trustedProxy bool, msg string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !limiter.Allow(ClientIP(r, trustedProxy)) {
				w.Header().Set("Retry-After", "60")
				WriteError(w, r, fmt.Errorf("%w: %s", domain.ErrRateLimited, msg))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
