package forms

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ka-shmd/trillix/internal/ai"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
)

const goodPlan = `{"title":"Запись в барбершоп","items":[
  {"type":"short_text","text":"Ваше имя","required":true,"options":[],"scaleMin":0,"scaleMax":0},
  {"type":"single_choice","text":"Мастер","required":false,"options":["Иван","Пётр"],"scaleMin":0,"scaleMax":0}
]}`

func generateService(store *fakeStore, plans *fakePlans, gen Generator) *Service {
	return NewService(nil, fakeTx{}, store, &fakeAccess{}, plans).WithAI(gen)
}

func TestGenerate(t *testing.T) {
	period := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)

	t.Run("собирает черновик и списывает квоту", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		plans := &fakePlans{allowed: true, period: period}
		fake := ai.NewFake(goodPlan)
		svc := generateService(store, plans, fake)

		form, err := svc.Generate(context.Background(), domain.NewID(), "анкета записи в барбершоп", nil)
		if err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		if form.Title != "Запись в барбершоп" {
			t.Errorf("заголовок формы = %q, ожидался из плана модели", form.Title)
		}
		if !store.created {
			t.Fatal("форма не создана")
		}

		// Документ, уехавший в базу, обязан проходить тот же валидатор, что стоит
		// на автосохранении, — иначе автор откроет форму и получит 422 на первую
		// же правку.
		schema, err := domain.ValidateSchema(store.lastCreateSchema)
		if err != nil {
			t.Fatalf("сохранённая схема не проходит ValidateSchema: %v", err)
		}
		if len(schema.Blocks) != 1+2+2 {
			t.Errorf("блоков в схеме = %d", len(schema.Blocks))
		}

		if len(plans.consumed) != 1 {
			t.Fatalf("списаний квоты = %d, ожидалось одно", len(plans.consumed))
		}
		if !plans.consumed[0].Equal(period) {
			t.Errorf("списание в период %v, а проверка решала про %v", plans.consumed[0], period)
		}
		if len(plans.gotKeys) != 1 || plans.gotKeys[0] != entitlements.AIGenerations {
			t.Errorf("спрошенные ключи = %v, ожидался ai_generations", plans.gotKeys)
		}
	})

	t.Run("инструкция собрана из реестра, просьба автора уезжает как есть", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		fake := ai.NewFake(goodPlan)
		svc := generateService(store, &fakePlans{allowed: true}, fake)

		if _, err := svc.Generate(context.Background(), domain.NewID(), "опрос гостей кофейни", nil); err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		reqs := fake.Requests()
		if len(reqs) != 1 {
			t.Fatalf("вызовов модели = %d", len(reqs))
		}
		if reqs[0].User != "опрос гостей кофейни" {
			t.Errorf("просьба автора = %q", reqs[0].User)
		}
		for _, want := range []string{"single_choice", "page_break", "file"} {
			if !strings.Contains(reqs[0].System, want) {
				t.Errorf("в инструкции нет типа %q — реестр до модели не доехал", want)
			}
		}
		if len(reqs[0].Schema) == 0 || reqs[0].SchemaName == "" {
			t.Error("схема ответа модели не задана — вход не удержит формат")
		}
	})

	// За отказ по квоте платить нельзя: проверка обязана стоять ДО вызова модели.
	t.Run("исчерпанная квота — 402 и ни одного вызова модели", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		fake := ai.NewFake(goodPlan)
		svc := generateService(store, &fakePlans{allowed: false}, fake)

		_, err := svc.Generate(context.Background(), domain.NewID(), "анкета", nil)
		if !errors.Is(err, domain.ErrPlanRequired) {
			t.Fatalf("ошибка = %v, ожидалась ErrPlanRequired", err)
		}
		if n := len(fake.Requests()); n != 0 {
			t.Errorf("вызовов модели = %d, ожидалось ноль", n)
		}
		if store.created {
			t.Error("форма создана вопреки отказу по квоте")
		}
	})

	t.Run("нет права на пространство — 404 и ни одного вызова модели", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		fake := ai.NewFake(goodPlan)
		svc := NewService(nil, fakeTx{}, store, &fakeAccess{err: domain.ErrNotFound}, &fakePlans{allowed: true}).WithAI(fake)

		ws := domain.NewID()
		_, err := svc.Generate(context.Background(), domain.NewID(), "анкета", &ws)
		if !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
		}
		if n := len(fake.Requests()); n != 0 {
			t.Errorf("вызовов модели = %d, ожидалось ноль", n)
		}
	})

	t.Run("пустое и слишком длинное описание — 422 без вызова", func(t *testing.T) {
		for _, prompt := range []string{"   ", strings.Repeat("а", MaxPromptLen+1)} {
			store := &fakeStore{personalWS: domain.NewID()}
			fake := ai.NewFake(goodPlan)
			svc := generateService(store, &fakePlans{allowed: true}, fake)

			_, err := svc.Generate(context.Background(), domain.NewID(), prompt, nil)
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
			}
			if n := len(fake.Requests()); n != 0 {
				t.Errorf("вызовов модели = %d, ожидалось ноль", n)
			}
		}
	})

	t.Run("провайдер недоступен — 503, форма не создана, квота цела", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		plans := &fakePlans{allowed: true}
		svc := generateService(store, plans, ai.NewFakeReplies(ai.FakeReply{Err: ai.ErrProvider}))

		_, err := svc.Generate(context.Background(), domain.NewID(), "анкета", nil)
		if !errors.Is(err, domain.ErrUnavailable) {
			t.Fatalf("ошибка = %v, ожидалась ErrUnavailable", err)
		}
		if store.created || len(plans.consumed) != 0 {
			t.Errorf("создана = %v, списаний = %d — за несостоявшийся вызов платить нечем", store.created, len(plans.consumed))
		}
	})

	t.Run("модель дважды вернула негодный план — 503 без формы", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		plans := &fakePlans{allowed: true}
		// Выбор без вариантов: валидный JSON, негодный вопрос.
		bad := `{"title":"А","items":[{"type":"dropdown","text":"Город","required":false,"options":[],"scaleMin":0,"scaleMax":0}]}`
		fake := ai.NewFake(bad, bad)
		svc := generateService(store, plans, fake)

		_, err := svc.Generate(context.Background(), domain.NewID(), "анкета", nil)
		if !errors.Is(err, domain.ErrUnavailable) {
			t.Fatalf("ошибка = %v, ожидалась ErrUnavailable", err)
		}
		if n := len(fake.Requests()); n != 2 {
			t.Errorf("вызовов модели = %d, ожидалось два (одна починка)", n)
		}
		if store.created || len(plans.consumed) != 0 {
			t.Error("форма создана либо квота списана при негодном плане")
		}
	})

	// Списание стоит ПЕРЕД созданием: форма, созданная бесплатно из-за сбоя
	// счётчика, — дыра в квоте.
	t.Run("отказ счётчика не даёт бесплатной формы", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		plans := &fakePlans{allowed: true, consumeErr: errors.New("счётчик недоступен")}
		svc := generateService(store, plans, ai.NewFake(goodPlan))

		if _, err := svc.Generate(context.Background(), domain.NewID(), "анкета", nil); err == nil {
			t.Fatal("Generate() не вернул ошибку при отказе счётчика")
		}
		if store.created {
			t.Error("форма создана, хотя генерация не списалась")
		}
	})

	t.Run("контур без модели — 404", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, &fakePlans{allowed: true})

		_, err := svc.Generate(context.Background(), domain.NewID(), "анкета", nil)
		if !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
		}

		// То же с подключённым, но выключенным генератором: composition root
		// подставляет именно его, а не nil.
		svc = generateService(store, &fakePlans{allowed: true}, ai.Disabled{})
		if _, err := svc.Generate(context.Background(), domain.NewID(), "анкета", nil); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
		}
	})

	t.Run("план без заголовка — форма с дефолтным именем", func(t *testing.T) {
		store := &fakeStore{personalWS: domain.NewID()}
		plan := `{"title":"","items":[{"type":"email","text":"Почта","required":true,"options":[],"scaleMin":0,"scaleMax":0}]}`
		svc := generateService(store, &fakePlans{allowed: true}, ai.NewFake(plan))

		form, err := svc.Generate(context.Background(), domain.NewID(), "анкета", nil)
		if err != nil {
			t.Fatalf("Generate() вернул ошибку: %v", err)
		}
		if form.Title != defaultFormTitle {
			t.Errorf("заголовок = %q, ожидался %q", form.Title, defaultFormTitle)
		}
		var schema domain.FormSchema
		if err := json.Unmarshal(store.lastCreateSchema, &schema); err != nil {
			t.Fatalf("схема не разобралась: %v", err)
		}
	})
}
