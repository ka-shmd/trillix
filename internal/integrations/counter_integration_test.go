//go:build integration

// Счётчики аналитики формы против настоящего Postgres: подключение, правка и
// снятие, проверка номера, права постороннего и редактора, каскад при удалении
// формы и ключ тарифа во всех планах.
package integrations_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type counterDTO struct {
	Counter string `json:"counter"`
	Enabled bool   `json:"enabled"`
}

func metrikaOf(t *testing.T, c *http.Client, srv *httptest.Server, formID string) *counterDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/integrations")
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("состояние формы: статус %d", r.StatusCode)
	}
	var got struct {
		Metrika *counterDTO `json:"metrika"`
	}
	decode(t, r, &got)
	return got.Metrika
}

func putMetrika(t *testing.T, c *http.Client, srv *httptest.Server, formID, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/v1/forms/"+formID+"/counters/yandex-metrika",
		strings.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv.URL))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("PUT metrika: %v", err)
	}
	return resp
}

func deleteMetrika(t *testing.T, c *http.Client, srv *httptest.Server, formID string) *http.Response {
	t.Helper()
	return deleteWithCSRF(t, c, srv, "/api/v1/forms/"+formID+"/counters/yandex-metrika")
}

func TestCounters_Lifecycle(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-metrika")

	if got := metrikaOf(t, owner, srv, formID); got != nil {
		t.Fatalf("счётчик у новой формы: %+v, ожидалось null", got)
	}

	r := putMetrika(t, owner, srv, formID, `{"counter":"12345678"}`)
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("подключение: статус %d, ожидалось 200", r.StatusCode)
	}
	var created counterDTO
	decode(t, r, &created)
	if created != (counterDTO{Counter: "12345678", Enabled: true}) {
		t.Fatalf("ответ на подключение: %+v", created)
	}
	if got := metrikaOf(t, owner, srv, formID); got == nil || *got != created {
		t.Fatalf("счётчик в состоянии таба: %+v", got)
	}

	r = putMetrika(t, owner, srv, formID, `{"counter":"87654321","enabled":false}`)
	closeBody(t, r)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("правка: статус %d, ожидалось 200", r.StatusCode)
	}
	if got := metrikaOf(t, owner, srv, formID); got == nil || *got != (counterDTO{Counter: "87654321", Enabled: false}) {
		t.Fatalf("счётчик после правки: %+v", got)
	}

	r = deleteMetrika(t, owner, srv, formID)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("снятие: статус %d, ожидалось 204", r.StatusCode)
	}
	if got := metrikaOf(t, owner, srv, formID); got != nil {
		t.Fatalf("счётчик после снятия: %+v, ожидалось null", got)
	}
	r = deleteMetrika(t, owner, srv, formID)
	closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("повторное снятие: статус %d, ожидалось 404", r.StatusCode)
	}
}

func TestCounters_RefusesBadNumbers(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-metrika")

	for _, number := range []string{"", "abc", "12 34", "0123", "1234567890123"} {
		r := putMetrika(t, owner, srv, formID, `{"counter":"`+number+`"}`)
		body, _ := io.ReadAll(r.Body)
		closeBody(t, r)
		if r.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("номер %q: статус %d, ожидалось 422", number, r.StatusCode)
		}
		// Текст отказа доезжает до экрана как есть — только русский (web/CLAUDE.md).
		if !strings.Contains(string(body), "номер счётчика") {
			t.Errorf("номер %q: тело отказа без человеческого текста: %s", number, body)
		}
	}
	if got := metrikaOf(t, owner, srv, formID); got != nil {
		t.Fatalf("после отказов счётчик всё же сохранён: %+v", got)
	}
}

func TestCounters_StrangerGetsNotFound(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-private")
	closeBody(t, putMetrika(t, owner, srv, formID, `{"counter":"12345678"}`))
	stranger := registerUser(t, srv, "stranger@example.com")

	for name, r := range map[string]*http.Response{
		"подключение":    putMetrika(t, stranger, srv, formID, `{"counter":"99999999"}`),
		"снятие":         deleteMetrika(t, stranger, srv, formID),
		"состояние таба": do(t, stranger, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/integrations"),
	} {
		closeBody(t, r)
		if r.StatusCode != http.StatusNotFound {
			t.Errorf("%s посторонним: статус %d, ожидалось 404", name, r.StatusCode)
		}
	}
	if got := metrikaOf(t, owner, srv, formID); got == nil || got.Counter != "12345678" {
		t.Fatalf("счётчик владельца после попыток постороннего: %+v", got)
	}
}

func TestCounters_EditorManages(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")
	formID := newForm(t, wsID, "f-team")

	r := putMetrika(t, editor, srv, formID, `{"counter":"12345678"}`)
	closeBody(t, r)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("подключение редактором: статус %d, ожидалось 200", r.StatusCode)
	}
	r = deleteMetrika(t, editor, srv, formID)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("снятие редактором: статус %d, ожидалось 204", r.StatusCode)
	}
}

func TestCounters_GoneWithForm(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-metrika")
	closeBody(t, putMetrika(t, owner, srv, formID, `{"counter":"12345678"}`))

	ctx := context.Background()
	if _, err := testPool.Exec(ctx, `DELETE FROM forms WHERE id = $1`, formID); err != nil {
		t.Fatalf("удаление формы: %v", err)
	}
	var left int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM form_counters WHERE form_id = $1`, formID).Scan(&left); err != nil {
		t.Fatalf("счётчики формы: %v", err)
	}
	if left != 0 {
		t.Fatalf("после удаления формы осталось счётчиков: %d", left)
	}
}

// Счётчик — платная возможность (решение владельца 2026-09-15): закрыт на free и
// legacy_free, открыт на pro.
func TestCounters_PlanKeyIsPaid(t *testing.T) {
	want := map[string]bool{"free": false, "legacy_free": false, "pro": true}
	rows, err := testPool.Query(context.Background(), `SELECT code, (limits->>'form_counters')::boolean FROM plans`)
	if err != nil {
		t.Fatalf("планы: %v", err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var code string
		var allowed *bool
		if err := rows.Scan(&code, &allowed); err != nil {
			t.Fatalf("строка плана: %v", err)
		}
		w, known := want[code]
		if !known {
			continue
		}
		seen++
		if allowed == nil || *allowed != w {
			t.Errorf("план %s: form_counters = %v, ожидалось %v", code, allowed, w)
		}
	}
	if seen != len(want) {
		t.Fatalf("проверено планов %d из %d", seen, len(want))
	}
}
