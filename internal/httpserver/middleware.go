package httpserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"time"
)

type ctxKey int

const ctxKeyLogger ctxKey = iota

// RouteRegistrar регистрирует маршруты модуля на общем mux.
type RouteRegistrar func(mux *http.ServeMux)

// Middleware — обёртка http.Handler.
type Middleware func(http.Handler) http.Handler

// chain оборачивает h списком middleware; первый в списке — внешний.
func chain(h http.Handler, mws ...Middleware) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

// loggerFrom достаёт логгер с request_id из контекста; вне запроса — default.
func loggerFrom(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(ctxKeyLogger).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

// withRequestID генерирует request_id, кладёт логгер с ним в контекст и отдаёт
// его в заголовке ответа — каждая строка лога любого слоя привязана к запросу.
func withRequestID(base *slog.Logger) Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := newRequestID()
			w.Header().Set("X-Request-Id", id)
			log := base.With(slog.String("request_id", id))
			ctx := context.WithValue(r.Context(), ctxKeyLogger, log)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// withRecover превращает панику в 500, не роняя процесс.
func withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				loggerFrom(r.Context()).Error("panic recovered", slog.Any("panic", rec))
				WriteJSON(w, r, http.StatusInternalServerError,
					errorEnvelope{Error: errorBody{Code: "internal", Message: "internal server error"}})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// withRequestLog пишет сводную строку на каждый запрос.
func withRequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		loggerFrom(r.Context()).Info("request",
			slog.String("method", r.Method),
			slog.String("path", r.URL.Path),
			slog.Int("status", sw.status),
			slog.Duration("duration", time.Since(start)),
		)
	})
}

// statusWriter запоминает первый записанный статус для лога.
type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wroteHeader {
		w.status = code
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func newRequestID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
