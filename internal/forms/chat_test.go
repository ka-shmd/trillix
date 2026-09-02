package forms

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/ai"
	"github.com/ka-shmd/trillix/internal/domain"
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
