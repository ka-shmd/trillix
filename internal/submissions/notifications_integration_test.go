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

// Открытие таблицы ответов гасит повод: человек пришёл туда, куда повод звал.
// Отметка ставится ТОМУ, кто открыл, — у остальных участников строка остаётся.
func TestListSubmissions_MarksNotificationRead(t *testing.T) {
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
	if unread() != 0 {
		t.Error("открытие таблицы ответов не погасило повод")
	}

	// Следующий ответ заводит НОВУЮ строку: к уже увиденному счётчик не
	// дописывается.
	body = `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Пётр"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("приём: статус %d, ожидалось 201", resp.StatusCode)
	}
	if unread() != 1 {
		t.Error("новый ответ после прочтения не поднял повода заново")
	}
	var count int
	if err := testPool.QueryRow(ctx,
		`SELECT count FROM notifications WHERE user_id = $1 AND read_at IS NULL`, owner).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("новая строка стартует со счётчиком %d, ожидалась 1", count)
	}
}
