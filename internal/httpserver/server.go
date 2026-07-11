package httpserver

import (
	"log/slog"
	"net/http"
	"time"
)

// New собирает http.Server: healthz, маршруты модулей (registrars) и общую
// цепочку middleware (request_id → recover → лог). Таймауты обязательны —
// без них публичный эндпоинт уязвим к slowloris.
func New(addr string, log *slog.Logger, registrars ...RouteRegistrar) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz(log))
	for _, register := range registrars {
		register(mux)
	}

	handler := chain(mux, withRequestID(log), withRecover, withRequestLog)

	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
}

func handleHealthz(log *slog.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if _, err := w.Write([]byte(`{"status":"ok"}`)); err != nil {
			log.Warn("write healthz response", slog.String("error", err.Error()))
		}
	}
}
