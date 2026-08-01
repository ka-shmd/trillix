//go:build integration

// Интеграционные тесты тарифов против настоящего Postgres: сюда попадает то,
// что нельзя проверить без данных миграции 0014 — каталог планов и чтение
// «план + расход» одной поездкой.
package entitlements_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
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

// Каждый план обязан назвать КАЖДУЮ возможность каталога — и значением того
// вида, который каталог обещает. Это главный сторож конструкции «ключи в коде,
// значения в данных»: без него забытый ключ в одном плане не падает, а тихо
// уходит в рантайм, где «плана молчание» однажды прочитают как «разрешено».
func TestPlansCoverCatalog(t *testing.T) {
	rows, err := testPool.Query(context.Background(), `SELECT code, limits FROM plans ORDER BY code`)
	if err != nil {
		t.Fatalf("select plans: %v", err)
	}
	defer rows.Close()

	seen := 0
	for rows.Next() {
		var code string
		var raw []byte
		if err := rows.Scan(&code, &raw); err != nil {
			t.Fatalf("scan: %v", err)
		}
		seen++

		var limits map[string]json.RawMessage
		if err := json.Unmarshal(raw, &limits); err != nil {
			t.Fatalf("план %q: limits не объект: %v", code, err)
		}

		// Каталог → план: ни одна известная возможность не забыта.
		for key, f := range entitlements.Catalog {
			val, ok := limits[string(key)]
			if !ok {
				t.Errorf("план %q молчит про возможность %q", code, key)
				continue
			}
			if err := checkKind(f.Kind, val); err != nil {
				t.Errorf("план %q, возможность %q: %v", code, key, err)
			}
		}
		// План → каталог: ключа, которого никто не спрашивает, в данных быть не
		// должно — иначе он выглядит работающим гейтом, не будучи им.
		for key := range limits {
			if _, ok := entitlements.Catalog[entitlements.Key(key)]; !ok {
				t.Errorf("план %q объявляет неизвестную каталогу возможность %q", code, key)
			}
		}
	}
	if seen == 0 {
		t.Fatal("в каталоге нет ни одного плана — миграция 0014 не сидировала тарифы")
	}
}

func checkKind(kind entitlements.Kind, raw json.RawMessage) error {
	switch kind {
	case entitlements.Toggle:
		var b bool
		return json.Unmarshal(raw, &b)
	case entitlements.Quota:
		if string(raw) == "null" {
			return nil // безлимит
		}
		var n int64
		return json.Unmarshal(raw, &n)
	default:
		return nil
	}
}

// Чтение «план + расход за период» одной поездкой: расход берётся ровно за свой
// период, чужой месяц в него не подмешивается.
func TestCheckWorkspace_ReadsPlanAndUsage(t *testing.T) {
	ctx := context.Background()
	wsID := seedWorkspace(t, "free")

	// Лимиты приезжают выключенными (спека §8) — включаем сотню для этого теста
	// тем же UPDATE, каким её включит владелец на проде.
	setLimit(t, "free", "submissions_per_month", "3")
	t.Cleanup(func() { setLimit(t, "free", "submissions_per_month", "null") })

	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	svc := entitlements.NewService(testPool, entitlements.Repo{}, func() time.Time { return now })

	// Расход прошлого месяца в текущий период не попадает.
	setUsage(t, wsID, "2026-07-01", 99)
	d, err := svc.CheckWorkspace(ctx, wsID, entitlements.SubmissionsPerMonth)
	if err != nil {
		t.Fatalf("CheckWorkspace: %v", err)
	}
	if !d.Allowed || d.Used != 0 {
		t.Fatalf("расход прошлого месяца утёк в текущий период: Allowed=%v Used=%d", d.Allowed, d.Used)
	}

	setUsage(t, wsID, "2026-08-01", 3)
	d, err = svc.CheckWorkspace(ctx, wsID, entitlements.SubmissionsPerMonth)
	if err != nil {
		t.Fatalf("CheckWorkspace: %v", err)
	}
	if d.Allowed {
		t.Error("квота исчерпана (3 из 3), а Check разрешил")
	}
	if d.Used != 3 || d.Limit == nil || *d.Limit != 3 {
		t.Errorf("Used/Limit = %d/%v, ждали 3/3", d.Used, d.Limit)
	}

	// Смена плана меняет вердикт БЕЗ перезапуска и без выкатки — главное
	// обещание фазы, проверенное там, где оно живёт.
	if _, err := testPool.Exec(ctx, `UPDATE subscriptions SET plan_code = 'pro' WHERE workspace_id = $1`, wsID); err != nil {
		t.Fatalf("смена плана: %v", err)
	}
	d, err = svc.CheckWorkspace(ctx, wsID, entitlements.SubmissionsPerMonth)
	if err != nil {
		t.Fatalf("CheckWorkspace после апгрейда: %v", err)
	}
	if !d.Allowed || d.Limit != nil {
		t.Errorf("после апгрейда: Allowed=%v Limit=%v, ждали разрешение и безлимит", d.Allowed, d.Limit)
	}
}

// Воркспейс без подписки — нарушенный инвариант регистрации, а не «всё
// разрешено»: ошибка обязана долететь до вызывающего, а не превратиться в
// молчаливое разрешение.
func TestCheckWorkspace_NoSubscriptionIsError(t *testing.T) {
	ctx := context.Background()
	wsID := uuid.New()
	if _, err := testPool.Exec(ctx,
		`INSERT INTO workspaces (id, name) VALUES ($1, 'no-plan')`, wsID); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}

	svc := entitlements.NewService(testPool, entitlements.Repo{}, nil)
	_, err := svc.CheckWorkspace(ctx, wsID, entitlements.SubmissionsPerMonth)
	if err == nil {
		t.Fatal("воркспейс без подписки обслужен молча")
	}
	if !strings.Contains(err.Error(), "нет подписки") {
		t.Errorf("ошибка не про отсутствующую подписку: %v", err)
	}
}

func seedWorkspace(t *testing.T, plan string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, `INSERT INTO workspaces (id, name) VALUES ($1, 'test')`, id); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`INSERT INTO subscriptions (workspace_id, plan_code) VALUES ($1, $2)`, id, plan); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(), `DELETE FROM workspaces WHERE id = $1`, id); err != nil {
			t.Fatalf("cleanup workspace: %v", err)
		}
	})
	return id
}

func setUsage(t *testing.T, wsID uuid.UUID, period string, n int64) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `
		INSERT INTO workspace_usage (workspace_id, period, submissions) VALUES ($1, $2::date, $3)
		ON CONFLICT (workspace_id, period) DO UPDATE SET submissions = EXCLUDED.submissions`,
		wsID, period, n); err != nil {
		t.Fatalf("set usage: %v", err)
	}
}

func setLimit(t *testing.T, plan, key, value string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, ARRAY[$2], $3::jsonb) WHERE code = $1`,
		plan, key, value); err != nil {
		t.Fatalf("set limit: %v", err)
	}
}

// Снимок тарифа для кабинета: числа те же, что в БД, а членство проверяет сам
// запрос — чужой воркспейс неотличим от несуществующего (инвариант 1).
func TestSnapshot_ReadsOwnWorkspace(t *testing.T) {
	ctx := context.Background()
	wsID := seedWorkspace(t, "free")
	userID := seedMember(t, wsID)

	setLimit(t, "free", "submissions_per_month", "10")
	t.Cleanup(func() { setLimit(t, "free", "submissions_per_month", "null") })
	now := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	setUsage(t, wsID, "2026-08-01", 7)

	svc := entitlements.NewService(testPool, entitlements.Repo{}, func() time.Time { return now })
	snap, err := svc.Snapshot(ctx, userID, wsID)
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}
	if snap.PlanCode != "free" {
		t.Errorf("план = %q, ждали free", snap.PlanCode)
	}
	d := snap.Features[entitlements.SubmissionsPerMonth]
	if d.Used != 7 || d.Limit == nil || *d.Limit != 10 || !d.Allowed {
		t.Errorf("квота = %d/%v (allowed=%v), ждали 7/10 разрешено", d.Used, d.Limit, d.Allowed)
	}
	// Расход обнулится 1 сентября — это и показывает страница тарифа.
	if got := snap.PeriodEnd.Format("2006-01-02"); got != "2026-09-01" {
		t.Errorf("конец периода = %s, ждали 2026-09-01", got)
	}
	// Аккаунт-уровневые ключи в снимок воркспейса не попадают.
	if _, ok := snap.Features[entitlements.Workspaces]; ok {
		t.Error("аккаунт-уровневый ключ показан в снимке воркспейса")
	}
}

func TestSnapshot_ForeignWorkspace_NotFound(t *testing.T) {
	ctx := context.Background()
	wsID := seedWorkspace(t, "free")
	seedMember(t, wsID) // владелец есть, но спрашивать будет посторонний

	stranger := seedWorkspace(t, "free")
	strangerUser := seedMember(t, stranger)

	svc := entitlements.NewService(testPool, entitlements.Repo{}, nil)
	if _, err := svc.Snapshot(ctx, strangerUser, wsID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали domain.ErrNotFound (анти-IDOR)", err)
	}
}

// seedMember заводит пользователя и делает его членом воркспейса.
func seedMember(t *testing.T, wsID uuid.UUID) uuid.UUID {
	t.Helper()
	id := uuid.New()
	ctx := context.Background()
	if _, err := testPool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`,
		id, "member-"+id.String()[:8]+"@example.com"); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
		wsID, id); err != nil {
		t.Fatalf("insert member: %v", err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, id); err != nil {
			t.Fatalf("cleanup user: %v", err)
		}
	})
	return id
}
