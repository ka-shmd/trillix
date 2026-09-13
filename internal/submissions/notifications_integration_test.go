//go:build integration

// Повод кабинета «на форме новые ответы» против настоящего Postgres: склейка
// повторов в одну строку и гашение при открытии таблицы ответов. На фейках ни то
// ни другое не видно — склейку делает ON CONFLICT, а гашение UPDATE по субъекту.
package submissions_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// formOwner — форма и её владелец: адресат повода и он же тот, кто откроет
// таблицу ответов.
func formOwner(t *testing.T, slug string) (formID, userID uuid.UUID) {
	t.Helper()
	err := testPool.QueryRow(context.Background(),
		`SELECT f.id, m.user_id
		 FROM forms f
		 JOIN workspace_members m ON m.workspace_id = f.workspace_id AND m.role = 'owner'
		 WHERE f.slug = $1`, slug).Scan(&formID, &userID)
	if err != nil {
		t.Fatalf("владелец формы не найден: %v", err)
	}
	return formID, userID
}

// M ответов — одна непрочитанная строка со счётчиком M, а не M строк: виральная
// форма не имеет права превратить ленту в тысячу одинаковых строк.
func TestSubmit_CoalescesNewSubmissionsNotification(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	formID, owner := formOwner(t, slug)

	for range 3 {
		body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("приём: статус %d, ожидалось 201", resp.StatusCode)
		}
	}

	var rows, count int
	var title, formSlug string
	ctx := context.Background()
	if err := testPool.QueryRow(ctx,
		`SELECT count(*) FROM notifications WHERE user_id = $1 AND kind = 'new_submissions'`,
		owner).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("строк повода %d, ожидалась одна склеенная", rows)
	}
	err := testPool.QueryRow(ctx,
		`SELECT count, payload->>'formTitle', payload->>'formSlug'
		 FROM notifications WHERE user_id = $1 AND form_id = $2`, owner, formID).Scan(&count, &title, &formSlug)
	if err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Errorf("счётчик = %d, ожидалось 3", count)
	}
	if title != "Анкета" || formSlug != slug {
		t.Errorf("снимок повода: title=%q slug=%q", title, formSlug)
	}
}

// Открытие таблицы ответов повода НЕ гасит (решение владельца 2026-09-13):
// прочтением считается только нажатие на саму строку уведомления. Человек, зашедший
// в таблицу по своим делам, ничего не «прочитал» — и уж точно не за других.
func TestListSubmissions_KeepsNotificationUnread(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	svc := newService(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	formID, owner := formOwner(t, slug)
	ctx := context.Background()

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("приём: статус %d, ожидалось 201", resp.StatusCode)
	}

	unread := func() int {
		t.Helper()
		var n int
		if err := testPool.QueryRow(ctx,
			`SELECT count(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`, owner).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if unread() != 1 {
		t.Fatal("ответ не поднял повода")
	}

	if _, err := svc.ListForForm(ctx, owner, formID, nil, 20); err != nil {
		t.Fatalf("листинг ответов: %v", err)
	}
	if unread() != 1 {
		t.Error("открытие таблицы ответов погасило повод — прочтение ставит только нажатие")
	}

	// Второй ответ по-прежнему склеивается в ту же строку: она не прочитана.
	body = `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Пётр"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("приём: статус %d, ожидалось 201", resp.StatusCode)
	}
	var rows, count int
	if err := testPool.QueryRow(ctx,
		`SELECT count(*), max(count) FROM notifications WHERE user_id = $1`, owner).Scan(&rows, &count); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || count != 2 {
		t.Errorf("строк %d со счётчиком %d, ожидалась одна со счётчиком 2", rows, count)
	}
}

// setPlanLimit меняет лимит тарифа на время теста (лимиты — данные, а не код).
func setPlanLimit(t *testing.T, plan, key, value string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, ARRAY[$2], $3::jsonb) WHERE code = $1`,
		plan, key, value)
	if err != nil {
		t.Fatalf("правка лимита: %v", err)
	}
}

// addEditor подселяет в пространство формы участника с ролью editor.
func addEditor(t *testing.T, formID uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := context.Background()
	id := uuid.New()
	if _, err := testPool.Exec(ctx,
		`INSERT INTO users (id, email) VALUES ($1, $2)`, id, "editor-"+id.String()+"@example.com"); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	_, err := testPool.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 SELECT workspace_id, $2, 'editor' FROM forms WHERE id = $1`, formID, id)
	if err != nil {
		t.Fatalf("insert member: %v", err)
	}
	return id
}

// Сверхлимитный ответ поднимает повод о КВОТЕ и не поднимает повода о новых
// ответах; адресован он только владельцу — тариф это его дело, а редактор на
// счёт всё равно не ответит. Проверяется вся цепочка: реестр называет действие,
// workspaces отбирает по нему людей, запрос кладёт строку каждому.
func TestSubmit_OverQuota_NotifiesOwnerOnly(t *testing.T) {
	resetDB(t)
	setPlanLimit(t, "free", "submissions_per_month", "0")
	t.Cleanup(func() { setPlanLimit(t, "free", "submissions_per_month", "null") })

	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	formID, owner := formOwner(t, slug)
	editor := addEditor(t, formID)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("приём: статус %d, ожидалось 201 — квота не отказывает респонденту", resp.StatusCode)
	}

	ctx := context.Background()
	kindsOf := func(user uuid.UUID) []string {
		t.Helper()
		rows, err := testPool.Query(ctx, `SELECT kind FROM notifications WHERE user_id = $1`, user)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var k string
			if err := rows.Scan(&k); err != nil {
				t.Fatal(err)
			}
			out = append(out, k)
		}
		return out
	}

	got := kindsOf(owner)
	if len(got) != 1 || got[0] != "over_quota" {
		t.Fatalf("у владельца поводы %v, ожидался один про квоту", got)
	}
	if got := kindsOf(editor); len(got) != 0 {
		t.Fatalf("редактор получил поводы %v, а тариф — не его дело", got)
	}

	var period string
	if err := testPool.QueryRow(ctx,
		`SELECT payload->>'period' FROM notifications WHERE user_id = $1`, owner).Scan(&period); err != nil {
		t.Fatal(err)
	}
	if period == "" {
		t.Error("период в снимке пуст — на границе месяца склейку рвать будет нечем")
	}
}

// Ответ в пределах квоты адресуется ОБОИМ: формы видят и владелец, и редактор.
func TestSubmit_WithinQuota_NotifiesWholeTeam(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	formID, owner := formOwner(t, slug)
	editor := addEditor(t, formID)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("приём: статус %d, ожидалось 201", resp.StatusCode)
	}

	var n int
	err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM notifications WHERE kind = 'new_submissions' AND user_id = ANY($1)`,
		[]uuid.UUID{owner, editor}).Scan(&n)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("строк повода %d, ожидалось по одной каждому участнику", n)
	}
}
