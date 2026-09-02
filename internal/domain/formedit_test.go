package domain

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

// sampleForm — форма со всем, что правка обязана пережить: плейсхолдер, имя
// вопроса, свой класс, настройки страницы, картинка и условие (их модель создавать
// не умеет), опции с живыми id.
func sampleForm() FormSchema {
	lo, hi := 1, 5
	return FormSchema{
		SchemaVersion: SchemaVersion,
		Blocks: []Block{
			{ID: "blk_title", GroupID: "g_blk_title", Type: BlockFormTitle, Text: TextFromString("Запись в барбершоп")},
			{ID: "blk_cap1", GroupID: "g_blk_name", Type: BlockTitle, Text: TextFromString("Ваше имя")},
			{
				ID: "blk_name", GroupID: "g_blk_name", Type: BlockShortText, Required: true,
				Name: "имя_клиента", Class: "my-name", Settings: BlockSettings{Placeholder: "Иван"},
			},
			{ID: "blk_cap2", GroupID: "g_blk_master", Type: BlockTitle, Text: TextFromString("Мастер")},
			{ID: "blk_master", GroupID: "g_blk_master", Type: BlockSingleChoice, Settings: BlockSettings{
				Options: []Option{{ID: "opt_a", Label: "Иван"}, {ID: "opt_b", Label: "Пётр"}},
			}},
			{ID: "blk_pic", GroupID: "g_blk_pic", Type: BlockImage, Settings: BlockSettings{ImageKey: "ws/pic.png"}},
			{ID: "blk_break", GroupID: "g_blk_break", Type: BlockPageBreak, Settings: BlockSettings{PageName: "Второй шаг"}},
			{ID: "blk_scale", GroupID: "g_blk_scale", Type: BlockScale, Settings: BlockSettings{ScaleMin: &lo, ScaleMax: &hi}},
			{
				ID: "blk_ok", GroupID: "g_blk_ok", Type: BlockConsent, Required: true,
				Text: TextFromString("Согласен на обработку данных"),
			},
		},
	}
}

func blockOf(t *testing.T, s FormSchema, id string) Block {
	t.Helper()
	for _, b := range s.Blocks {
		if b.ID == id {
			return b
		}
	}
	t.Fatalf("блока %s в документе нет", id)
	return Block{}
}

func TestProjectForm(t *testing.T) {
	got := ProjectForm(sampleForm())

	if got.Title != "Запись в барбершоп" {
		t.Errorf("заголовок = %q", got.Title)
	}
	want := []struct {
		key  string
		typ  BlockType
		text string
	}{
		{"q1", BlockShortText, "Ваше имя"},
		{"q2", BlockSingleChoice, "Мастер"},
		{"q3", BlockImage, ""},
		{"q4", BlockPageBreak, ""},
		{"q5", BlockScale, ""},
		{"q6", BlockConsent, "Согласен на обработку данных"},
	}
	if len(got.Items) != len(want) {
		t.Fatalf("пунктов = %d, ожидалось %d: %+v", len(got.Items), len(want), got.Items)
	}
	for i, w := range want {
		it := got.Items[i]
		if it.Key != w.key || it.Type != w.typ || it.Text != w.text {
			t.Errorf("пункт %d = {%s %s %q}, ожидался {%s %s %q}", i, it.Key, it.Type, it.Text, w.key, w.typ, w.text)
		}
	}
	// Варианты и шкала едут значениями: без них ассистент не ответит даже на
	// «что тут спрашивается».
	if got.Items[1].Options[0] != "Иван" || got.Items[1].Options[1] != "Пётр" {
		t.Errorf("варианты = %v", got.Items[1].Options)
	}
	if got.Items[4].ScaleMin != 1 || got.Items[4].ScaleMax != 5 {
		t.Errorf("шкала = %d..%d", got.Items[4].ScaleMin, got.Items[4].ScaleMax)
	}
	// Обязательность — свойство пункта, а не подписи.
	if !got.Items[0].Required || got.Items[1].Required {
		t.Errorf("обязательность разъехалась: %+v", got.Items)
	}
}

func TestApplyChatOps(t *testing.T) {
	item := func(t BlockType, text string, opts ...string) *ChatItem {
		return &ChatItem{PlanItem: PlanItem{Type: t, Text: text, Options: opts}}
	}

	t.Run("добавляет вопрос после названного, не трогая соседей", func(t *testing.T) {
		before := sampleForm()
		out, err := ApplyChatOps(before, []ChatOp{{
			Op: OpAdd, After: "q1", Item: item(BlockPhone, "Телефон"),
		}})
		if err != nil {
			t.Fatalf("ApplyChatOps() вернул ошибку: %v", err)
		}

		// Собранный документ обязан проходить тот же валидатор, что автосохранение.
		raw, _ := json.Marshal(out)
		if _, err := ValidateSchema(raw); err != nil {
			t.Fatalf("ValidateSchema отверг результат правки: %v", err)
		}

		got := ProjectForm(out)
		if len(got.Items) != 7 || got.Items[1].Type != BlockPhone || got.Items[1].Text != "Телефон" {
			t.Fatalf("после правки пункты = %+v", got.Items)
		}
		// Все прежние id на месте — на них ссылаются ответы и воронка.
		for _, id := range []string{"blk_title", "blk_cap1", "blk_name", "blk_master", "blk_pic", "blk_break", "blk_scale", "blk_ok"} {
			blockOf(t, out, id)
		}
	})

	t.Run("правка сохраняет id и всё, чего модель не видела", func(t *testing.T) {
		out, err := ApplyChatOps(sampleForm(), []ChatOp{{
			Op: OpUpdate, Target: "q1",
			Item: &ChatItem{PlanItem: PlanItem{Type: BlockShortText, Text: "Как вас зовут?", Required: false}},
		}})
		if err != nil {
			t.Fatalf("ApplyChatOps() вернул ошибку: %v", err)
		}

		field := blockOf(t, out, "blk_name")
		if field.Settings.Placeholder != "Иван" || field.Name != "имя_клиента" || field.Class != "my-name" {
			t.Errorf("правка стёрла невидимое модели: %+v", field)
		}
		if field.Required {
			t.Error("обязательность не снялась")
		}
		if cap1 := blockOf(t, out, "blk_cap1"); PlainText(cap1.Text) != "Как вас зовут?" {
			t.Errorf("подпись = %q", PlainText(cap1.Text))
		}
	})

	// На id опции ссылаются собранные ответы: у нетронутых подписей он обязан
	// пережить правку, у новых — родиться.
	t.Run("варианты сохраняют id по подписи", func(t *testing.T) {
		out, err := ApplyChatOps(sampleForm(), []ChatOp{{
			Op: OpUpdate, Target: "q2",
			Item: item(BlockSingleChoice, "Мастер", "Пётр", "Иван", "Анна"),
		}})
		if err != nil {
			t.Fatalf("ApplyChatOps() вернул ошибку: %v", err)
		}
		opts := blockOf(t, out, "blk_master").Settings.Options
		if len(opts) != 3 {
			t.Fatalf("вариантов = %d", len(opts))
		}
		if opts[0].ID != "opt_b" || opts[1].ID != "opt_a" {
			t.Errorf("id прежних вариантов не сохранились: %+v", opts)
		}
		if !strings.HasPrefix(opts[2].ID, "opt_") || opts[2].Label != "Анна" {
			t.Errorf("новый вариант = %+v", opts[2])
		}
	})

	t.Run("убирает пункт целиком", func(t *testing.T) {
		out, err := ApplyChatOps(sampleForm(), []ChatOp{{Op: OpRemove, Target: "q2"}})
		if err != nil {
			t.Fatalf("ApplyChatOps() вернул ошибку: %v", err)
		}
		for _, b := range out.Blocks {
			if b.ID == "blk_master" || b.ID == "blk_cap2" {
				t.Errorf("после удаления остался блок %s", b.ID)
			}
		}
	})

	t.Run("двигает пункт вместе с подписью", func(t *testing.T) {
		out, err := ApplyChatOps(sampleForm(), []ChatOp{{Op: OpMove, Target: "q2", After: ""}})
		if err != nil {
			t.Fatalf("ApplyChatOps() вернул ошибку: %v", err)
		}
		if out.Blocks[0].Type != BlockFormTitle {
			t.Fatalf("заголовок формы уехал с первого места: %+v", out.Blocks[0])
		}
		if out.Blocks[1].ID != "blk_cap2" || out.Blocks[2].ID != "blk_master" {
			t.Errorf("порядок после переноса = %s, %s", out.Blocks[1].ID, out.Blocks[2].ID)
		}
	})

	t.Run("меняет заголовок формы", func(t *testing.T) {
		out, err := ApplyChatOps(sampleForm(), []ChatOp{{
			Op: OpTitle, Item: &ChatItem{PlanItem: PlanItem{Text: "Запись к мастеру"}},
		}})
		if err != nil {
			t.Fatalf("ApplyChatOps() вернул ошибку: %v", err)
		}
		if title, _ := FormTitle(out); title != "Запись к мастеру" {
			t.Errorf("заголовок = %q", title)
		}
		if blockOf(t, out, "blk_title").ID != "blk_title" {
			t.Error("блок заголовка перевыпущен, хотя должен был остаться")
		}
	})

	// Молча проигнорированная правка выглядит для автора как «ассистент сказал,
	// что сделал, и не сделал».
	t.Run("незнакомый пункт и незнакомая операция — отказ с текстом для модели", func(t *testing.T) {
		_, err := ApplyChatOps(sampleForm(), []ChatOp{{Op: OpRemove, Target: "q99"}})
		if !errors.Is(err, ErrValidation) || !strings.Contains(err.Error(), "q99") {
			t.Errorf("ошибка = %v, ожидалось упоминание q99", err)
		}
		_, err = ApplyChatOps(sampleForm(), []ChatOp{{Op: "rewrite", Target: "q1"}})
		if !errors.Is(err, ErrValidation) || !strings.Contains(err.Error(), "add") {
			t.Errorf("ошибка = %v, ожидался список допустимых операций", err)
		}
		_, err = ApplyChatOps(sampleForm(), nil)
		if !errors.Is(err, ErrValidation) {
			t.Errorf("пустой список правок принят: %v", err)
		}
	})

	t.Run("негодный пункт правки отвергается до документа", func(t *testing.T) {
		_, err := ApplyChatOps(sampleForm(), []ChatOp{{
			Op: OpAdd, After: "q1", Item: item(BlockDropdown, "Город"),
		}})
		if !errors.Is(err, ErrValidation) || !strings.Contains(err.Error(), "вариант") {
			t.Errorf("ошибка = %v, ожидался отказ по пустым вариантам", err)
		}
	})
}

// DoD фазы: в чате правок за сессию десяток, и id обязаны пережить их все.
func TestApplyChatOps_ChainKeepsIDs(t *testing.T) {
	form := sampleForm()
	chain := [][]ChatOp{
		{{Op: OpAdd, After: "q1", Item: &ChatItem{PlanItem: PlanItem{Type: BlockPhone, Text: "Телефон", Required: true}}}},
		{{Op: OpUpdate, Target: "q1", Item: &ChatItem{PlanItem: PlanItem{Type: BlockShortText, Text: "Имя и фамилия"}}}},
		{{Op: OpMove, Target: "q2", After: "q3"}},
		{{Op: OpRemove, Target: "q4"}},
		{{Op: OpTitle, Item: &ChatItem{PlanItem: PlanItem{Text: "Барбершоп"}}}},
		{{Op: OpAdd, After: "", Item: &ChatItem{PlanItem: PlanItem{Type: BlockText, Text: "Заполните за минуту"}}}},
	}

	for i, ops := range chain {
		var err error
		form, err = ApplyChatOps(form, ops)
		if err != nil {
			t.Fatalf("правка %d: %v", i+1, err)
		}
		raw, _ := json.Marshal(form)
		if _, err := ValidateSchema(raw); err != nil {
			t.Fatalf("после правки %d документ невалиден: %v", i+1, err)
		}
	}

	// Пережившие цепочку блоки — те же самые: их id держат ответы и воронку.
	for _, id := range []string{"blk_title", "blk_name", "blk_master", "blk_scale", "blk_ok"} {
		blockOf(t, form, id)
	}
	if opts := blockOf(t, form, "blk_master").Settings.Options; opts[0].ID != "opt_a" {
		t.Errorf("id вариантов не пережили цепочку: %+v", opts)
	}
}

// Правка пишет в блоки через указатели, а срез блоков делит массив с тем, кто его
// дал. Без копии вторая попытка цикла починки начинала бы с документа, испорченного
// первой.
func TestApplyChatOps_LeavesInputAlone(t *testing.T) {
	before := sampleForm()
	captionWas := PlainText(before.Blocks[1].Text)

	if _, err := ApplyChatOps(before, []ChatOp{{
		Op: OpUpdate, Target: "q1",
		Item: &ChatItem{PlanItem: PlanItem{Type: BlockShortText, Text: "Совсем другая подпись"}},
	}}); err != nil {
		t.Fatalf("ApplyChatOps() вернул ошибку: %v", err)
	}

	if got := PlainText(before.Blocks[1].Text); got != captionWas {
		t.Errorf("исходный документ изменился: подпись стала %q вместо %q", got, captionWas)
	}
}

// Сборка формы с нуля — это десяток добавлений с пустым «after». Без памяти о
// предыдущей вставке каждое лезло бы сразу за названный пункт, и список
// переворачивался: автор просил имя, телефон, дату, а получал дату, телефон, имя.
func TestApplyChatOps_AddsKeepOrder(t *testing.T) {
	empty := FormSchema{SchemaVersion: SchemaVersion}
	add := func(t BlockType, text string) ChatAdd {
		return ChatAdd{Item: ChatItem{PlanItem: PlanItem{Type: t, Text: text}}}
	}

	out, err := ApplyChatEdit(empty, ChatEdit{
		Title: ChatTitle{Text: "Запись"},
		Add:   []ChatAdd{add(BlockShortText, "Имя"), add(BlockPhone, "Телефон"), add(BlockDate, "Дата")},
	})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}

	got := ProjectForm(out)
	want := []string{"Имя", "Телефон", "Дата"}
	if len(got.Items) != len(want) {
		t.Fatalf("пунктов = %d: %+v", len(got.Items), got.Items)
	}
	for i, w := range want {
		if got.Items[i].Text != w {
			t.Errorf("пункт %d = %q, ожидался %q — порядок добавлений перевернулся", i+1, got.Items[i].Text, w)
		}
	}

	// То же посреди существующей формы: три добавления после одного пункта.
	base := sampleForm()
	out, err = ApplyChatEdit(base, ChatEdit{Add: []ChatAdd{
		{After: "q1", Item: ChatItem{PlanItem: PlanItem{Type: BlockEmail, Text: "Почта"}}},
		{After: "q1", Item: ChatItem{PlanItem: PlanItem{Type: BlockNumber, Text: "Возраст"}}},
	}})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}
	items := ProjectForm(out).Items
	if items[1].Text != "Почта" || items[2].Text != "Возраст" {
		t.Errorf("после q1 встали %q, %q — ожидались Почта, Возраст", items[1].Text, items[2].Text)
	}
}

// Собирая форму с нуля, модель нумерует пункты на ходу и ссылается на только что
// добавленный («after»: «q1»), которого в форме ещё нет. Такой якорь — промах по
// месту, а не по адресату: пункт нужен автору, и он встаёт в конец, в том порядке, в
// каком названы. Строгий отказ здесь стоил второй попытки модели, а когда она
// приходила такой же — терял весь ответ, и автор получал отказ вместо формы.
func TestApplyChatOps_UnknownAddAnchorGoesLast(t *testing.T) {
	empty := FormSchema{SchemaVersion: SchemaVersion}
	item := func(t BlockType, text string) ChatItem {
		return ChatItem{PlanItem: PlanItem{Type: t, Text: text}}
	}

	out, err := ApplyChatEdit(empty, ChatEdit{Add: []ChatAdd{
		{Item: item(BlockShortText, "Имя")},
		{After: "q1", Item: item(BlockPhone, "Телефон")},
		{After: "q2", Item: item(BlockDate, "Дата")},
	}})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}
	got := ProjectForm(out).Items
	want := []string{"Имя", "Телефон", "Дата"}
	if len(got) != len(want) {
		t.Fatalf("пунктов = %d: %+v", len(got), got)
	}
	for i, w := range want {
		if got[i].Text != w {
			t.Errorf("пункт %d = %q, ожидался %q", i+1, got[i].Text, w)
		}
	}

	// У update якорь остаётся строгим: там названный пункт и есть предмет правки.
	if _, err := ApplyChatEdit(sampleForm(), ChatEdit{
		Update: []ChatUpdate{{Target: "q9", Item: item(BlockShortText, "Ничей")}},
	}); err == nil {
		t.Error("правка несуществующего пункта прошла молча")
	}
}

// Модель охотно присылает заголовок эхом при любой просьбе. Тот же текст — не
// правка: переписывать документ ради неизменившейся строки значит гонять автосейв
// и историю впустую.
func TestApplyChatOps_SameTitleIsNoChange(t *testing.T) {
	before := sampleForm()
	out, err := ApplyChatEdit(before, ChatEdit{
		Title: ChatTitle{Text: "Запись в барбершоп"},
		Add:   []ChatAdd{{After: "q1", Item: ChatItem{PlanItem: PlanItem{Type: BlockEmail, Text: "Почта"}}}},
	})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}
	got := blockOf(t, out, "blk_title")
	if len(got.Text) != 1 || got.Text[0].T != "Запись в барбершоп" {
		t.Errorf("заголовок = %+v", got.Text)
	}
}

// Жирность и цвета подписи — марки богатого текста, и до фазы их в словаре чата не
// было вовсе: на «сделай заголовки жирными» ассистент рапортовал об успехе, а делал
// только то, что умел. Теперь оформление подписи выражается пунктом.
func TestChatItemStyle(t *testing.T) {
	t.Run("правка красит подпись целиком", func(t *testing.T) {
		out, err := ApplyChatEdit(sampleForm(), ChatEdit{Update: []ChatUpdate{{
			Target: "q1",
			Item: ChatItem{PlanItem: PlanItem{
				Type: BlockShortText, Text: "Ваше имя", Bold: true, BG: "#FFF3C4",
			}},
		}}})
		if err != nil {
			t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
		}

		raw, _ := json.Marshal(out)
		if _, err := ValidateSchema(raw); err != nil {
			t.Fatalf("документ с разметкой не проходит ValidateSchema: %v", err)
		}
		caption := blockOf(t, out, "blk_cap1")
		if len(caption.Text) != 1 {
			t.Fatalf("подпись = %+v", caption.Text)
		}
		span := caption.Text[0]
		if !slices.Contains(span.M, MarkBold) {
			t.Errorf("жирность не встала: %+v", span)
		}
		if span.BG != "#fff3c4" {
			t.Errorf("фон = %q — цвет обязан приводиться к нижнему регистру", span.BG)
		}
	})

	// Разметку видно и в проекции: иначе ассистент, спрошенный «что тут есть»,
	// пересказал бы форму без её оформления, а на правке снял бы его молча.
	t.Run("проекция показывает разметку подписи", func(t *testing.T) {
		styled := sampleForm()
		styled.Blocks[1].Text = []Span{{T: "Ваше имя", M: []Mark{MarkBold}, Color: "#123456"}}

		item := ProjectForm(styled).Items[0]
		if !item.Bold || item.Color != "#123456" {
			t.Errorf("проекция = %+v", item)
		}

		// И переживает правку, о разметке не говорящую.
		out, err := ApplyChatEdit(styled, ChatEdit{Update: []ChatUpdate{{
			Target: "q1", Item: ChatItem{PlanItem: item.PlanItem},
		}}})
		if err != nil {
			t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
		}
		if got := ProjectForm(out).Items[0]; !got.Bold || got.Color != "#123456" {
			t.Errorf("после правки разметка потерялась: %+v", got)
		}
	})

	t.Run("негодный цвет отвергается с текстом для модели", func(t *testing.T) {
		_, err := ApplyChatEdit(sampleForm(), ChatEdit{Update: []ChatUpdate{{
			Target: "q1",
			Item:   ChatItem{PlanItem: PlanItem{Type: BlockShortText, Text: "Имя", Color: "жёлтый"}},
		}}})
		if !errors.Is(err, ErrValidation) || !strings.Contains(err.Error(), "#rrggbb") {
			t.Fatalf("ошибка = %v", err)
		}
	})
}

// «Выдели заголовок фоном» приходит стилем БЕЗ текста: считать такую правку пустой
// значило бы молча её потерять, а применять с пустым текстом — стереть заголовок.
func TestApplyChatOps_TitleStyleWithoutText(t *testing.T) {
	out, err := ApplyChatEdit(sampleForm(), ChatEdit{Title: ChatTitle{BG: "#E8F0FE", Bold: true}})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}
	title := blockOf(t, out, "blk_title")
	if PlainText(title.Text) != "Запись в барбершоп" {
		t.Errorf("заголовок = %q — текст обязан был остаться прежним", PlainText(title.Text))
	}
	bold, _, bg := styleOf(title.Text)
	if !bold || bg != "#e8f0fe" {
		t.Errorf("оформление заголовка = %+v", title.Text)
	}
}

// Подсказка внутри поля (`placeholder`) — часть словаря правки с 2026-09-02: до этого
// модель её не видела и отказывала автору, который просил её заполнить.
//
// Три правила разом: модель видит существующую, заданная — встаёт, пустая — не трогает
// (её проверяет «правка сохраняет id и всё, чего модель не видела»), а тип, которому
// подсказку негде показать, теряет её вместе с остальными своими настройками.
func TestApplyChatOps_Placeholder(t *testing.T) {
	if got := ProjectForm(sampleForm()).Items[0].Placeholder; got != "Иван" {
		t.Errorf("модель не видит подсказку пункта: %q", got)
	}

	out, err := ApplyChatEdit(sampleForm(), ChatEdit{Update: []ChatUpdate{{
		Target: "q1",
		Item: ChatItem{PlanItem: PlanItem{
			Type: BlockShortText, Text: "Ваше имя", Placeholder: "Иван Иванов",
		}},
	}}})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}
	if got := blockOf(t, out, "blk_name").Settings.Placeholder; got != "Иван Иванов" {
		t.Errorf("подсказка = %q, ожидалась новая", got)
	}

	// Смена типа на тот, который подсказку не показывает: строка, которой негде
	// появиться, — мусор в документе, а не сохранённая работа автора.
	out, err = ApplyChatEdit(sampleForm(), ChatEdit{Update: []ChatUpdate{{
		Target: "q1",
		Item:   ChatItem{PlanItem: PlanItem{Type: BlockDate, Text: "Дата визита"}},
	}}})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}
	if got := blockOf(t, out, "blk_name").Settings.Placeholder; got != "" {
		t.Errorf("подсказка осталась у типа, который её не показывает: %q", got)
	}
}

// Заголовок формы: ассистент СОЗДАЁТ его жирным (пустой заголовок — это создание), а
// переименовывая готовый, жирность берёт из ответа модели — автор мог снять её сам.
func TestApplyChatOps_TitleBoldOnCreate(t *testing.T) {
	empty := FormSchema{SchemaVersion: SchemaVersion, Blocks: []Block{
		{ID: "ft", GroupID: "g_ft", Type: BlockFormTitle},
	}}
	out, err := ApplyChatEdit(empty, ChatEdit{Title: ChatTitle{Text: "Запись в барбершоп"}})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}
	if bold, _, _ := styleOf(blockOf(t, out, "ft").Text); !bold {
		t.Error("созданный заголовок формы не жирный")
	}

	// Готовый заголовок sampleForm набран обычным весом: переименование его таким и
	// оставляет.
	out, err = ApplyChatEdit(sampleForm(), ChatEdit{Title: ChatTitle{Text: "Другое название"}})
	if err != nil {
		t.Fatalf("ApplyChatEdit() вернул ошибку: %v", err)
	}
	if bold, _, _ := styleOf(blockOf(t, out, "blk_title").Text); bold {
		t.Error("переименование само сделало заголовок жирным — автор снимал жирность не для этого")
	}
}
