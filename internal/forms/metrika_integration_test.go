//go:build integration

// Счётчик Яндекс Метрики на публичном пути против настоящего Postgres (фаза 29
// DEV-PLAN, слайс C): строка формы приносит номер только включённого счётчика, а
// тариф аккаунта решает, уедет ли номер на страницу.
package forms_test

import (
	"context"
	"net/http"
	"testing"
)

// counterText — номер для сообщения теста: указатель напечатался бы адресом.
func counterText(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestPublicForm_MetrikaCounterAndPlan(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")
	svc := publicFormsSvc(t)
	ctx := context.Background()

	form := createForm(t, c, srv, "Опрос")
	detail := getFormDetail(t, c, srv, form.ID, http.StatusOK)
	patchDraftSchema(t, c, srv, form.ID,
		`{"schemaVersion":1,"blocks":[{"id":"q1","groupId":"g1","type":"short_text","settings":{}}]}`,
		detail.UpdatedAt, http.StatusOK)
	publishForm(t, c, srv, form.ID, http.StatusOK)

	// decide — что лежит в строке формы и что из этого уезжает на страницу.
	decide := func() (stored, shown string) {
		t.Helper()
		pf, err := svc.PublicForm(ctx, form.Slug)
		if err != nil {
			t.Fatalf("публичная форма: %v", err)
		}
		decided, err := svc.MetrikaFor(ctx, pf.WorkspaceID, pf.MetrikaCounter)
		if err != nil {
			t.Fatalf("решение о счётчике: %v", err)
		}
		return counterText(pf.MetrikaCounter), counterText(decided)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := testPool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
	}

	if stored, shown := decide(); stored != "<nil>" || shown != "<nil>" {
		t.Fatalf("форма без счётчика: в строке %s, на странице %s", stored, shown)
	}

	exec(`INSERT INTO form_counters (id, form_id, kind, counter) VALUES (gen_random_uuid(), $1, 'yandex_metrika', '12345678')`, form.ID)
	if stored, shown := decide(); stored != "12345678" || shown != "<nil>" {
		t.Fatalf("бесплатный тариф: в строке %s, на странице %s; ожидались номер и <nil>", stored, shown)
	}

	exec(`UPDATE subscriptions SET plan_code = 'pro' WHERE user_id = (SELECT id FROM users WHERE email = 'owner@example.com')`)
	if _, shown := decide(); shown != "12345678" {
		t.Fatalf("Pro: на странице %s, ожидался номер", shown)
	}

	exec(`UPDATE form_counters SET enabled = false WHERE form_id = $1`, form.ID)
	if stored, shown := decide(); stored != "<nil>" || shown != "<nil>" {
		t.Fatalf("выключенный счётчик: в строке %s, на странице %s", stored, shown)
	}
}
