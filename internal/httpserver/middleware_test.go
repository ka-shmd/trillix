package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// deadlineWriter — фейковый ResponseWriter, умеющий SetWriteDeadline (как реальный
// *http.response). Записывает последний установленный дедлайн.
type deadlineWriter struct {
	http.ResponseWriter
	deadline time.Time
	called   bool
}

func (w *deadlineWriter) SetWriteDeadline(t time.Time) error {
	w.deadline = t
	w.called = true
	return nil
}

// Сводная строка запроса обязана нести ШАБЛОН маршрута, а не конкретный путь:
// по паттерну строки группируются в агрегатах. Тест заодно сторожит порядок
// middleware — r.Pattern пуст, если withRequestLog перестанет быть внутренним.
func TestRequestLog_IncludesRoutePattern(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&buf, nil))

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/forms/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	h := withRequestLog(mux)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/forms/42", nil)
	// Логгер запроса в контексте — как его кладёт withRequestID в проде.
	req = req.WithContext(context.WithValue(req.Context(), ctxKeyLogger, log))
	h.ServeHTTP(httptest.NewRecorder(), req)

	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &line); err != nil {
		t.Fatalf("строка лога не JSON: %v (%q)", err, buf.String())
	}
	if line["msg"] != "request" {
		t.Fatalf("msg = %v, ожидалось \"request\"", line["msg"])
	}
	if got := line["pattern"]; got != "GET /api/v1/forms/{id}" {
		t.Fatalf("pattern = %v, ожидался шаблон \"GET /api/v1/forms/{id}\" (withRequestLog не внутренний?)", got)
	}
	if got := line["path"]; got != "/api/v1/forms/42" {
		t.Fatalf("path = %v, ожидался конкретный \"/api/v1/forms/42\"", got)
	}
}

// statusWriter должен разворачиваться, иначе http.ResponseController не доберётся до
// соединения и SetWriteDeadline вернёт ErrNotSupported — стриминг-экспорт снова
// упрётся в общий WriteTimeout (TD-4).
func TestStatusWriter_UnwrapReachesDeadline(t *testing.T) {
	base := &deadlineWriter{}
	sw := &statusWriter{ResponseWriter: base, status: http.StatusOK}

	rc := http.NewResponseController(sw)
	want := time.Now().Add(30 * time.Second)
	if err := rc.SetWriteDeadline(want); err != nil {
		t.Fatalf("SetWriteDeadline через statusWriter: %v (нет Unwrap?)", err)
	}
	if !base.called {
		t.Fatal("SetWriteDeadline не дошёл до нижнего writer — цепочка Unwrap разорвана")
	}
	if !base.deadline.Equal(want) {
		t.Fatalf("дедлайн = %v, ожидался %v", base.deadline, want)
	}
}
