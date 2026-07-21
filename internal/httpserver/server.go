package httpserver

import (
	"context"
	"log/slog"
	"net/http"
	"time"
)

// Pinger — живость критичной зависимости (Postgres). Интерфейс объявлен здесь,
// у потребителя, а не в пакете БД: `*pgxpool.Pool` удовлетворяет ему как есть.
type Pinger interface {
	Ping(ctx context.Context) error
}

// healthzPingTimeout — короткий: healthz обязан отвечать быстро, иначе мониторинг
// не отличит «база легла» от «проверка висит».
const healthzPingTimeout = 2 * time.Second

// New собирает http.Server: healthz, маршруты модулей (registrars) и общую
// цепочку middleware (request_id → recover → лог). Таймауты обязательны —
// без них публичный эндпоинт уязвим к slowloris.
func New(addr string, log *slog.Logger, db Pinger, registrars ...RouteRegistrar) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz(db))
	for _, register := range registrars {
		register(mux)
	}

	handler := chain(mux, withRequestID(log), withRecover, withRequestLog)

	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// WriteTimeout — страховка от slowloris на обычных ручках. Стриминг-экспорт
		// CSV переопределяет его для своего соединения через http.ResponseController
		// (продление дедлайна между чанками), иначе большой файл рвался бы на 10 с (TD-4).
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  60 * time.Second,
	}
}

// handleHealthz отвечает 200 только когда база отвечает на ping (TD-7): статичный
// "ok" делал мониторинг зелёным при мёртвом Postgres. Наружу — ровно статус, без
// деталей ошибки (инвариант 7); причина уходит в лог с request_id.
func handleHealthz(db Pinger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), healthzPingTimeout)
		defer cancel()

		status, body := http.StatusOK, `{"status":"ok"}`
		if err := db.Ping(ctx); err != nil {
			status, body = http.StatusServiceUnavailable, `{"status":"unavailable"}`
			loggerFrom(r.Context()).Error("healthz: postgres ping failed",
				slog.String("error", err.Error()))
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if _, err := w.Write([]byte(body)); err != nil {
			loggerFrom(r.Context()).Warn("write healthz response",
				slog.String("error", err.Error()))
		}
	}
}
