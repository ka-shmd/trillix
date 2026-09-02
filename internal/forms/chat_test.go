package forms

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/ai"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
)

// Форма, над которой идёт разговор: два вопроса с живыми id — на них ссылаются
// собранные ответы, и правка обязана их сохранить.
func chatForm() json.RawMessage {
	doc, _ := json.Marshal(domain.FormSchema{
		SchemaVersion: domain.SchemaVersion,
		Blocks: []domain.Block{
			{ID: "blk_t", GroupID: "g_blk_t", Type: domain.BlockFormTitle, Text: domain.TextFromString("Запись")},
			{ID: "blk_c1", GroupID: "g_blk_n", Type: domain.BlockTitle, Text: domain.TextFromString("Ваше имя")},
			{ID: "blk_n", GroupID: "g_blk_n", Type: domain.BlockShortText, Required: true},
			{ID: "blk_c2", GroupID: "g_blk_p", Type: domain.BlockTitle, Text: domain.TextFromString("Телефон")},
			{ID: "blk_p", GroupID: "g_blk_p", Type: domain.BlockPhone},
		},
	})
	return doc
}

func chatService(gen Generator, plans *fakePlans) (*Service, *fakeStore) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID(), DraftSchema: chatForm()}}
	return NewService(nil, fakeTx{}, store, &fakeAccess{}, plans).WithAI(gen), store
}

const editAnswer = `{"action":"edit_form","reply":"Добавил вопрос про бюджет.","title":"",
 "add":[{"after":"q2","item":{"type":"number","text":"Бюджет","required":false,"options":[],"scaleMin":0,"scaleMax":0}}],
 "update":[],"remove":[],"move":[]}`

const answerOnly = `{"action":"answer","reply":"В форме два вопроса: имя и телефон.","title":"",
 "add":[],"update":[],"remove":[],"move":[]}`

func TestChat(t *testing.T) {
	t.Run("правка возвращает документ, сохраняя id", func(t *testing.T) {
		plans := &fakePlans{allowed: true}
		svc, store := chatService(ai.NewFake(editAnswer), plans)

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID,
			"добавь вопрос про бюджет", nil, store.form.DraftSchema)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		if res.Reply != "Добавил вопрос про бюджет." {
			t.Errorf("ответ ассистента = %q", res.Reply)
		}
		schema, err := domain.ValidateSchema(res.Schema)
		if err != nil {
			t.Fatalf("правленый документ не проходит ValidateSchema: %v", err)
		}
		ids := map[string]bool{}
		for _, b := range schema.Blocks {
			ids[b.ID] = true
		}
		for _, id := range []string{"blk_t", "blk_c1", "blk_n", "blk_c2", "blk_p"} {
			if !ids[id] {
				t.Errorf("правка потеряла блок %s — на него ссылаются ответы", id)
			}
		}
		if got := domain.ProjectForm(schema); len(got.Items) != 3 || got.Items[2].Type != domain.BlockNumber {
			t.Errorf("после правки пункты = %+v", got.Items)
		}
		if len(plans.consumed) != 1 {
			t.Errorf("списаний = %d, ожидалось одно на сообщение", len(plans.consumed))
		}
	})

	t.Run("ответ словами документ не трогает", func(t *testing.T) {
		plans := &fakePlans{allowed: true}
		svc, store := chatService(ai.NewFake(answerOnly), plans)

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID,
			"что тут спрашивается?", nil, nil)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		if res.Schema != nil {
			t.Errorf("ассистент вернул документ, хотя только отвечал: %s", res.Schema)
		}
		if !strings.Contains(res.Reply, "два вопроса") {
			t.Errorf("ответ = %q", res.Reply)
		}
		// Сообщение списывается и за ответ словами: вызов модели состоялся.
		if len(plans.consumed) != 1 {
			t.Errorf("списаний = %d", len(plans.consumed))
		}
	})

	t.Run("в модель едет форма и запрет на ответы респондентов", func(t *testing.T) {
		fake := ai.NewFake(answerOnly)
		svc, store := chatService(fake, &fakePlans{allowed: true})

		if _, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID,
			"что тут спрашивается?", nil, nil); err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		req := fake.Requests()[0]
		for _, want := range []string{"q1", "Ваше имя", "Телефон", "short_text", "Текущая форма"} {
			if !strings.Contains(req.System, want) {
				t.Errorf("в инструкции нет %q — модель формы не увидит", want)
			}
		}
		if !strings.Contains(req.System, "ответов респондентов") {
			t.Error("модели не сказано, что ответов респондентов у неё нет")
		}
		if req.User != "что тут спрашивается?" {
			t.Errorf("реплика автора = %q", req.User)
		}
	})

	// Потолок истории — не оптимизация: без него каждое следующее сообщение
	// разговора дороже предыдущего.
	t.Run("в модель едут последние реплики, роли не путаются", func(t *testing.T) {
		fake := ai.NewFake(answerOnly)
		svc, store := chatService(fake, &fakePlans{allowed: true})

		var history []ChatTurn
		for i := range 30 {
			history = append(history,
				ChatTurn{Text: "вопрос " + string(rune('а'+i%32))},
				ChatTurn{Assistant: true, Text: "ответ"})
		}
		if _, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "ещё", history, nil); err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}

		got := fake.Requests()[0].History
		if len(got) != MaxChatHistory {
			t.Fatalf("реплик в контексте = %d, ожидалось %d", len(got), MaxChatHistory)
		}
		if !got[len(got)-1].Assistant {
			t.Error("последней в истории обязана быть реплика ассистента")
		}
		if got[0].Assistant {
			t.Error("роли в истории перепутаны")
		}
	})

	t.Run("исчерпанная квота — 402 без вызова модели", func(t *testing.T) {
		fake := ai.NewFake(editAnswer)
		svc, store := chatService(fake, &fakePlans{allowed: false})

		_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "добавь вопрос", nil, nil)
		if !errors.Is(err, domain.ErrPlanRequired) {
			t.Fatalf("ошибка = %v, ожидалась ErrPlanRequired", err)
		}
		if n := len(fake.Requests()); n != 0 {
			t.Errorf("вызовов модели = %d, ожидалось ноль", n)
		}
	})

	t.Run("чужая форма — 404 без вызова модели", func(t *testing.T) {
		fake := ai.NewFake(editAnswer)
		store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID(), DraftSchema: chatForm()}}
		svc := NewService(nil, fakeTx{}, store, &fakeAccess{err: domain.ErrNotFound}, &fakePlans{allowed: true}).WithAI(fake)

		_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "добавь вопрос", nil, nil)
		if !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
		}
		if n := len(fake.Requests()); n != 0 {
			t.Errorf("вызовов модели = %d, ожидалось ноль", n)
		}
	})

	t.Run("пустая и слишком длинная реплика — 422 без вызова", func(t *testing.T) {
		for _, msg := range []string{"  ", strings.Repeat("а", MaxChatMessageLen+1)} {
			fake := ai.NewFake(editAnswer)
			svc, store := chatService(fake, &fakePlans{allowed: true})

			_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, msg, nil, nil)
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
			}
			if n := len(fake.Requests()); n != 0 {
				t.Errorf("вызовов модели = %d, ожидалось ноль", n)
			}
		}
	})

	// Негодный ответ модели чинится второй попыткой — той же, что у сборки формы.
	t.Run("негодная правка чинится второй попыткой", func(t *testing.T) {
		bad := `{"action":"edit_form","reply":"убрал","title":"","add":[],"update":[],"remove":["q99"],"move":[]}`
		fake := ai.NewFake(bad, editAnswer)
		svc, store := chatService(fake, &fakePlans{allowed: true})

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "добавь вопрос", nil, nil)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		if res.Schema == nil {
			t.Fatal("документ не вернулся")
		}
		reqs := fake.Requests()
		if len(reqs) != 2 {
			t.Fatalf("вызовов модели = %d, ожидалось два", len(reqs))
		}
		if !strings.Contains(reqs[1].User, "q99") {
			t.Errorf("во второй запрос не уехало замечание про несуществующий пункт: %q", reqs[1].User)
		}
	})

	t.Run("несогласованный ответ модели отвергается", func(t *testing.T) {
		cases := map[string]string{
			"неизвестное действие": `{"action":"delete_form","reply":"ок","title":"","add":[],"update":[],"remove":[],"move":[]}`,
			"правка без правок":    `{"action":"edit_form","reply":"поправил","title":"","add":[],"update":[],"remove":[],"move":[]}`,
			"ответ с правками":     `{"action":"answer","reply":"вот","title":"Другое","add":[],"update":[],"remove":[],"move":[]}`,
			"пустой ответ":         `{"action":"answer","reply":"  ","title":"","add":[],"update":[],"remove":[],"move":[]}`,
		}
		for name, answer := range cases {
			t.Run(name, func(t *testing.T) {
				plans := &fakePlans{allowed: true}
				svc, store := chatService(ai.NewFake(answer, answer), plans)

				_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "сделай что-нибудь", nil, nil)
				if !errors.Is(err, domain.ErrUnavailable) {
					t.Fatalf("ошибка = %v, ожидалась ErrUnavailable", err)
				}
				if len(plans.consumed) != 0 {
					t.Error("списали квоту за ответ, который не состоялся")
				}
			})
		}
	})

	t.Run("контур без модели — 404", func(t *testing.T) {
		store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID(), DraftSchema: chatForm()}}
		svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, &fakePlans{allowed: true})

		_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "привет", nil, nil)
		if !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
		}
	})

	t.Run("битый документ в теле — 422", func(t *testing.T) {
		fake := ai.NewFake(editAnswer)
		svc, store := chatService(fake, &fakePlans{allowed: true})

		_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID,
			"добавь вопрос", nil, json.RawMessage(`{"blocks":[{"type":"выдумка"}]}`))
		if !errors.Is(err, domain.ErrValidation) {
			t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
		}
		if n := len(fake.Requests()); n != 0 {
			t.Errorf("вызовов модели = %d, ожидалось ноль", n)
		}
	})
}

// Оформление через чат (слайс F). Гейт стоит НА ВХОДЕ, а не на публикации: покрасить
// форму, чтобы автор упёрся в 402 при попытке её опубликовать, — худший из вариантов.
func TestChat_Design(t *testing.T) {
	const dark = `{"action":"design","reply":"Сделал тёмную тему.","title":"","add":[],"update":[],"remove":[],"move":[],
	 "design":{"theme":"dark","font":"","accent":"","canvas":""}}`
	const blue = `{"action":"design","reply":"Покрасил в синий.","title":"","add":[],"update":[],"remove":[],"move":[],
	 "design":{"theme":"","font":"","accent":"#2563eb","canvas":""}}`

	t.Run("тема ложится на документ", func(t *testing.T) {
		plans := &fakePlans{allowed: true}
		svc, store := chatService(ai.NewFake(dark), plans)

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "сделай тёмной", nil, nil)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		schema, err := domain.ValidateSchema(res.Schema)
		if err != nil {
			t.Fatalf("документ с оформлением не проходит ValidateSchema: %v", err)
		}
		if schema.Design == nil || schema.Design.Theme != "dark" {
			t.Fatalf("оформление = %+v", schema.Design)
		}
		// Вопросы действие оформления не трогает.
		if len(domain.ProjectForm(schema).Items) != 2 {
			t.Errorf("вопросы изменились: %+v", domain.ProjectForm(schema).Items)
		}
	})

	t.Run("тема бесплатна и на закрытом тарифе", func(t *testing.T) {
		plans := &fakePlans{allowed: true, deny: map[entitlements.Key]bool{entitlements.FormDesignCustom: true}}
		svc, store := chatService(ai.NewFake(dark), plans)

		if _, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "сделай тёмной", nil, nil); err != nil {
			t.Fatalf("тему не пустили на бесплатном тарифе: %v", err)
		}
	})

	t.Run("только цвет на закрытом тарифе — 402, документ не тронут", func(t *testing.T) {
		plans := &fakePlans{allowed: true, deny: map[entitlements.Key]bool{entitlements.FormDesignCustom: true}}
		svc, store := chatService(ai.NewFake(blue), plans)

		_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "покрась в синий", nil, nil)
		if !errors.Is(err, domain.ErrPlanRequired) {
			t.Fatalf("ошибка = %v, ожидалась ErrPlanRequired", err)
		}
		if !strings.Contains(err.Error(), "цвета") {
			t.Errorf("отказ не называет платную настройку: %v", err)
		}
	})

	// Замер показал, что модель нарушает указание про тариф, поэтому решает сервер:
	// бесплатное делается, платное отсекается, а ответ ассистента заменяется нашим —
	// свой он написал про обе правки сразу.
	t.Run("тема с цветом на закрытом тарифе: тема встаёт, цвет объясняется", func(t *testing.T) {
		const both = `{"action":"design","reply":"Сделал тёмной и покрасил в синий.","title":"","add":[],"update":[],"remove":[],"move":[],
		 "design":{"theme":"dark","font":"","accent":"#2563eb","canvas":""}}`
		plans := &fakePlans{allowed: true, deny: map[entitlements.Key]bool{entitlements.FormDesignCustom: true}}
		svc, store := chatService(ai.NewFake(both), plans)

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "сделай тёмной и синей", nil, nil)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		schema, err := domain.ValidateSchema(res.Schema)
		if err != nil {
			t.Fatalf("документ не проходит ValidateSchema: %v", err)
		}
		if schema.Design == nil || schema.Design.Theme != "dark" {
			t.Errorf("тема не встала: %+v", schema.Design)
		}
		if schema.Design.Palette != nil && schema.Design.Palette.Accent != "" {
			t.Errorf("платный цвет применился на закрытом тарифе: %+v", schema.Design.Palette)
		}
		if !strings.Contains(res.Reply, "платная") {
			t.Errorf("ответ = %q — про платность не сказано", res.Reply)
		}
		if strings.Contains(res.Reply, "покрасил") {
			t.Errorf("ответ = %q — оставлено обещание модели, которого мы не выполнили", res.Reply)
		}
	})

	t.Run("цвет на открытом тарифе применяется", func(t *testing.T) {
		plans := &fakePlans{allowed: true}
		svc, store := chatService(ai.NewFake(blue), plans)

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "покрась в синий", nil, nil)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		schema, _ := domain.ValidateSchema(res.Schema)
		if schema.Design == nil || schema.Design.Palette == nil || schema.Design.Palette.Accent != "#2563eb" {
			t.Fatalf("оформление = %+v", schema.Design)
		}
	})

	t.Run("модели сказано про тариф", func(t *testing.T) {
		free := ai.NewFake(dark)
		svcFree, storeFree := chatService(free, &fakePlans{
			allowed: true, deny: map[entitlements.Key]bool{entitlements.FormDesignCustom: true},
		})
		_, _ = svcFree.Chat(context.Background(), domain.NewID(), storeFree.form.ID, "сделай тёмной", nil, nil)
		if !strings.Contains(free.Requests()[0].System, "платные") {
			t.Error("модели не сказано, что цвета и шрифт платные")
		}

		paid := ai.NewFake(dark)
		svcPaid, storePaid := chatService(paid, &fakePlans{allowed: true})
		_, _ = svcPaid.Chat(context.Background(), domain.NewID(), storePaid.form.ID, "сделай тёмной", nil, nil)
		if !strings.Contains(paid.Requests()[0].System, "позволяет всё") {
			t.Error("модели не сказано, что оформление доступно")
		}
	})

	t.Run("несогласованные ответы про оформление отвергаются", func(t *testing.T) {
		cases := map[string]string{
			"оформление без настроек": `{"action":"design","reply":"покрасил","title":"","add":[],"update":[],"remove":[],"move":[],
			 "design":{"theme":"","font":"","accent":"","canvas":""}}`,
			"оформление с вопросами": `{"action":"design","reply":"и то и то","title":"Другое","add":[],"update":[],"remove":[],"move":[],
			 "design":{"theme":"dark","font":"","accent":"","canvas":""}}`,
			"правка с оформлением": `{"action":"edit_form","reply":"добавил","title":"","add":[],"update":[],"remove":["q1"],"move":[],
			 "design":{"theme":"dark","font":"","accent":"","canvas":""}}`,
		}
		for name, answer := range cases {
			t.Run(name, func(t *testing.T) {
				svc, store := chatService(ai.NewFake(answer, answer), &fakePlans{allowed: true})
				_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "сделай красиво", nil, nil)
				if !errors.Is(err, domain.ErrUnavailable) {
					t.Fatalf("ошибка = %v, ожидалась ErrUnavailable", err)
				}
			})
		}
	})
}

// Диалог владельца 2026-09-02 вскрыл три дефекта оформления разом. Тесты на каждый.
func TestChat_DesignRegressions(t *testing.T) {
	// Модель пишет #FFFF00 так же охотно, как #ffff00, а схема принимает только
	// нижний регистр. Приводим сами: вторая попытка из-за регистра букв — трата
	// ожидания автора и денег.
	t.Run("цвет заглавными принимается", func(t *testing.T) {
		const upper = `{"action":"design","reply":"Сделал фон жёлтым.","title":"","add":[],"update":[],"remove":[],"move":[],
		 "design":{"theme":"","font":"","accent":"","canvas":"#FFFF00","width":0}}`
		fake := ai.NewFake(upper)
		svc, store := chatService(fake, &fakePlans{allowed: true})

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "сделай фон жёлтым", nil, nil)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		schema, err := domain.ValidateSchema(res.Schema)
		if err != nil {
			t.Fatalf("документ не проходит ValidateSchema: %v", err)
		}
		if schema.Design.Palette.Canvas != "#ffff00" {
			t.Errorf("цвет = %q, ожидался приведённым к нижнему регистру", schema.Design.Palette.Canvas)
		}
		if n := len(fake.Requests()); n != 1 {
			t.Errorf("вызовов модели = %d — регистр цвета не должен стоить второй попытки", n)
		}
	})

	// Ширина колонки просится словами («сделай пошире»), поэтому она в словаре чата.
	t.Run("ширина колонки применяется", func(t *testing.T) {
		const wide = `{"action":"design","reply":"Сделал колонку шире.","title":"","add":[],"update":[],"remove":[],"move":[],
		 "design":{"theme":"","font":"","accent":"","canvas":"","width":1200}}`
		svc, store := chatService(ai.NewFake(wide), &fakePlans{allowed: true})

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "сделай ширину 1200", nil, nil)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		schema, _ := domain.ValidateSchema(res.Schema)
		if schema.Design == nil || schema.Design.Layout == nil || schema.Design.Layout.Width == nil {
			t.Fatalf("ширина не встала: %+v", schema.Design)
		}
		if *schema.Design.Layout.Width != 1200 {
			t.Errorf("ширина = %d", *schema.Design.Layout.Width)
		}
	})

	// Негодное оформление обязано уехать МОДЕЛИ на починку, а не вылезти отказом
	// применения: пока проверка цикла смотрела только на правку вопросов, кривой
	// цвет доживал до применения и показывался автору внутренностями валидатора.
	t.Run("негодное оформление чинится второй попыткой", func(t *testing.T) {
		const bad = `{"action":"design","reply":"покрасил","title":"","add":[],"update":[],"remove":[],"move":[],
		 "design":{"theme":"","font":"","accent":"зелёный","canvas":"","width":0}}`
		const good = `{"action":"design","reply":"Покрасил акцент в зелёный.","title":"","add":[],"update":[],"remove":[],"move":[],
		 "design":{"theme":"","font":"","accent":"#16a34a","canvas":"","width":0}}`
		fake := ai.NewFake(bad, good)
		svc, store := chatService(fake, &fakePlans{allowed: true})

		res, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "покрась в зелёный", nil, nil)
		if err != nil {
			t.Fatalf("Chat() вернул ошибку: %v", err)
		}
		if len(fake.Requests()) != 2 {
			t.Fatalf("вызовов модели = %d, ожидалось два", len(fake.Requests()))
		}
		if !strings.Contains(fake.Requests()[1].User, "palette") {
			t.Errorf("во второй запрос не уехало замечание валидатора: %q", fake.Requests()[1].User)
		}
		schema, _ := domain.ValidateSchema(res.Schema)
		if schema.Design.Palette.Accent != "#16a34a" {
			t.Errorf("цвет = %q", schema.Design.Palette.Accent)
		}
	})

	// Ширина — платная настройка (ширина колонки), значит на закрытом тарифе она
	// отсекается так же, как цвет.
	t.Run("ширина на закрытом тарифе — платная", func(t *testing.T) {
		const wide = `{"action":"design","reply":"Сделал шире.","title":"","add":[],"update":[],"remove":[],"move":[],
		 "design":{"theme":"","font":"","accent":"","canvas":"","width":1200}}`
		plans := &fakePlans{allowed: true, deny: map[entitlements.Key]bool{entitlements.FormDesignCustom: true}}
		svc, store := chatService(ai.NewFake(wide), plans)

		_, err := svc.Chat(context.Background(), domain.NewID(), store.form.ID, "сделай шире", nil, nil)
		if !errors.Is(err, domain.ErrPlanRequired) {
			t.Fatalf("ошибка = %v, ожидалась ErrPlanRequired", err)
		}
		if !strings.Contains(err.Error(), "ширина колонки") {
			t.Errorf("отказ не называет платную настройку: %v", err)
		}
	})
}
