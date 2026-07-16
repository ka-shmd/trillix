package httpserver

import (
	"net/http"
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
