package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// Реестр — единственное место, которое растёт от новых типов вопросов, и забыть его
// нельзя молча: у нового отвечаемого типа выбор «описать модели» или «записать
// причину, по которой не описываем». Это замена фронтовому «не компилируется» у
// исчерпывающих Record<BlockType, …> (web/shared/fields/README.md).
func TestPlanKindsCoverAnswerable(t *testing.T) {
	for _, bt := range blockTypes {
		if !bt.isAnswerable() {
			continue
		}
		_, described := planKinds[bt]
		reason, excluded := planExcluded[bt]
		switch {
		case described && excluded:
			t.Errorf("тип %s и описан модели, и исключён (%s) — решение должно быть одно", bt, reason)
		case !described && !excluded:
			t.Errorf("отвечаемый тип %s не описан в planKinds и не исключён в planExcluded: "+
				"опиши его модели либо запиши причину отказа", bt)
		case excluded && strings.TrimSpace(reason) == "":
			t.Errorf("тип %s исключён без причины", bt)
		}
	}
	// Обратная сторона: описанный тип обязан быть настоящим и стоять в порядке
	// перечисления — иначе он не попадёт ни в промпт, ни в схему ответа.
	for bt := range planKinds {
		if !bt.valid() {
			t.Errorf("planKinds описывает несуществующий тип %s", bt)
		}
		found := false
		for _, t2 := range planTypeOrder {
			if t2 == bt {
				found = true
			}
		}
		if !found {
			t.Errorf("тип %s описан, но отсутствует в planTypeOrder — модель его не увидит", bt)
		}
	}
}

func TestPlanJSONSchema(t *testing.T) {
	var parsed struct {
		Properties struct {
			Items struct {
				Items struct {
					Properties struct {
						Type struct {
							Enum []string `json:"enum"`
						} `json:"type"`
					} `json:"properties"`
				} `json:"items"`
			} `json:"items"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(PlanJSONSchema(), &parsed); err != nil {
		t.Fatalf("схема ответа не разобралась: %v", err)
	}
	enum := parsed.Properties.Items.Items.Properties.Type.Enum
	want := planAllowedTypes()
	if len(enum) != len(want) {
		t.Fatalf("в перечислении схемы %d типов, в реестре %d", len(enum), len(want))
	}
	for i, bt := range want {
		if enum[i] != string(bt) {
			t.Errorf("перечисление[%d] = %q, реестр = %q", i, enum[i], bt)
		}
	}
}

func TestParsePlan(t *testing.T) {
	t.Run("разбирает план", func(t *testing.T) {
		p, err := ParsePlan(json.RawMessage(`{"title":"Анкета","items":[{"type":"email","text":"Почта","required":true,"options":[],"scaleMin":0,"scaleMax":0}]}`))
		if err != nil {
			t.Fatalf("ParsePlan() вернул ошибку: %v", err)
		}
		if p.Title != "Анкета" || len(p.Items) != 1 || p.Items[0].Type != BlockEmail || !p.Items[0].Required {
			t.Fatalf("разобрано неверно: %+v", p)
		}
	})

	t.Run("лишнее поле — отказ", func(t *testing.T) {
		_, err := ParsePlan(json.RawMessage(`{"title":"А","items":[],"comment":"я старалась"}`))
		if !errors.Is(err, ErrValidation) {
			t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
		}
	})

	t.Run("мусор после плана — отказ", func(t *testing.T) {
		if _, err := ParsePlan(json.RawMessage(`{"title":"А","items":[]} и ещё немного текста`)); err == nil {
			t.Fatal("ParsePlan() принял данные после плана")
		}
	})
}

func planItem(t BlockType, text string) PlanItem { return PlanItem{Type: t, Text: text} }

func TestValidatePlan(t *testing.T) {
	long := strings.Repeat("я", MaxTextLen+1)

	cases := []struct {
		name string
		plan FormPlan
		want string // фрагмент, который обязан быть в тексте ошибки
	}{
		{"пустой план", FormPlan{Title: "А"}, "ни одного пункта"},
		{
			"несуществующий тип",
			FormPlan{Title: "А", Items: []PlanItem{planItem("time", "Время")}},
			`тип "time" не поддерживается`,
		},
		{
			"тип есть в схеме, но модели не предложен",
			FormPlan{Title: "А", Items: []PlanItem{planItem(BlockImage, "картинка")}},
			"не поддерживается",
		},
		{
			"пустой текст вопроса",
			FormPlan{Title: "А", Items: []PlanItem{planItem(BlockEmail, "   ")}},
			"пустой текст",
		},
		{
			"выбор без вариантов",
			FormPlan{Title: "А", Items: []PlanItem{planItem(BlockSingleChoice, "Мастер")}},
			"нет вариантов ответа",
		},
		{
			"пустой вариант",
			FormPlan{Title: "А", Items: []PlanItem{{Type: BlockDropdown, Text: "Город", Options: []string{"Москва", " "}}}},
			"пустой вариант",
		},
		{
			"шкала вне диапазона",
			FormPlan{Title: "А", Items: []PlanItem{{Type: BlockScale, Text: "Оценка", ScaleMin: 1, ScaleMax: 100}}},
			"вне диапазона",
		},
		{
			"перевёрнутая шкала",
			FormPlan{Title: "А", Items: []PlanItem{{Type: BlockScale, Text: "Оценка", ScaleMin: 8, ScaleMax: 3}}},
			"не меньше конца",
		},
		{
			"слишком длинный текст",
			FormPlan{Title: "А", Items: []PlanItem{planItem(BlockShortText, long)}},
			"длиннее",
		},
		{
			"заголовок формы длиннее потолка",
			FormPlan{Title: strings.Repeat("з", MaxFormTitleLen+1), Items: []PlanItem{planItem(BlockEmail, "Почта")}},
			"заголовок формы длиннее",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePlan(tc.plan)
			if err == nil {
				t.Fatalf("ValidatePlan() принял план %s", tc.name)
			}
			if !errors.Is(err, ErrValidation) {
				t.Errorf("ошибка = %v, ожидалась ErrValidation", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("ошибка %q не содержит %q — модели по ней не починиться", err, tc.want)
			}
		})
	}

	t.Run("пунктов больше потолка", func(t *testing.T) {
		items := make([]PlanItem, MaxPlanItems+1)
		for i := range items {
			items[i] = planItem(BlockShortText, "Вопрос")
		}
		if err := ValidatePlan(FormPlan{Title: "А", Items: items}); err == nil {
			t.Fatal("ValidatePlan() принял план длиннее потолка")
		}
	})

	t.Run("инертное не ошибка", func(t *testing.T) {
		// required у пояснения и варианты у даты применить некуда — это тот же класс,
		// что бит колонки у блока, которому не с кем делить ряд: флаг инертен, а не
		// невалиден.
		plan := FormPlan{Title: "А", Items: []PlanItem{
			{Type: BlockText, Text: "Пояснение", Required: true},
			{Type: BlockDate, Text: "Дата", Options: []string{"лишнее"}},
		}}
		if err := ValidatePlan(plan); err != nil {
			t.Fatalf("ValidatePlan() отверг инертные поля: %v", err)
		}
	})
}

// Главный тест слайса: развёрнутый план — валидный документ схемы. Проверяется не
// глазами, а тем же ValidateSchema, который стоит на автосохранении.
func TestExpandPlanProducesValidSchema(t *testing.T) {
	plan := FormPlan{
		Title: "Запись в барбершоп",
		Items: []PlanItem{
			{Type: BlockText, Text: "Заполните за минуту"},
			{Type: BlockShortText, Text: "Как вас зовут?", Required: true},
			{Type: BlockPhone, Text: "Телефон", Required: true},
			{Type: BlockSingleChoice, Text: "Мастер", Options: []string{"Иван", "Пётр"}},
			{Type: BlockScale, Text: "Оценка прошлого визита", ScaleMin: 0, ScaleMax: 10},
			{Type: BlockScale, Text: "Насколько удобно записываться"},
			{Type: BlockPageBreak, Text: "второй шаг"},
			{Type: BlockDate, Text: "Дата визита", Required: true},
			{Type: BlockConsent, Text: "Согласен на обработку данных", Required: true},
		},
	}

	schema, err := ExpandPlan(plan)
	if err != nil {
		t.Fatalf("ExpandPlan() вернул ошибку: %v", err)
	}

	raw, err := json.Marshal(schema)
	if err != nil {
		t.Fatalf("схема не сериализовалась: %v", err)
	}
	parsed, err := ValidateSchema(raw)
	if err != nil {
		t.Fatalf("ValidateSchema() отверг собранный документ: %v", err)
	}

	if parsed.SchemaVersion != SchemaVersion {
		t.Errorf("schemaVersion = %d, ожидалась %d", parsed.SchemaVersion, SchemaVersion)
	}
	if parsed.Blocks[0].Type != BlockFormTitle || PlainText(parsed.Blocks[0].Text) != "Запись в барбершоп" {
		t.Fatalf("первый блок = %+v, ожидался заголовок формы", parsed.Blocks[0])
	}

	// Заголовок формы + 6 вопросов с подписью (по два блока) + пояснение + разрыв +
	// согласие (по одному).
	if got, want := len(parsed.Blocks), 1+6*2+3; got != want {
		t.Fatalf("блоков = %d, ожидалось %d", got, want)
	}

	ids := map[string]bool{}
	for _, b := range parsed.Blocks {
		if ids[b.ID] {
			t.Errorf("id блока %s повторяется", b.ID)
		}
		ids[b.ID] = true
		if !strings.HasPrefix(b.ID, "blk_") {
			t.Errorf("id блока %q без префикса blk_", b.ID)
		}
		if b.GroupID != "g_"+anchorOf(t, parsed.Blocks, b) {
			t.Errorf("groupId блока %s = %q — расходится с правилом regroup", b.Type, b.GroupID)
		}
	}

	// Вопрос — это подпись и поле в одной группе, и якорь группы — поле.
	name := findByType(parsed.Blocks, BlockShortText)
	caption := blockByID(parsed.Blocks, captionOf(parsed.Blocks, name.GroupID))
	if caption.Type != BlockTitle || PlainText(caption.Text) != "Как вас зовут?" {
		t.Fatalf("подпись вопроса = %+v", caption)
	}
	if !name.Required || len(name.Text) != 0 {
		t.Errorf("поле вопроса = %+v: обязательность на поле, текст только в подписи", name)
	}
	if name.GroupID != "g_"+name.ID {
		t.Errorf("якорь группы = %q, ожидался id поля", name.GroupID)
	}

	// Согласие несёт свой текст само — отдельной подписи у него нет.
	consent := findByType(parsed.Blocks, BlockConsent)
	if PlainText(consent.Text) != "Согласен на обработку данных" || !consent.Required {
		t.Errorf("согласие = %+v", consent)
	}
	if n := countInGroup(parsed.Blocks, consent.GroupID); n != 1 {
		t.Errorf("в группе согласия %d блоков, ожидался один", n)
	}

	// Разрыв страницы текста не несёт (иначе ValidateSchema его и не пропустил бы).
	if br := findByType(parsed.Blocks, BlockPageBreak); len(br.Text) != 0 {
		t.Errorf("разрыв страницы несёт текст %v", br.Text)
	}

	// Варианты получили свои id.
	choice := findByType(parsed.Blocks, BlockSingleChoice)
	if len(choice.Settings.Options) != 2 || !strings.HasPrefix(choice.Settings.Options[0].ID, "opt_") {
		t.Fatalf("варианты = %+v", choice.Settings.Options)
	}
	if choice.Settings.Options[1].Label != "Пётр" {
		t.Errorf("второй вариант = %q", choice.Settings.Options[1].Label)
	}

	// Шкала: заданные границы сохраняются, незаданные берут дефолт.
	scales := allByType(parsed.Blocks, BlockScale)
	if len(scales) != 2 {
		t.Fatalf("шкал = %d", len(scales))
	}
	if *scales[0].Settings.ScaleMin != 0 || *scales[0].Settings.ScaleMax != 10 {
		t.Errorf("границы заданной шкалы = %d..%d", *scales[0].Settings.ScaleMin, *scales[0].Settings.ScaleMax)
	}
	if *scales[1].Settings.ScaleMin != DefaultScaleMin || *scales[1].Settings.ScaleMax != DefaultScaleMax {
		t.Errorf("границы шкалы без настроек = %d..%d, ожидался дефолт",
			*scales[1].Settings.ScaleMin, *scales[1].Settings.ScaleMax)
	}
}

// Две формы по одной просьбе не делят blk_*: иначе ответы, воронка и логика двух
// разных форм ссылались бы на одни и те же строки.
func TestExpandPlanGeneratesFreshIDs(t *testing.T) {
	plan := FormPlan{Title: "А", Items: []PlanItem{planItem(BlockEmail, "Почта")}}

	first, err := ExpandPlan(plan)
	if err != nil {
		t.Fatalf("ExpandPlan() вернул ошибку: %v", err)
	}
	second, err := ExpandPlan(plan)
	if err != nil {
		t.Fatalf("ExpandPlan() вернул ошибку: %v", err)
	}
	for i := range first.Blocks {
		if first.Blocks[i].ID == second.Blocks[i].ID {
			t.Fatalf("блок %d делит id между двумя формами: %s", i, first.Blocks[i].ID)
		}
	}
}

func TestExpandPlanRejectsInvalid(t *testing.T) {
	_, err := ExpandPlan(FormPlan{Title: "А", Items: []PlanItem{planItem(BlockDropdown, "Город")}})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation до сборки документа", err)
	}
}

// --- помощники --------------------------------------------------------------

func findByType(blocks []Block, t BlockType) Block {
	for _, b := range blocks {
		if b.Type == t {
			return b
		}
	}
	return Block{}
}

func allByType(blocks []Block, t BlockType) []Block {
	var out []Block
	for _, b := range blocks {
		if b.Type == t {
			out = append(out, b)
		}
	}
	return out
}

func blockByID(blocks []Block, id string) Block {
	for _, b := range blocks {
		if b.ID == id {
			return b
		}
	}
	return Block{}
}

func captionOf(blocks []Block, groupID string) string {
	for _, b := range blocks {
		if b.GroupID == groupID && b.Type.isCaption() {
			return b.ID
		}
	}
	return ""
}

func countInGroup(blocks []Block, groupID string) int {
	n := 0
	for _, b := range blocks {
		if b.GroupID == groupID {
			n++
		}
	}
	return n
}

// anchorOf — id блока, по которому regroup назвал бы группу: отвечаемый блок
// группы, а у одиночек они сами.
func anchorOf(t *testing.T, blocks []Block, b Block) string {
	t.Helper()
	for _, other := range blocks {
		if other.GroupID == b.GroupID && other.Type.isAnswerable() {
			return other.ID
		}
	}
	return b.ID
}

// Подсказка внутри поля в плане: у типа, который её показывает, она доезжает до
// настроек блока; у прочих отвергается с перечислением подходящих — отказ уедет
// модели на вторую попытку, а не станет строкой, которой негде появиться.
func TestPlanPlaceholder(t *testing.T) {
	schema, err := ExpandPlan(FormPlan{Title: "Заявка", Items: []PlanItem{
		{Type: BlockPhone, Text: "Телефон", Placeholder: "+7 900 000-00-00"},
	}})
	if err != nil {
		t.Fatalf("ExpandPlan() вернул ошибку: %v", err)
	}
	var got string
	for _, b := range schema.Blocks {
		if b.Type == BlockPhone {
			got = b.Settings.Placeholder
		}
	}
	if got != "+7 900 000-00-00" {
		t.Errorf("подсказка = %q", got)
	}

	err = ValidatePlan(FormPlan{Title: "Заявка", Items: []PlanItem{
		{Type: BlockSingleChoice, Text: "Мастер", Options: []string{"Иван", "Пётр"}, Placeholder: "любой"},
	}})
	if err == nil || !strings.Contains(err.Error(), "не показывается") {
		t.Errorf("подсказка у выбора принята: %v", err)
	}

	err = ValidatePlan(FormPlan{Title: "Заявка", Items: []PlanItem{
		{Type: BlockShortText, Text: "Имя", Placeholder: strings.Repeat("я", MaxPlaceholderLen+1)},
	}})
	if err == nil || !strings.Contains(err.Error(), "подсказка длиннее") {
		t.Errorf("слишком длинная подсказка принята: %v", err)
	}
}
