//go:build integration

package visits_test

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/notify"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// Суточная проверка падения конверсии через настоящий SQL и настоящий сервис
// уведомлений: неделя 12 % против 31 % за четыре недели до неё — повод у владельца;
// конверсия вернулась — повод погас.
func TestConversionDrop_EndToEnd(t *testing.T) {
	resetDB(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)
	ctx := context.Background()

	var versionID string
	if err := testPool.QueryRow(ctx, `SELECT published_version_id FROM forms WHERE id = $1`, formID).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	seed := func(n, submitted int, daysAgo int) {
		t.Helper()
		if _, err := testPool.Exec(ctx, `
			INSERT INTO form_visits (id, form_id, form_version_id, seq, meta, submitted, created_at, updated_at)
			SELECT gen_random_uuid(), $1, $2, 0, '{}', g <= $4, now() - make_interval(days => $5), now() - make_interval(days => $5)
			FROM generate_series(1, $3) g`, formID, versionID, n, submitted, daysAgo); err != nil {
			t.Fatal(err)
		}
	}
	seed(600, 186, 20) // база
	seed(150, 18, 2)   // неделя

	ents := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	ws := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, ents, "http://localhost:5173")
	notes := notify.NewService(testPool, notify.Repo{}, ws)
	svc := funnelService().WithNotes(notes)
	log := slog.New(slog.DiscardHandler)

	unread := func() int {
		t.Helper()
		var n int
		if err := testPool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE user_id = $1 AND kind = 'conversion_drop' AND read_at IS NULL`, userID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	if n, err := svc.CheckConversionDrops(ctx, log); err != nil || n != 1 {
		t.Fatalf("в просадке %d, ошибка %v; ждали 1", n, err)
	}
	if got := unread(); got != 1 {
		t.Fatalf("непрочитанных поводов %d, ждали 1", got)
	}
	// Повторная проверка склеивается в ту же строку.
	if _, err := svc.CheckConversionDrops(ctx, log); err != nil {
		t.Fatal(err)
	}
	if got := unread(); got != 1 {
		t.Errorf("повтор дал %d строк, ждали 1", got)
	}

	// Конверсия недели вернулась — повод гаснет.
	if _, err := testPool.Exec(ctx, `UPDATE form_visits SET submitted = true WHERE form_id = $1 AND created_at > now() - interval '7 days'`, formID); err != nil {
		t.Fatal(err)
	}
	if n, err := svc.CheckConversionDrops(ctx, log); err != nil || n != 0 {
		t.Fatalf("после восстановления в просадке %d, %v", n, err)
	}
	if got := unread(); got != 0 {
		t.Errorf("повод не погас: %d", got)
	}
}
