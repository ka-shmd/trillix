//go:build integration

package submissions_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// Приём ответа на форму с согласием (design/privacy-consent.md §3.4) против настоящего
// Postgres: без галочки — 422, с ней ответ хранит ревизию, которую видел человек, даже
// если автор успел сохранить новую; удаление формы уносит и ответы, и ревизии.
func TestSubmit_Consent_EndToEnd(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	ctx := context.Background()

	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now)).
		WithSecret(testSecret)
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	user, _, err := authSvc.Register(ctx, "consent-"+uuid.NewString()[:8]+"@example.com", "supersecret1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	form, err := formsSvc.Create(ctx, user.ID, "Анкета", nil)
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, user.ID, form.ID, json.RawMessage(requiredNameSchema), form.UpdatedAt); err != nil {
		t.Fatalf("save schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, user.ID, form.ID); err != nil {
		t.Fatalf("publish: %v", err)
	}
	settings := domain.ConsentSettings{
		Operator: domain.ConsentOperator{Name: "ООО «Ромашка»", Address: "Казань", Email: "pd@romashka.ru"},
	}
	first, err := formsSvc.SaveConsent(ctx, user.ID, form.ID, true, settings)
	if err != nil {
		t.Fatalf("save consent: %v", err)
	}

	submit := func(consent string) (*http.Response, string) {
		id := uuid.NewString()
		body := `{"submission_id":"` + id + `","token":"` + freshToken() + `","answers":{"b1":"Анна"},"consent_revision":"` + consent + `"}`
		return postSubmission(t, srv, form.Slug, body), id
	}

	if resp, _ := submit(""); resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("без галочки: статус %d, ожидалось 422", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("отклонённый ответ записан: %d", n)
	}

	// Автор сохранил новую ревизию, пока человек заполнял форму по первой.
	settings.Operator.Address = "Самара"
	if _, err := formsSvc.SaveConsent(ctx, user.ID, form.ID, true, settings); err != nil {
		t.Fatalf("save consent (правка): %v", err)
	}
	resp, subID := submit(first.RevisionID.String())
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("с галочкой по прежней ревизии: статус %d, ожидалось 201", resp.StatusCode)
	}
	var stored uuid.UUID
	if err := testPool.QueryRow(ctx, `SELECT consent_revision_id FROM submissions WHERE id = $1`, subID).Scan(&stored); err != nil {
		t.Fatalf("read submission: %v", err)
	}
	if stored != *first.RevisionID {
		t.Fatalf("записана ревизия %s, ожидалась та, что видел человек, %s", stored, *first.RevisionID)
	}

	if _, err := testPool.Exec(ctx, `DELETE FROM forms WHERE id = $1`, form.ID); err != nil {
		t.Fatalf("удаление формы с ответами по ревизии: %v", err)
	}
	var revisions int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM form_consent_revisions`).Scan(&revisions); err != nil || revisions != 0 {
		t.Fatalf("после удаления формы ревизий: %d (%v)", revisions, err)
	}
}
