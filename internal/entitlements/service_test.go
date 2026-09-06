package entitlements

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/postgres"
)

func TestDecide(t *testing.T) {
	limits := `{
		"submissions_per_month": 100,
		"workspaces": null,
		"analytics_funnel": false,
		"analytics_sources": true
	}`

	tests := []struct {
		name    string
		key     Key
		limits  string
		used    int64
		allowed bool
		wantUse int64
		limit   *int64
	}{
		{name: "квота не исчерпана", key: SubmissionsPerMonth, limits: limits, used: 99, allowed: true, wantUse: 99, limit: ptr(100)},
		// Граница: сотый ответ принят, сто первый — уже сверх. Считаем «строго
		// меньше», потому что used — это то, что УЖЕ израсходовано.
		{name: "квота исчерпана ровно", key: SubmissionsPerMonth, limits: limits, used: 100, allowed: false, wantUse: 100, limit: ptr(100)},
		{name: "квота перебрана", key: SubmissionsPerMonth, limits: limits, used: 250, allowed: false, wantUse: 250, limit: ptr(100)},
		{name: "безлимит (null) разрешает при любом расходе", key: SubmissionsPerMonth, limits: `{"submissions_per_month": null}`, used: 10_000, allowed: true, wantUse: 10_000, limit: nil},
		// Ноль — не безлимит: план, запрещающий всё, законен и должен работать.
		{name: "нулевой лимит запрещает", key: SubmissionsPerMonth, limits: `{"submissions_per_month": 0}`, used: 0, allowed: false, wantUse: 0, limit: ptr(0)},
		{name: "выключенный тумблер", key: AnalyticsFunnel, limits: limits, allowed: false},
		{name: "включённый тумблер", key: AnalyticsSources, limits: limits, allowed: true},
		// У возможности без счётчика расход всегда 0, даже если в строке он есть.
		{name: "тумблер не считает расход", key: AnalyticsSources, limits: limits, used: 42, allowed: true, wantUse: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			row := Row{PlanCode: "test", Limits: []byte(tt.limits), SubmissionsUsed: tt.used}
			got, err := decide(Catalog[tt.key], row, tt.key)
			if err != nil {
				t.Fatalf("decide: %v", err)
			}
			if got.Allowed != tt.allowed {
				t.Errorf("Allowed = %v, ждали %v", got.Allowed, tt.allowed)
			}
			if got.Used != tt.wantUse {
				t.Errorf("Used = %d, ждали %d", got.Used, tt.wantUse)
			}
			switch {
			case tt.limit == nil && got.Limit != nil:
				t.Errorf("Limit = %d, ждали безлимит (nil)", *got.Limit)
			case tt.limit != nil && got.Limit == nil:
				t.Errorf("Limit = nil (безлимит), ждали %d", *tt.limit)
			case tt.limit != nil && *got.Limit != *tt.limit:
				t.Errorf("Limit = %d, ждали %d", *got.Limit, *tt.limit)
			}
		})
	}
}

// Молчание плана про известную возможность — ошибка, а не «разрешено» и не
// «запрещено». Тихий дефолт здесь однажды раздал бы Pro бесплатно.
func TestDecide_MissingKeyIsError(t *testing.T) {
	row := Row{PlanCode: "test", Limits: []byte(`{"analytics_funnel": true}`)}
	_, err := decide(Catalog[SubmissionsPerMonth], row, SubmissionsPerMonth)
	if err == nil {
		t.Fatal("отсутствующий ключ прошёл молча")
	}
	if !strings.Contains(err.Error(), "молчит про возможность") {
		t.Errorf("ошибка не про молчание плана: %v", err)
	}
}

func TestDecide_BrokenValues(t *testing.T) {
	tests := []struct {
		name   string
		key    Key
		limits string
	}{
		{name: "квота строкой", key: SubmissionsPerMonth, limits: `{"submissions_per_month": "сто"}`},
		{name: "квота отрицательна", key: SubmissionsPerMonth, limits: `{"submissions_per_month": -1}`},
		{name: "тумблер числом", key: AnalyticsFunnel, limits: `{"analytics_funnel": 1}`},
		{name: "limits не объект", key: AnalyticsFunnel, limits: `[]`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			row := Row{PlanCode: "test", Limits: []byte(tt.limits)}
			if _, err := decide(Catalog[tt.key], row, tt.key); err == nil {
				t.Fatal("битое значение прошло молча")
			}
		})
	}
}

// Аккаунт-уровневый ключ через CheckWorkspace — ошибка вызывающего, а не
// молчаливое «нельзя»: план воркспейса на такой вопрос ответить не может.
func TestCheckWorkspace_RejectsAccountScopedKey(t *testing.T) {
	svc := NewService(nil, stubStore{}, nil)
	if _, err := svc.CheckWorkspace(context.Background(), uuid.New(), Workspaces); err == nil {
		t.Fatal("аккаунт-уровневый ключ обслужен как воркспейсный")
	}
}

func TestCheckWorkspace_RejectsUnknownKey(t *testing.T) {
	svc := NewService(nil, stubStore{}, nil)
	if _, err := svc.CheckWorkspace(context.Background(), uuid.New(), Key("выдуманный")); err == nil {
		t.Fatal("неизвестный ключ обслужен")
	}
}

// Период — календарный месяц по Москве. Проверяется именно граница месяца в
// московской полуночи: сервер живёт в UTC, и «первое число» у него наступает
// на три часа позже — расход обнулился бы не тогда, когда обещано пользователю.
func TestPeriodStart_MoscowCalendarMonth(t *testing.T) {
	tests := []struct {
		name string
		now  time.Time
		want string
	}{
		{name: "середина месяца", now: time.Date(2026, 8, 15, 12, 0, 0, 0, time.UTC), want: "2026-08-01"},
		// 31 июля 22:00 UTC — это уже 1 августа 01:00 в Москве: период августовский.
		{name: "последний вечер месяца по UTC — уже новый период в МСК", now: time.Date(2026, 7, 31, 22, 0, 0, 0, time.UTC), want: "2026-08-01"},
		// 1 августа 00:30 UTC — в Москве 03:30 того же дня: период тот же.
		{name: "ночь первого числа", now: time.Date(2026, 8, 1, 0, 30, 0, 0, time.UTC), want: "2026-08-01"},
		// 31 июля 20:00 UTC = 23:00 МСК — июль ещё не кончился.
		{name: "три часа до полуночи МСК", now: time.Date(2026, 7, 31, 20, 0, 0, 0, time.UTC), want: "2026-07-01"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := NewService(nil, stubStore{}, func() time.Time { return tt.now })
			if got := svc.PeriodStart().Format("2006-01-02"); got != tt.want {
				t.Errorf("periodStart = %s, ждали %s", got, tt.want)
			}
		})
	}
}

type stubStore struct{}

func (stubStore) Entitlements(context.Context, postgres.DBTX, uuid.UUID, time.Time) (Row, error) {
	return Row{}, nil
}

func (stubStore) EntitlementsForUser(context.Context, postgres.DBTX, uuid.UUID, uuid.UUID, time.Time) (Row, error) {
	return Row{}, nil
}

func (stubStore) AccountEntitlements(context.Context, postgres.DBTX, uuid.UUID, time.Time) (Row, error) {
	return Row{}, nil
}

func (stubStore) OwnedWorkspaceUsage(context.Context, postgres.DBTX, uuid.UUID, time.Time) ([]WorkspaceRow, error) {
	return nil, nil
}

func (stubStore) EntitlementsWithMembers(context.Context, postgres.DBTX, uuid.UUID, time.Time) (Row, error) {
	return Row{}, nil
}

func (stubStore) EntitlementsWithStorage(context.Context, postgres.DBTX, uuid.UUID, time.Time) (Row, error) {
	return Row{}, nil
}

func (stubStore) EntitlementsWithSchedules(context.Context, postgres.DBTX, uuid.UUID, time.Time) (Row, error) {
	return Row{}, nil
}

func (stubStore) BumpAIGenerations(context.Context, postgres.DBTX, uuid.UUID, time.Time) error {
	return nil
}

func ptr(v int64) *int64 { return &v }

// Каталог и его порядок обязаны совпадать по составу: ключ, забытый в
// CatalogOrder, просто не покажется на странице тарифа — молча.
func TestCatalogOrder_CoversCatalog(t *testing.T) {
	if len(CatalogOrder) != len(Catalog) {
		t.Fatalf("в CatalogOrder %d ключей, в Catalog %d", len(CatalogOrder), len(Catalog))
	}
	seen := map[Key]bool{}
	for _, k := range CatalogOrder {
		if _, ok := Catalog[k]; !ok {
			t.Errorf("CatalogOrder называет неизвестный ключ %q", k)
		}
		if seen[k] {
			t.Errorf("ключ %q повторяется в CatalogOrder", k)
		}
		seen[k] = true
	}
}
