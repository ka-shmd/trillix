//go:build integration

// Завершение регистрации против настоящего Postgres: очистка брошенных регистраций и
// анкета (docs/design/signup-consent.md §1, пп. 3 и 8).
package auth_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/pgtest"
)

func setCreatedDaysAgo(t *testing.T, email string, days int) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET created_at = now() - make_interval(days => $2) WHERE email = $1`, email, days); err != nil {
		t.Fatalf("created_at: %v", err)
	}
}

func userExists(t *testing.T, email string) bool {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM users WHERE email = $1`, email).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n == 1
}

func TestDeleteAbandonedSignups(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	svc := newAuthService(t)
	register := func(email string) {
		if r := post(t, newClient(t), srv.URL+"/api/v1/auth/register",
			`{"email":"`+email+`","password":"supersecret1"}`, ""); r.StatusCode != http.StatusCreated {
			t.Fatalf("регистрация %s: %d", email, r.StatusCode)
		}
	}
	register("abandoned@example.com")
	setCreatedDaysAgo(t, "abandoned@example.com", 8)
	register("fresh@example.com")
	setCreatedDaysAgo(t, "fresh@example.com", 6)
	register("completed@example.com")
	pgtest.CompleteSignup(t, testPool, "completed@example.com")
	setCreatedDaysAgo(t, "completed@example.com", 30)
	register("legacy@example.com")
	// Так миграция 0071 отметила аккаунты, заведённые до неё.
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET signup_completed_at = now() - interval '40 days' WHERE email = 'legacy@example.com'`); err != nil {
		t.Fatal(err)
	}
	setCreatedDaysAgo(t, "legacy@example.com", 40)

	n, err := svc.DeleteAbandonedSignups(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("удалено %d, err = %v; ожидалась одна брошенная регистрация", n, err)
	}
	if userExists(t, "abandoned@example.com") {
		t.Fatal("брошенная регистрация осталась")
	}
	for _, email := range []string{"fresh@example.com", "completed@example.com", "legacy@example.com"} {
		if !userExists(t, email) {
			t.Fatalf("%s удалён", email)
		}
	}
	// Удаление строки, а не пометка: адрес свободен.
	register("abandoned@example.com")
}

func TestSignupProfile(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)
	const email = "profile@example.com"
	if r := post(t, c, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"supersecret1"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("регистрация: %d", r.StatusCode)
	}
	put := func(body string) int {
		t.Helper()
		req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/v1/account/signup-profile", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-CSRF-Token", csrfHeader(t, c, srv.URL))
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		return resp.StatusCode
	}

	if code := put(`{"kind":"company","purpose":"leads","referral":null}`); code != http.StatusForbidden {
		t.Fatalf("анкета до согласия: %d, ожидалось 403", code)
	}
	pgtest.CompleteSignup(t, testPool, email)
	if code := put(`{"kind":"robot"}`); code != http.StatusUnprocessableEntity {
		t.Fatalf("чужой вариант: %d, ожидалось 422", code)
	}
	if code := put(`{"kind":"company","purpose":"leads","fullName":"Иванов Иван","companyName":"ООО «Ромашка»","industry":"it","jobPosition":"owner"}`); code != http.StatusNoContent {
		t.Fatalf("анкета компании: %d", code)
	}
	var fullName, company, industry, occupation, profession, purpose, referral *string
	var kind string
	read := func() {
		t.Helper()
		err := testPool.QueryRow(context.Background(), `
			SELECT p.kind, p.full_name, p.company_name, p.industry, p.occupation, p.profession, p.purpose, p.referral
			FROM signup_profiles p JOIN users u ON u.id = p.user_id WHERE u.email = $1`, email).
			Scan(&kind, &fullName, &company, &industry, &occupation, &profession, &purpose, &referral)
		if err != nil {
			t.Fatal(err)
		}
	}
	read()
	if kind != "company" || fullName == nil || *fullName != "Иванов Иван" || company == nil || *company != "ООО «Ромашка»" ||
		industry == nil || *industry != "it" || purpose == nil || *purpose != "leads" {
		t.Fatalf("анкета компании в базе: %s %v %v %v %v", kind, fullName, company, industry, purpose)
	}
	// Повторная отправка частным лицом перезаписывает анкету целиком, поля компании уходят.
	if code := put(`{"kind":"person","purpose":null,"referral":"search","fullName":"Иванов Иван","occupation":"freelance","profession":"дизайнер","companyName":"ООО «Ромашка»"}`); code != http.StatusNoContent {
		t.Fatalf("повторная анкета: %d", code)
	}
	read()
	if kind != "person" || company != nil || industry != nil || occupation == nil || *occupation != "freelance" ||
		profession == nil || *profession != "дизайнер" || purpose != nil || referral == nil || *referral != "search" {
		t.Fatalf("анкета частного лица в базе: %s %v %v %v %v %v %v", kind, company, industry, occupation, profession, purpose, referral)
	}
}
