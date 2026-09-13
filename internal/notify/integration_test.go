//go:build integration

// Интеграционный тест уведомлений против настоящего Postgres в контейнере
// (PROCESS §3): здесь проверяется то, чего фейк хранилища проверить не может, —
// коалесинг в непрочитанное, граница периода, отбой, сторож членства на чтении,
// каскады и уборка по возрасту. Гоняется под тегом `integration`.
package notify_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/notify"
	"github.com/ka-shmd/trillix/internal/pgtest"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	pool, stop, err := pgtest.Start(ctx)
	if err != nil {
		panic(err)
	}
	testPool = pool
	code := m.Run()
	stop()
	os.Exit(code)
}

func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(), `TRUNCATE users, workspaces CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// fixedAccess — адресаты, заданные тестом: права здесь не предмет проверки (их
// проверяют юниты матрицы в workspaces), предмет — SQL.
type fixedAccess struct{ users []uuid.UUID }

func (f fixedAccess) Recipients(_ context.Context, _ uuid.UUID, _ domain.Action) ([]uuid.UUID, error) {
	return f.users, nil
}

type world struct {
	svc    *notify.Service
	owner  uuid.UUID
	editor uuid.UUID
	ws     uuid.UUID
	form   uuid.UUID
}

// seed — минимальный мир: пространство, владелец, редактор и форма в нём.
func seed(t *testing.T) world {
	t.Helper()
	ctx := context.Background()
	w := world{owner: uuid.New(), editor: uuid.New(), ws: uuid.New(), form: uuid.New()}

	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := testPool.Exec(ctx, sql, args...); err != nil {
			t.Fatalf("seed (%s): %v", sql, err)
		}
	}
	exec(`INSERT INTO users (id, email) VALUES ($1, 'owner@example.com'), ($2, 'editor@example.com')`, w.owner, w.editor)
	exec(`INSERT INTO workspaces (id, name, slug) VALUES ($1, 'Команда', 'team')`, w.ws)
	exec(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor')`,
		w.ws, w.owner, w.editor)
	exec(`INSERT INTO forms (id, workspace_id, title, slug) VALUES ($1, $2, 'Заявка', 'zayavka')`, w.form, w.ws)

	w.svc = notify.NewService(testPool, notify.Repo{}, fixedAccess{users: []uuid.UUID{w.owner, w.editor}})
	return w
}

func (w world) newSubmissions(t *testing.T) {
	t.Helper()
	err := w.svc.Notify(context.Background(), testPool, notify.Event{
		WorkspaceID: w.ws, Kind: notify.KindNewSubmissions, FormID: w.form, SubjectID: w.form,
		Payload: notify.Payload{FormTitle: "Заявка", FormSlug: "zayavka"},
	})
	if err != nil {
		t.Fatalf("постановка повода: %v", err)
	}
}

func countRows(t *testing.T, where string, args ...any) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM notifications WHERE `+where, args...).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// Коалесинг: три ответа подряд дают ОДНУ непрочитанную строку на человека со
// счётчиком 3, а не три строки. Ради этого заведён частичный UNIQUE.
func TestNotify_CoalescesWhileUnread(t *testing.T) {
	resetDB(t)
	w := seed(t)

	for range 3 {
		w.newSubmissions(t)
	}

	if n := countRows(t, `kind = 'new_submissions'`); n != 2 {
		t.Fatalf("строк %d, ожидалось по одной на каждого из двух адресатов", n)
	}
	var count int32
	var first, last time.Time
	err := testPool.QueryRow(context.Background(),
		`SELECT count, first_at, last_at FROM notifications WHERE user_id = $1`, w.owner).Scan(&count, &first, &last)
	if err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Errorf("счётчик = %d, ожидалось 3", count)
	}
	if last.Before(first) {
		t.Error("last_at обязан идти за first_at")
	}
}

// Прочитанная строка в склейку не берётся: следующий ответ заводит новую, и
// «3 новых ответа» не дописываются задним числом к уже увиденному.
func TestNotify_ReadRowIsNotCoalesced(t *testing.T) {
	resetDB(t)
	w := seed(t)
	ctx := context.Background()

	w.newSubmissions(t)
	if err := w.svc.MarkAllRead(ctx, w.owner); err != nil {
		t.Fatal(err)
	}
	w.newSubmissions(t)

	if n := countRows(t, `user_id = $1`, w.owner); n != 2 {
		t.Fatalf("у прочитавшего %d строк, ожидалось 2 (старая прочитанная и новая)", n)
	}
	if n := countRows(t, `user_id = $1`, w.editor); n != 1 {
		t.Fatalf("у не читавшего %d строк, ожидалась одна склеенная", n)
	}
	var count int32
	if err := testPool.QueryRow(ctx,
		`SELECT count FROM notifications WHERE user_id = $1 AND read_at IS NULL`, w.owner).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("новая строка стартует со счётчиком %d, ожидалась 1", count)
	}
}

// Граница периода рвёт склейку: непрочитанная строка прошлого месяца не копит
// счётчик дальше, иначе «сверх лимита: 43» означало бы сумму за два месяца.
func TestNotify_QuotaResetsOnNewPeriod(t *testing.T) {
	resetDB(t)
	w := seed(t)
	ctx := context.Background()

	quota := func(period string) {
		t.Helper()
		err := w.svc.Notify(ctx, testPool, notify.Event{
			WorkspaceID: w.ws, Kind: notify.KindOverQuota, SubjectID: w.ws,
			Payload: notify.Payload{Period: period},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	quota("2026-08")
	quota("2026-08")
	var count int32
	var firstAugust time.Time
	if err := testPool.QueryRow(ctx,
		`SELECT count, first_at FROM notifications WHERE user_id = $1 AND kind = 'over_quota'`,
		w.owner).Scan(&count, &firstAugust); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("внутри периода счётчик = %d, ожидалось 2", count)
	}

	quota("2026-09")
	var firstSeptember time.Time
	if err := testPool.QueryRow(ctx,
		`SELECT count, first_at FROM notifications WHERE user_id = $1 AND kind = 'over_quota'`,
		w.owner).Scan(&count, &firstSeptember); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Errorf("на границе периода счётчик = %d, ожидался сброс в 1", count)
	}
	if !firstSeptember.After(firstAugust) {
		t.Error("first_at обязан обновиться вместе со сбросом счётчика")
	}
	if n := countRows(t, `kind = 'over_quota' AND user_id = $1`, w.owner); n != 1 {
		t.Errorf("строк повода о квоте %d, ожидалась одна живая", n)
	}
}

// Отбой гасит непрочитанные строки препятствия у всех адресатов разом, а
// прочитанные оставляет историей.
func TestClear_DropsUnreadKeepsRead(t *testing.T) {
	resetDB(t)
	w := seed(t)
	ctx := context.Background()
	target := uuid.New()

	err := w.svc.Notify(ctx, testPool, notify.Event{
		WorkspaceID: w.ws, Kind: notify.KindIntegrationBroken, FormID: w.form, SubjectID: target,
		Payload: notify.Payload{
			FormTitle: "Заявка", FormSlug: "zayavka", Target: "webhook",
			TargetName: "CRM", Reason: "Получатель не отвечает (500).",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := w.svc.MarkAllRead(ctx, w.owner); err != nil {
		t.Fatal(err)
	}

	if err := w.svc.Clear(ctx, testPool, notify.KindIntegrationBroken, target); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, `user_id = $1 AND kind = 'integration_broken'`, w.editor); n != 0 {
		t.Errorf("непрочитанная строка препятствия пережила отбой (%d)", n)
	}
	if n := countRows(t, `user_id = $1 AND kind = 'integration_broken'`, w.owner); n != 1 {
		t.Errorf("прочитанная строка обязана остаться историей (%d)", n)
	}
}

// Лента показывает только то, на что человек имеет право СЕЙЧАС: строка
// адресована ему когда-то, а членство с тех пор могло кончиться (инвариант 1).
func TestFeed_DropsRowsOfFormerMember(t *testing.T) {
	resetDB(t)
	w := seed(t)
	ctx := context.Background()
	w.newSubmissions(t)

	page, err := w.svc.Feed(ctx, w.editor, uuid.Nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Unread != 1 {
		t.Fatalf("участник не видит своей строки: %+v", page)
	}
	if page.Items[0].Text != "Заявка — 1 новый ответ" {
		t.Errorf("текст строки = %q", page.Items[0].Text)
	}
	if page.Items[0].WorkspaceName != "Команда" || page.Items[0].WorkspaceSlug != "team" {
		t.Errorf("пространство строки приехало неполным: %+v", page.Items[0])
	}

	if _, err := testPool.Exec(ctx,
		`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, w.ws, w.editor); err != nil {
		t.Fatal(err)
	}
	page, err = w.svc.Feed(ctx, w.editor, uuid.Nil, 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 || page.Unread != 0 {
		t.Fatalf("выгнанный участник видит ленту пространства: %+v", page)
	}
	// Строка при этом ещё лежит в базе — её уносит уборка, а гарантию даёт
	// сторож членства на чтении.
	if n := countRows(t, `user_id = $1`, w.editor); n != 1 {
		t.Errorf("строк в базе %d, ожидалась одна (гарантия — фильтр, а не удаление)", n)
	}
}

// Удалённая форма уносит свои уведомления каскадом: лента не показывает ссылок
// в никуда.
func TestNotifications_CascadeWithForm(t *testing.T) {
	resetDB(t)
	w := seed(t)
	w.newSubmissions(t)

	if _, err := testPool.Exec(context.Background(), `DELETE FROM forms WHERE id = $1`, w.form); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, `TRUE`); n != 0 {
		t.Errorf("после удаления формы осталось %d уведомлений", n)
	}
}

// Уборка: прочитанное живёт 30 суток, непрочитанное — 90.
func TestCleanup_ByAge(t *testing.T) {
	resetDB(t)
	w := seed(t)
	ctx := context.Background()
	w.newSubmissions(t)
	if err := w.svc.MarkAllRead(ctx, w.owner); err != nil {
		t.Fatal(err)
	}

	// Состаряем обе строки на 40 суток: прочитанная уходит, непрочитанная нет.
	if _, err := testPool.Exec(ctx,
		`UPDATE notifications SET first_at = now() - interval '40 days', read_at = read_at - interval '40 days'`); err != nil {
		t.Fatal(err)
	}
	n, err := w.svc.Cleanup(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("убрано %d строк, ожидалась одна (прочитанная)", n)
	}
	if n := countRows(t, `user_id = $1`, w.editor); n != 1 {
		t.Error("непрочитанная строка не должна была уйти в 40 суток")
	}

	if _, err := testPool.Exec(ctx, `UPDATE notifications SET first_at = now() - interval '100 days'`); err != nil {
		t.Fatal(err)
	}
	if _, err := w.svc.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, `TRUE`); n != 0 {
		t.Errorf("после 100 суток осталось %d строк", n)
	}
}
