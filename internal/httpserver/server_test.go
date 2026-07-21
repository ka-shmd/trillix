package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// stubPinger подменяет Postgres: тесты healthz герметичны и не требуют Docker.
type stubPinger struct{ err error }

func (p stubPinger) Ping(context.Context) error { return p.err }

func newTestServer(t *testing.T, db Pinger) *httptest.Server {
	t.Helper()
	srv := New("127.0.0.1:0", slog.New(slog.NewJSONHandler(io.Discard, nil)), db)
	ts := httptest.NewServer(srv.Handler)
	t.Cleanup(ts.Close)
	return ts
}

func getHealthz(t *testing.T, ts *httptest.Server) (*http.Response, string) {
	t.Helper()
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	t.Cleanup(func() {
		if err := resp.Body.Close(); err != nil {
			t.Errorf("close response body: %v", err)
		}
	})
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp, string(raw)
}

func TestHealthz_DBUp_Returns200(t *testing.T) {
	ts := newTestServer(t, stubPinger{})
	resp, raw := getHealthz(t, ts)

	if resp.StatusCode != http.StatusOK {
		t.Errorf("статус = %d, ожидалось 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, ожидалось application/json", ct)
	}
	// Закэшированный посредником "ok" вернул бы ту же ложь о живости.
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, ожидалось no-store", cc)
	}

	var body struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("тело ответа не JSON: %v", err)
	}
	if body.Status != "ok" {
		t.Errorf("status = %q, ожидалось %q", body.Status, "ok")
	}
}

// Главная проверка TD-7: при мёртвой базе healthz обязан краснеть, иначе
// мониторинг фазы 10 будет зелёным на неработающем сервисе.
func TestHealthz_DBDown_Returns503(t *testing.T) {
	ts := newTestServer(t, stubPinger{err: errors.New("dial tcp 127.0.0.1:5432: connection refused")})
	resp, raw := getHealthz(t, ts)

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("статус = %d, ожидалось 503", resp.StatusCode)
	}

	var body struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("тело ответа не JSON: %v", err)
	}
	if body.Status != "unavailable" {
		t.Errorf("status = %q, ожидалось %q", body.Status, "unavailable")
	}
}

// Инвариант 7: наружу уходит только статус. Детали (DSN, хост, порт, текст
// драйвера) остаются в логе — иначе healthz становится разведкой для атакующего.
func TestHealthz_DBDown_DoesNotLeakErrorDetails(t *testing.T) {
	ts := newTestServer(t, stubPinger{err: errors.New("dial tcp 10.0.0.5:5432: connection refused")})
	_, raw := getHealthz(t, ts)

	for _, leak := range []string{"dial", "tcp", "10.0.0.5", "5432", "refused"} {
		if strings.Contains(strings.ToLower(raw), leak) {
			t.Errorf("тело healthz содержит деталь ошибки %q: %s", leak, raw)
		}
	}
}
