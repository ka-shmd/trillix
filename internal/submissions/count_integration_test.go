//go:build integration

package submissions_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Карточка «Ответы» сравнивает окно с прошлым той же длины одним сканом (спека
// design/analytics-v2.md §8): ответ тридцатичасовой давности не входит в текущие
// сутки, но входит в прошлые; у «всего времени» прошлого окна нет.
func TestCountInPeriod_PreviousWindow(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, summarySchemaV1)
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		body := `{"submission_id":"` + domain.NewID().String() + `","token":"` + freshToken() + `","answers":{}}`
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != 201 {
			t.Fatalf("приём ответа: %d", resp.StatusCode)
		}
	}
	if _, err := testPool.Exec(ctx, `
		UPDATE submissions SET created_at = now() - interval '30 hours'
		WHERE id IN (SELECT id FROM submissions ORDER BY id LIMIT 2)`); err != nil {
		t.Fatal(err)
	}

	var formID, userID uuid.UUID
	if err := testPool.QueryRow(ctx, `
		SELECT f.id, m.user_id FROM forms f
		JOIN workspace_members m ON m.workspace_id = f.workspace_id AND m.role = 'owner'
		WHERE f.slug = $1`, slug).Scan(&formID, &userID); err != nil {
		t.Fatal(err)
	}

	svc := newService(t)
	n, prev, err := svc.CountInPeriod(ctx, userID, formID, domain.Period{From: time.Now().Add(-24 * time.Hour)})
	if err != nil || n != 1 || prev == nil || *prev != 2 {
		t.Errorf("сутки: %d, прошлые %v, ошибка %v; ждали 1 и 2", n, prev, err)
	}
	n, prev, err = svc.CountInPeriod(ctx, userID, formID, domain.Period{})
	if err != nil || n != 3 || prev != nil {
		t.Errorf("всё время: %d, прошлые %v, ошибка %v", n, prev, err)
	}
}
