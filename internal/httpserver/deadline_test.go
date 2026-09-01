package httpserver

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Продление дедлайна — не украшение: без него ручка, работающая дольше WriteTimeout
// сервера, рвёт соединение посреди ответа, и клиент видит обрыв вместо результата.
func TestExtendWriteDeadline(t *testing.T) {
	t.Run("двигает дедлайн соединения", func(t *testing.T) {
		w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}

		ExtendWriteDeadline(w, quietLogger(), time.Minute)

		if w.deadline.IsZero() {
			t.Fatal("дедлайн не выставлен")
		}
		if left := time.Until(w.deadline); left < 50*time.Second {
			t.Errorf("дедлайн продлён на %v, просили минуту", left)
		}
	})

	// Writer без поддержки дедлайна — не повод отказывать в запросе: так ведёт себя
	// httptest и любая обёртка, не умеющая Unwrap до соединения.
	t.Run("неумеющий writer не роняет запрос, но говорит об этом", func(t *testing.T) {
		logs := &bytes.Buffer{}
		log := slog.New(slog.NewTextHandler(logs, nil))

		ExtendWriteDeadline(httptest.NewRecorder(), log, time.Minute)

		if !strings.Contains(logs.String(), "cannot extend write deadline") {
			t.Errorf("в логе нет предупреждения: %s", logs.String())
		}
	})
}

type deadlineRecorder struct {
	*httptest.ResponseRecorder
	deadline time.Time
}

func (d *deadlineRecorder) SetWriteDeadline(t time.Time) error {
	d.deadline = t
	return nil
}

var _ http.ResponseWriter = (*deadlineRecorder)(nil)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))
}
