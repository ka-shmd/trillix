package forms

import (
	"context"
	"errors"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
)

// Без номера тариф не спрашивается вовсе: у подавляющего большинства форм счётчика
// нет, и лишняя поездка в БД на каждом открытии формы не роняет ничего — её видно
// только в графиках. Этот тест и сторожит.
func TestMetrikaFor_NoCounter_DoesNotAskPlans(t *testing.T) {
	plans := &fakePlans{allowed: true}
	svc := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, plans)

	got, err := svc.MetrikaFor(context.Background(), domain.NewID(), nil)
	if err != nil || got != nil {
		t.Fatalf("MetrikaFor без номера = %s, %v; ожидалось <nil>, <nil>", orNil(got), err)
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен там, где спрашивать нечего: %v", plans.gotKeys)
	}
}

func TestMetrikaFor_CounterObeysPlan(t *testing.T) {
	number := "12345678"
	ctx := context.Background()

	plans := &fakePlans{allowed: true}
	got, err := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, plans).MetrikaFor(ctx, domain.NewID(), &number)
	if err != nil || orNil(got) != number {
		t.Fatalf("тариф даёт: %s, %v; ожидался номер %s", orNil(got), err, number)
	}
	if len(plans.gotKeys) != 1 || plans.gotKeys[0] != entitlements.FormCounters {
		t.Fatalf("спрошены ключи %v, ожидался form_counters", plans.gotKeys)
	}

	// Даунгрейд снимает счётчик сам — номер в колонке остаётся, на страницу не уезжает.
	got, err = NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, &fakePlans{allowed: false}).MetrikaFor(ctx, domain.NewID(), &number)
	if err != nil || got != nil {
		t.Fatalf("тариф не даёт: %s, %v; ожидалось <nil>, <nil>", orNil(got), err)
	}

	// «Спросить не удалось» — не «можно».
	failing := &fakePlans{allowed: true, err: errors.New("база недоступна")}
	got, err = NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, failing).MetrikaFor(ctx, domain.NewID(), &number)
	if err == nil || got != nil {
		t.Fatalf("сбой опроса тарифа: %s, %v; ожидалось <nil> и ошибка", orNil(got), err)
	}
}
