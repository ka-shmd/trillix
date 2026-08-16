package domain

import (
	"encoding/json"
	"errors"
	"maps"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// Таблица кейсов условной логики. ЭТОТ ЖЕ состав случаев продублирован в
// web/shared/fields/logic.test.ts — паритет сторон держится тем, что списки одинаковы
// (общего кода между Go и TS нет по построению, ADR §10). Добавляешь случай здесь —
// добавь и там; название кейса — то же самое, чтобы расхождение было видно диффом.

// ---------- помощники сборки документа ----------

func lblk(id, group string, t BlockType) Block {
	return Block{ID: id, GroupID: group, Type: t}
}

func lchoice(id, group string, t BlockType, opts ...Option) Block {
	b := lblk(id, group, t)
	b.Settings.Options = opts
	return b
}

func leaf(blockID string, op LogicOp, value string) *Condition {
	return &Condition{BlockID: blockID, Op: op, Value: value}
}

func all(cs ...*Condition) *Condition {
	out := &Condition{}
	for _, c := range cs {
		out.All = append(out.All, *c)
	}
	return out
}

func any_(cs ...*Condition) *Condition {
	out := &Condition{}
	for _, c := range cs {
		out.Any = append(out.Any, *c)
	}
	return out
}

// answers собирает карту ответов: строковые значения как есть, срезы — массивом id.
func answers(kv map[string]any) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(kv))
	for k, v := range kv {
		raw, err := json.Marshal(v)
		if err != nil {
			panic(err)
		}
		out[k] = raw
	}
	return out
}

func visibleIDs(p Plan) []string {
	ids := slices.Collect(maps.Keys(p.Visible))
	slices.Sort(ids)
	return ids
}

func pageIDs(p Plan) [][]string {
	out := make([][]string, 0, len(p.Pages))
	for _, page := range p.Pages {
		ids := make([]string, 0, len(page))
		for _, b := range page {
			ids = append(ids, b.ID)
		}
		out = append(out, ids)
	}
	return out
}

// ---------- видимость вопроса ----------

func TestPlanForm_Visibility(t *testing.T) {
	// Документ: вопрос-источник (single_choice) и зависимый вопрос из подписи и поля.
	doc := func(rule *Condition) []Block {
		src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
		head := lblk("cap", "g2", BlockTitle)
		head.VisibleIf = rule
		return []Block{src, head, lblk("dep", "g2", BlockShortText)}
	}

	cases := []struct {
		name    string
		rule    *Condition
		answers map[string]any
		visible bool // виден ли зависимый вопрос (обе строки группы)
	}{
		{"правила нет — виден всегда", nil, map[string]any{}, true},
		{"is совпал — виден", leaf("src", OpIs, "yes"), map[string]any{"src": "yes"}, true},
		{"is не совпал — скрыт", leaf("src", OpIs, "yes"), map[string]any{"src": "no"}, false},
		{"is без ответа — скрыт", leaf("src", OpIs, "yes"), map[string]any{}, false},
		{"is_not у неотвеченного — виден", leaf("src", OpIsNot, "yes"), map[string]any{}, true},
		{"is_not совпал — скрыт", leaf("src", OpIsNot, "yes"), map[string]any{"src": "yes"}, false},
		{"answered — виден при любом ответе", leaf("src", OpAnswered, ""), map[string]any{"src": "no"}, true},
		{"answered без ответа — скрыт", leaf("src", OpAnswered, ""), map[string]any{}, false},
		{"empty без ответа — виден", leaf("src", OpEmpty, ""), map[string]any{}, true},

		// Инертность: правило не действует, вопрос показывается.
		{"ссылка на несуществующий блок — инертна", leaf("нет-такого", OpIs, "yes"), map[string]any{"src": "no"}, true},
		{"ссылка вперёд — инертна", leaf("later", OpIs, "x"), map[string]any{}, true},
		{"оператор не подходит типу источника — инертен", leaf("src", OpIncludes, "yes"), map[string]any{"src": "no"}, true},
		{"значение не выбрано — инертно", leaf("src", OpIs, ""), map[string]any{"src": "no"}, true},

		// Группы.
		{"all: обе истинны — виден", all(leaf("src", OpAnswered, ""), leaf("src", OpIs, "yes")), map[string]any{"src": "yes"}, true},
		{"all: одна ложна — скрыт", all(leaf("src", OpAnswered, ""), leaf("src", OpIs, "yes")), map[string]any{"src": "no"}, false},
		{"any: одна истинна — виден", any_(leaf("src", OpIs, "yes"), leaf("src", OpIs, "no")), map[string]any{"src": "no"}, true},
		{"any: обе ложны — скрыт", any_(leaf("src", OpIs, "yes"), leaf("src", OpIs, "maybe")), map[string]any{"src": "no"}, false},
		{"вложенность: any(all, leaf)", any_(all(leaf("src", OpAnswered, ""), leaf("src", OpIs, "no")), leaf("src", OpIs, "yes")), map[string]any{"src": "no"}, true},
		{"инертный ребёнок делает инертным всё правило", any_(leaf("src", OpIs, "yes"), leaf("нет-такого", OpIs, "x")), map[string]any{"src": "no"}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			blocks := doc(tc.rule)
			// «later» существует, но лежит ниже носителя — для кейса ссылки вперёд.
			blocks = append(blocks, lblk("later", "g3", BlockShortText))
			plan := PlanForm(blocks, answers(tc.answers))

			if got := plan.Visible["dep"]; got != tc.visible {
				t.Fatalf("видимость поля: got %v, want %v (видимы: %v)", got, tc.visible, visibleIDs(plan))
			}
			// Правило висит на голове группы и прячет ВСЮ группу, а не только поле.
			if got := plan.Visible["cap"]; got != tc.visible {
				t.Fatalf("видимость подписи: got %v, want %v", got, tc.visible)
			}
			if !plan.Visible["src"] {
				t.Fatal("источник обязан оставаться видимым")
			}
		})
	}
}

func TestPlanForm_RuleReadFromGroupHead(t *testing.T) {
	// Правило на НЕ головном блоке группы инертно: носитель — голова (как у бита ряда).
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"})
	head := lblk("cap", "g2", BlockTitle)
	field := lblk("dep", "g2", BlockShortText)
	field.VisibleIf = leaf("src", OpIs, "yes") // не сработает: не голова

	plan := PlanForm([]Block{src, head, field}, answers(map[string]any{"src": "no"}))
	if !plan.Visible["dep"] || !plan.Visible["cap"] {
		t.Fatalf("правило на не-голове обязано быть инертным, видимы: %v", visibleIDs(plan))
	}
}

func TestPlanForm_HiddenSourceCountsAsEmpty(t *testing.T) {
	// Цепочка А → Б → В: скрытый Б не отвечен, значит В тоже скрыт, даже если в
	// присланных ответах на Б что-то есть (устаревшая вкладка, переключённый источник).
	a := lchoice("a", "g1", BlockSingleChoice, Option{ID: "yes"}, Option{ID: "no"})
	bHead := lblk("b", "g2", BlockSingleChoice)
	bHead.Settings.Options = []Option{{ID: "dog"}}
	bHead.VisibleIf = leaf("a", OpIs, "yes")
	c := lblk("c", "g3", BlockShortText)
	c.VisibleIf = leaf("b", OpIs, "dog")

	plan := PlanForm([]Block{a, bHead, c}, answers(map[string]any{"a": "no", "b": "dog"}))
	if plan.Visible["b"] || plan.Visible["c"] {
		t.Fatalf("скрытый источник обязан считаться пустым, видимы: %v", visibleIDs(plan))
	}
}

// ---------- обязательность ----------

func TestPlanForm_Required(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "call"}, Option{ID: "mail"})

	cases := []struct {
		name     string
		build    func(b *Block)
		answers  map[string]any
		required bool
	}{
		{"required без условия", func(b *Block) { b.Required = true }, map[string]any{}, true},
		{"requiredIf сработал", func(b *Block) { b.RequiredIf = leaf("src", OpIs, "call") }, map[string]any{"src": "call"}, true},
		{"requiredIf не сработал", func(b *Block) { b.RequiredIf = leaf("src", OpIs, "call") }, map[string]any{"src": "mail"}, false},
		{"requiredIf инертен — не обязателен", func(b *Block) { b.RequiredIf = leaf("нет-такого", OpIs, "x") }, map[string]any{}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dep := lblk("dep", "g2", BlockPhone)
			tc.build(&dep)
			plan := PlanForm([]Block{src, dep}, answers(tc.answers))
			if got := plan.Required["dep"]; got != tc.required {
				t.Fatalf("обязательность: got %v, want %v", got, tc.required)
			}
		})
	}

	t.Run("скрытый вопрос не обязателен никогда", func(t *testing.T) {
		dep := lblk("dep", "g2", BlockPhone)
		dep.Required = true
		dep.VisibleIf = leaf("src", OpIs, "call")
		plan := PlanForm([]Block{src, dep}, answers(map[string]any{"src": "mail"}))
		if plan.Required["dep"] {
			t.Fatal("скрытый вопрос попал в обязательные")
		}
	})
}

// ---------- варианты ----------

func TestPlanForm_Options(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "dog"}, Option{ID: "cat"})
	list := lchoice("list", "g2", BlockMultiChoice,
		Option{ID: "leash", VisibleIf: leaf("src", OpIs, "dog")},
		Option{ID: "tray", VisibleIf: leaf("src", OpIs, "cat")},
		Option{ID: "food"},
	)
	blocks := []Block{src, list}

	t.Run("видны только варианты со сработавшим условием", func(t *testing.T) {
		plan := PlanForm(blocks, answers(map[string]any{"src": "dog"}))
		if !plan.OptionVisible("list", "leash") || plan.OptionVisible("list", "tray") || !plan.OptionVisible("list", "food") {
			t.Fatalf("видимость вариантов: %v", plan.Options["list"])
		}
	})

	t.Run("у блока без правил карты вариантов нет — видны все", func(t *testing.T) {
		plan := PlanForm([]Block{src}, answers(map[string]any{}))
		if _, ok := plan.Options["src"]; ok {
			t.Fatal("карта вариантов заведена там, где правил нет")
		}
		if !plan.OptionVisible("src", "dog") {
			t.Fatal("без карты обязаны быть видны все варианты")
		}
	})

	t.Run("выбранный скрытый вариант не считается выбором", func(t *testing.T) {
		dep := lblk("dep", "g3", BlockShortText)
		dep.VisibleIf = leaf("list", OpIncludes, "tray")
		plan := PlanForm(append(slices.Clone(blocks), dep), answers(map[string]any{
			"src":  "dog",
			"list": []string{"tray", "food"},
		}))
		if plan.Visible["dep"] {
			t.Fatal("условие сработало от скрытого варианта")
		}
	})

	t.Run("includes по видимому варианту работает", func(t *testing.T) {
		dep := lblk("dep", "g3", BlockShortText)
		dep.VisibleIf = leaf("list", OpIncludes, "leash")
		plan := PlanForm(append(slices.Clone(blocks), dep), answers(map[string]any{
			"src":  "dog",
			"list": []string{"leash"},
		}))
		if !plan.Visible["dep"] {
			t.Fatal("includes по видимому варианту не сработал")
		}
	})
}

// ---------- числа ----------

func TestPlanForm_Numbers(t *testing.T) {
	min, max := 0, 10
	scale := lblk("nps", "g1", BlockScale)
	scale.Settings.ScaleMin, scale.Settings.ScaleMax = &min, &max
	num := lblk("age", "g2", BlockNumber)

	cases := []struct {
		name    string
		rule    *Condition
		answers map[string]any
		visible bool
	}{
		{"gt по шкале", leaf("nps", OpGt, "8"), map[string]any{"nps": "9"}, true},
		{"gt по шкале не сработал", leaf("nps", OpGt, "8"), map[string]any{"nps": "8"}, false},
		{"lt по шкале", leaf("nps", OpLt, "5"), map[string]any{"nps": "3"}, true},
		{"is у number сравнивает числом, а не строкой", leaf("age", OpIs, "5.0"), map[string]any{"age": "5"}, true},
		{"gt у нечислового ответа — ложь, но правило действует", leaf("age", OpGt, "5"), map[string]any{"age": "abc"}, false},
		{"gt у текстового источника — инертен", leaf("txt", OpGt, "5"), map[string]any{}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dep := lblk("dep", "g4", BlockShortText)
			dep.VisibleIf = tc.rule
			blocks := []Block{scale, num, lblk("txt", "g3", BlockShortText), dep}
			plan := PlanForm(blocks, answers(tc.answers))
			if got := plan.Visible["dep"]; got != tc.visible {
				t.Fatalf("видимость: got %v, want %v", got, tc.visible)
			}
		})
	}
}

// ---------- страницы и переходы ----------

// pagedDoc — три страницы: [src] | [q2] | [q3]; разрывы br1 и br2.
func pagedDoc(jump []JumpRule) []Block {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"}, Option{ID: "no"})
	br1 := lblk("br1", "gb1", BlockPageBreak)
	br1.JumpIf = jump
	return []Block{
		src,
		br1,
		lblk("q2", "g2", BlockShortText),
		lblk("br2", "gb2", BlockPageBreak),
		lblk("q3", "g3", BlockShortText),
	}
}

func TestPlanForm_Pages(t *testing.T) {
	t.Run("без переходов страницы идут подряд", func(t *testing.T) {
		plan := PlanForm(pagedDoc(nil), answers(map[string]any{}))
		want := [][]string{{"src"}, {"q2"}, {"q3"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("переход вперёд пропускает страницу", func(t *testing.T) {
		jump := []JumpRule{{When: leaf("src", OpIs, "no"), To: "br2"}}
		plan := PlanForm(pagedDoc(jump), answers(map[string]any{"src": "no"}))
		want := [][]string{{"src"}, {"q3"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
		if plan.Visible["q2"] {
			t.Fatal("вопрос пропущенной страницы остался видимым")
		}
	})

	t.Run("условие перехода не сработало — идём подряд", func(t *testing.T) {
		jump := []JumpRule{{When: leaf("src", OpIs, "no"), To: "br2"}}
		plan := PlanForm(pagedDoc(jump), answers(map[string]any{"src": "yes"}))
		if got := len(plan.Pages); got != 3 {
			t.Fatalf("страниц: got %d, want 3", got)
		}
	})

	t.Run("end обрывает форму на текущей странице", func(t *testing.T) {
		jump := []JumpRule{{When: leaf("src", OpIs, "no"), End: true}}
		plan := PlanForm(pagedDoc(jump), answers(map[string]any{"src": "no"}))
		want := [][]string{{"src"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("переход назад инертен", func(t *testing.T) {
		// Правило на ВТОРОМ разрыве ведёт на первый — назад. Обход обязан пойти подряд.
		blocks := pagedDoc(nil)
		blocks[3].JumpIf = []JumpRule{{When: leaf("src", OpIs, "no"), To: "br1"}}
		plan := PlanForm(blocks, answers(map[string]any{"src": "no"}))
		want := [][]string{{"src"}, {"q2"}, {"q3"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("переход в никуда инертен", func(t *testing.T) {
		jump := []JumpRule{{When: leaf("src", OpIs, "no"), To: "нет-такого"}}
		plan := PlanForm(pagedDoc(jump), answers(map[string]any{"src": "no"}))
		if got := len(plan.Pages); got != 3 {
			t.Fatalf("страниц: got %d, want 3", got)
		}
	})

	t.Run("выигрывает первое сработавшее правило", func(t *testing.T) {
		jump := []JumpRule{
			{When: leaf("src", OpIs, "no"), To: "br2"},
			{When: leaf("src", OpAnswered, ""), End: true},
		}
		plan := PlanForm(pagedDoc(jump), answers(map[string]any{"src": "no"}))
		want := [][]string{{"src"}, {"q3"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("страница, где скрыто всё, не показывается", func(t *testing.T) {
		blocks := pagedDoc(nil)
		blocks[2].VisibleIf = leaf("src", OpIs, "yes")
		plan := PlanForm(blocks, answers(map[string]any{"src": "no"}))
		want := [][]string{{"src"}, {"q3"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("страница на выходе всегда хотя бы одна", func(t *testing.T) {
		plan := PlanForm(nil, nil)
		if got := len(plan.Pages); got != 1 {
			t.Fatalf("страниц: got %d, want 1", got)
		}
	})

	t.Run("условие смотрит на вопрос той же страницы", func(t *testing.T) {
		blocks := pagedDoc(nil)
		dep := lblk("dep", "g4", BlockShortText)
		dep.VisibleIf = leaf("src", OpIs, "yes")
		blocks = append([]Block{blocks[0], dep}, blocks[1:]...)
		plan := PlanForm(blocks, answers(map[string]any{"src": "yes"}))
		if !plan.Visible["dep"] {
			t.Fatal("условие внутри страницы не сработало")
		}
	})
}

// ---------- нормализация ответов ----------

func TestStripHiddenAnswers(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"}, Option{ID: "no"})
	dep := lblk("dep", "g2", BlockShortText)
	dep.VisibleIf = leaf("src", OpIs, "yes")
	list := lchoice("list", "g3", BlockMultiChoice,
		Option{ID: "a", VisibleIf: leaf("src", OpIs, "yes")},
		Option{ID: "b"},
	)
	single := lchoice("single", "g4", BlockDropdown,
		Option{ID: "x", VisibleIf: leaf("src", OpIs, "yes")},
		Option{ID: "y"},
	)
	blocks := []Block{src, dep, list, single}

	t.Run("ответ на скрытый вопрос отброшен", func(t *testing.T) {
		out := StripHiddenAnswers(blocks, answers(map[string]any{"src": "no", "dep": "Барсик"}))
		if _, ok := out["dep"]; ok {
			t.Fatalf("ответ на скрытый вопрос сохранён: %v", out)
		}
		if string(out["src"]) != `"no"` {
			t.Fatalf("видимый ответ пропал: %v", out)
		}
	})

	t.Run("скрытый вариант вычищен из множественного выбора", func(t *testing.T) {
		out := StripHiddenAnswers(blocks, answers(map[string]any{"src": "no", "list": []string{"a", "b"}}))
		if string(out["list"]) != `["b"]` {
			t.Fatalf("варианты: got %s, want [\"b\"]", out["list"])
		}
	})

	t.Run("скрытый вариант одиночного выбора уносит весь ответ", func(t *testing.T) {
		out := StripHiddenAnswers(blocks, answers(map[string]any{"src": "no", "single": "x"}))
		if _, ok := out["single"]; ok {
			t.Fatalf("ответ скрытым вариантом сохранён: %v", out)
		}
	})

	t.Run("ответ на несуществующий блок не трогается", func(t *testing.T) {
		out := StripHiddenAnswers(blocks, answers(map[string]any{"призрак": "x"}))
		if _, ok := out["призрак"]; !ok {
			t.Fatal("нормализация проглотила нарушение контракта — его должен ловить ValidateAnswers")
		}
	})

	t.Run("вход не мутируется", func(t *testing.T) {
		in := answers(map[string]any{"src": "no", "dep": "Барсик"})
		StripHiddenAnswers(blocks, in)
		if _, ok := in["dep"]; !ok {
			t.Fatal("StripHiddenAnswers изменила входную карту")
		}
	})

	// Инвариант §4.4 спеки: пересчёт по сохранённому ответу воспроизводит то, что видел
	// респондент. На нём стоят знаменатель сводки и выгрузка.
	t.Run("инвариант: план по очищенным ответам совпадает с исходным", func(t *testing.T) {
		for _, a := range []map[string]any{
			{"src": "yes", "dep": "Барсик", "list": []string{"a", "b"}, "single": "x"},
			{"src": "no", "dep": "Барсик", "list": []string{"a", "b"}, "single": "x"},
			{"src": "no"},
			{},
		} {
			raw := answers(a)
			before := PlanForm(blocks, raw)
			after := PlanForm(blocks, StripHiddenAnswers(blocks, raw))
			if !reflect.DeepEqual(before.Visible, after.Visible) ||
				!reflect.DeepEqual(before.Required, after.Required) ||
				!reflect.DeepEqual(before.Options, after.Options) ||
				!reflect.DeepEqual(pageIDs(before), pageIDs(after)) {
				t.Fatalf("инвариант нарушен на ответах %v", a)
			}
		}
	})
}

// ---------- приём ответа (NormalizeAnswers) ----------

func TestNormalizeAnswers(t *testing.T) {
	// Форма: «Есть питомец?» → при «Да» показывается обязательный «Какой?».
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"}, Option{ID: "no"})
	dep := lblk("dep", "g2", BlockShortText)
	dep.Required = true
	dep.VisibleIf = leaf("src", OpIs, "yes")
	schema := FormSchema{SchemaVersion: SchemaVersion, Blocks: []Block{src, dep}}

	t.Run("скрытый обязательный вопрос не мешает отправке", func(t *testing.T) {
		clean, err := NormalizeAnswers(schema, answers(map[string]any{"src": "no"}))
		if err != nil {
			t.Fatalf("ответ обязан приниматься: %v", err)
		}
		if len(clean) != 1 {
			t.Fatalf("в базу уходит лишнее: %v", clean)
		}
	})

	t.Run("ответ на скрытый вопрос отброшен, а не назван несуществующим", func(t *testing.T) {
		clean, err := NormalizeAnswers(schema, answers(map[string]any{"src": "no", "dep": "Барсик"}))
		if err != nil {
			t.Fatalf("ответ обязан приниматься: %v", err)
		}
		if _, ok := clean["dep"]; ok {
			t.Fatalf("ответ на скрытый вопрос сохранён: %v", clean)
		}
	})

	t.Run("видимый обязательный по-прежнему обязателен", func(t *testing.T) {
		_, err := NormalizeAnswers(schema, answers(map[string]any{"src": "yes"}))
		var errs AnswerErrors
		if !errors.As(err, &errs) || errs["dep"] != msgRequired {
			t.Fatalf("ожидалась обязательность dep, получено: %v", err)
		}
	})

	t.Run("ответ на несуществующий вопрос остаётся ошибкой", func(t *testing.T) {
		_, err := NormalizeAnswers(schema, answers(map[string]any{"src": "no", "призрак": "x"}))
		var errs AnswerErrors
		if !errors.As(err, &errs) || errs["призрак"] == "" {
			t.Fatalf("ожидалась ошибка по призраку, получено: %v", err)
		}
	})

	t.Run("requiredIf: обязателен только при сработавшем условии", func(t *testing.T) {
		phone := lblk("phone", "g2", BlockPhone)
		phone.RequiredIf = leaf("src", OpIs, "yes")
		s := FormSchema{SchemaVersion: SchemaVersion, Blocks: []Block{src, phone}}

		if _, err := NormalizeAnswers(s, answers(map[string]any{"src": "no"})); err != nil {
			t.Fatalf("условие не сработало — ответ обязан приниматься: %v", err)
		}
		_, err := NormalizeAnswers(s, answers(map[string]any{"src": "yes"}))
		var errs AnswerErrors
		if !errors.As(err, &errs) || errs["phone"] != msgRequired {
			t.Fatalf("ожидалась обязательность phone, получено: %v", err)
		}
	})

	t.Run("форма без правил ведёт себя как до фазы", func(t *testing.T) {
		plain := lblk("q", "g1", BlockShortText)
		plain.Required = true
		s := FormSchema{SchemaVersion: SchemaVersion, Blocks: []Block{plain}}

		if _, err := NormalizeAnswers(s, answers(map[string]any{})); err == nil {
			t.Fatal("обязательное поле без ответа обязано давать ошибку")
		}
		clean, err := NormalizeAnswers(s, answers(map[string]any{"q": "Иван"}))
		if err != nil || string(clean["q"]) != `"Иван"` {
			t.Fatalf("ответ обязан пройти как есть: %v %v", clean, err)
		}
	})
}

// ---------- форма правил в схеме ----------

func TestValidateSchema_LogicValid(t *testing.T) {
	cases := map[string]string{
		"visibleIf листом": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да"}]}},
			{"id":"b","groupId":"g2","type":"short_text","visibleIf":{"blockId":"a","op":"is","value":"o1"},"settings":{}}
		]}`,
		"visibleIf вложенными группами": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"b","groupId":"g2","type":"short_text","settings":{},"visibleIf":{"any":[
				{"all":[{"blockId":"a","op":"answered"},{"blockId":"a","op":"is","value":"x"}]},
				{"blockId":"a","op":"is","value":"y"}
			]}}
		]}`,
		"значение не выбрано — законный черновик": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"b","groupId":"g2","type":"short_text","settings":{},"visibleIf":{"blockId":"a","op":"is","value":""}}
		]}`,
		"ссылка вперёд — инертна, но валидна": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g2","type":"short_text","settings":{},"visibleIf":{"blockId":"a","op":"answered"}},
			{"id":"a","groupId":"g1","type":"short_text","settings":{}}
		]}`,
		"ссылка на удалённый блок — инертна, но валидна": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g2","type":"short_text","settings":{},"visibleIf":{"blockId":"призрак","op":"answered"}}
		]}`,
		"requiredIf у отвечаемого": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"b","groupId":"g2","type":"phone","settings":{},"requiredIf":{"blockId":"a","op":"answered"}}
		]}`,
		"visibleIf у варианта": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"b","groupId":"g2","type":"multi_choice","settings":{"options":[
				{"id":"o1","label":"Поводок","visibleIf":{"blockId":"a","op":"is","value":"dog"}}
			]}}
		]}`,
		"переходы у разрыва": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"br","groupId":"g2","type":"page_break","jumpIf":[
				{"when":{"blockId":"a","op":"empty"},"to":"br2"},
				{"when":{"blockId":"a","op":"answered"},"end":true}
			]},
			{"id":"c","groupId":"g3","type":"short_text","settings":{}}
		]}`,
		"глубина ровно в лимит": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"b","groupId":"g2","type":"short_text","settings":{},"visibleIf":
				{"all":[{"any":[{"all":[{"blockId":"a","op":"answered"}]}]}]}}
		]}`,
		"блок logic: условие и все виды действий": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да"}]}},
			{"id":"L","groupId":"g2","type":"logic","logic":{
				"when":{"blockId":"a","op":"is","value":"o1"},
				"then":[
					{"kind":"show","target":"b"},
					{"kind":"hide","target":"c"},
					{"kind":"require","target":"b"},
					{"kind":"show_options","target":"c","options":["o2"]},
					{"kind":"hide_options","target":"c","options":["o2","o3"]},
					{"kind":"jump","to":"br"},
					{"kind":"jump","end":true},
					{"kind":"block_submit"}
				]}},
			{"id":"b","groupId":"g3","type":"short_text","settings":{}},
			{"id":"c","groupId":"g4","type":"multi_choice","settings":{}}
		]}`,
		"блок logic без условия и без действий — законный черновик": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{}}
		]}`,
		"блок logic вовсе без поля logic": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic"}
		]}`,
		"действие на удалённую цель — инертно, но валидно": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"show","target":"призрак"}]}}
		]}`,
		"цель СТОИТ ВЫШЕ блока — инертно, но валидно": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"g2","type":"logic","logic":{"then":[{"kind":"show","target":"b"}]}}
		]}`,
	}

	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateSchema(json.RawMessage(raw)); err != nil {
				t.Fatalf("документ обязан быть валидным, получено: %v", err)
			}
		})
	}
}

func TestValidateSchema_LogicInvalid(t *testing.T) {
	deep := `{"all":[{"all":[{"all":[{"all":[{"blockId":"a","op":"answered"}]}]}]}]}`
	long := strings.Repeat("я", MaxLogicValueLen+1)
	manyActions := strings.TrimSuffix(
		strings.Repeat(`{"kind":"show","target":"b"},`, MaxLogicActions+1), ",")

	cases := map[string]string{
		"пустое условие": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{}}
		]}`,
		"пустая группа": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{"all":[]}}
		]}`,
		"all и any одновременно": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{
				"all":[{"blockId":"a","op":"answered"}],"any":[{"blockId":"a","op":"empty"}]}}
		]}`,
		"группа с полями листа": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{
				"all":[{"blockId":"a","op":"answered"}],"blockId":"a","op":"is","value":"x"}}
		]}`,
		"неизвестный оператор": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{"blockId":"a","op":"matches","value":"x"}}
		]}`,
		"оператора нет вовсе": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{"blockId":"a"}}
		]}`,
		"пустой blockId": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{"blockId":"","op":"answered","value":"x"}}
		]}`,
		"значение у answered": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{"blockId":"a","op":"answered","value":"x"}}
		]}`,
		"значение длиннее лимита": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{"blockId":"a","op":"is","value":"` + long + `"}}
		]}`,
		"вложенность глубже лимита": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":` + deep + `}
		]}`,
		"лишний ключ в условии": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{"blockId":"a","op":"is","value":"x","not":true}}
		]}`,
		"requiredIf у неотвечаемого": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"heading","text":[{"t":"Раздел"}],"requiredIf":{"blockId":"a","op":"answered"}}
		]}`,
		"required и requiredIf вместе": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"required":true,"requiredIf":{"blockId":"a","op":"answered"}}
		]}`,
		"visibleIf у разрыва страницы": `{"schemaVersion":1,"blocks":[
			{"id":"br","groupId":"g1","type":"page_break","visibleIf":{"blockId":"a","op":"answered"}}
		]}`,
		"переходы не у разрыва": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"jumpIf":[{"when":{"blockId":"a","op":"answered"},"end":true}]}
		]}`,
		"переход без условия": `{"schemaVersion":1,"blocks":[
			{"id":"br","groupId":"g1","type":"page_break","jumpIf":[{"end":true}]}
		]}`,
		"переход без цели": `{"schemaVersion":1,"blocks":[
			{"id":"br","groupId":"g1","type":"page_break","jumpIf":[{"when":{"blockId":"a","op":"answered"}}]}
		]}`,
		"переход с двумя целями": `{"schemaVersion":1,"blocks":[
			{"id":"br","groupId":"g1","type":"page_break","jumpIf":[{"when":{"blockId":"a","op":"answered"},"to":"br2","end":true}]}
		]}`,
		"logic у чужого типа": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"logic":{"then":[{"kind":"show","target":"c"}]}}
		]}`,
		"неизвестное действие": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"calculate","target":"b"}]}}
		]}`,
		"действие без цели": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"show"}]}}
		]}`,
		"пустая цель": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"show","target":""}]}}
		]}`,
		"варианты без списка": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"hide_options","target":"c"}]}}
		]}`,
		"пустой список вариантов": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"hide_options","target":"c","options":[]}]}}
		]}`,
		"варианты у действия, которое их не адресует": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"show","target":"c","options":["o1"]}]}}
		]}`,
		"переход в блоке logic без цели": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"jump"}]}}
		]}`,
		"переход в блоке logic с двумя целями": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"jump","to":"br","end":true}]}}
		]}`,
		"цель перехода у действия, которое не переход": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"block_submit","to":"br"}]}}
		]}`,
		"лишний ключ в блоке logic": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"otherwise":[]}}
		]}`,
		"действий больше лимита": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[` + manyActions + `]}}
		]}`,
	}

	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateSchema(json.RawMessage(raw))
			if err == nil {
				t.Fatal("документ обязан быть отвергнут")
			}
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("ошибка обязана быть ErrValidation, получено: %v", err)
			}
		})
	}
}

func TestValidateSchema_LogicNodeLimit(t *testing.T) {
	// MaxLogicNodes считает узлы ВСЕГО правила, а не детей одной группы: без второго
	// лимита глубина перестала бы ограничивать документ (сорок групп по одному листу).
	leaves := make([]string, 0, MaxLogicNodes)
	for range MaxLogicNodes {
		leaves = append(leaves, `{"blockId":"a","op":"answered"}`)
	}
	doc := func(n int) string {
		return `{"schemaVersion":1,"blocks":[{"id":"b","groupId":"g1","type":"short_text","settings":{},"visibleIf":{"all":[` +
			strings.Join(leaves[:n], ",") + `]}}]}`
	}

	// Группа плюс n листьев: ровно в лимит — валидно, на один больше — нет.
	if _, err := ValidateSchema(json.RawMessage(doc(MaxLogicNodes - 1))); err != nil {
		t.Fatalf("правило ровно в лимит обязано проходить: %v", err)
	}
	if _, err := ValidateSchema(json.RawMessage(doc(MaxLogicNodes))); err == nil {
		t.Fatal("правило сверх лимита обязано быть отвергнуто")
	}
}

func TestValidateSchema_LogicCanonical(t *testing.T) {
	// Правила переживают канонизацию: то, что сохранил автор, читатель получает
	// байт в байт (иначе автосейв гонял бы бесконечный дифф).
	raw := `{"schemaVersion":1,"blocks":[
		{"id":"a","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да","visibleIf":{"blockId":"z","op":"answered"}}]}},
		{"id":"b","groupId":"g2","type":"short_text","settings":{},"visibleIf":{"all":[{"blockId":"a","op":"is","value":"o1"}]},"requiredIf":{"blockId":"a","op":"answered"}},
		{"id":"br","groupId":"g3","type":"page_break","jumpIf":[{"when":{"blockId":"a","op":"empty"},"end":true}]},
		{"id":"c","groupId":"g4","type":"short_text","settings":{}}
	]}`
	canon, err := CanonicalV4(json.RawMessage(raw))
	if err != nil {
		t.Fatalf("канонизация: %v", err)
	}
	again, err := CanonicalV4(canon)
	if err != nil {
		t.Fatalf("повторная канонизация: %v", err)
	}
	if string(canon) != string(again) {
		t.Fatalf("канон не идемпотентен:\n%s\n%s", canon, again)
	}
	for _, want := range []string{`"visibleIf"`, `"requiredIf"`, `"jumpIf"`, `"end":true`} {
		if !strings.Contains(string(canon), want) {
			t.Fatalf("канон потерял %s: %s", want, canon)
		}
	}
}

// ---------- сводка: знаменатель «показан» ----------

func TestSummary_DenominatorCountsShownOnly(t *testing.T) {
	// Форма: «Есть питомец?» и «Какой?» за условием «Да».
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"}, Option{ID: "no"})
	dep := lblk("dep", "g2", BlockShortText)
	dep.VisibleIf = leaf("src", OpIs, "yes")
	schema := FormSchema{SchemaVersion: SchemaVersion, Blocks: []Block{src, dep}}
	versions := []VersionedSchema{{Version: 1, Schema: schema}}

	b := NewSummaryBuilder(versions)
	// Трое ответили «Нет» — им «Какой?» не показывали; один «Да» и заполнил.
	for range 3 {
		b.Add(1, answers(map[string]any{"src": "no"}))
	}
	b.Add(1, answers(map[string]any{"src": "yes", "dep": "Барсик"}))

	res := b.Result()
	var got BlockSummary
	for _, bs := range res.Blocks {
		if bs.BlockID == "dep" {
			got = bs
		}
	}
	if got.Asked != 1 || got.Answered != 1 {
		t.Fatalf("вопрос за условием: asked=%d answered=%d, ожидалось 1 и 1 (в знаменатель идут только те, кому показали)", got.Asked, got.Answered)
	}
	// У источника знаменатель — все четверо: его видели все.
	for _, bs := range res.Blocks {
		if bs.BlockID == "src" && bs.Asked != 4 {
			t.Fatalf("источник: asked=%d, ожидалось 4", bs.Asked)
		}
	}
	if res.Total != 4 {
		t.Fatalf("всего ответов %d, ожидалось 4", res.Total)
	}
}

func TestSummary_NoRules_SameAsBefore(t *testing.T) {
	// Форма без правил: знаменатель — все ответы, как до фазы. Регресс-сторож на то,
	// что пересчёт видимости ничего не отнял у обычных форм.
	q1 := lblk("q1", "g1", BlockShortText)
	q2 := lblk("q2", "g2", BlockShortText)
	versions := []VersionedSchema{{Version: 1, Schema: FormSchema{SchemaVersion: SchemaVersion, Blocks: []Block{q1, q2}}}}

	b := NewSummaryBuilder(versions)
	b.Add(1, answers(map[string]any{"q1": "а"}))
	b.Add(1, answers(map[string]any{"q1": "б", "q2": "в"}))

	for _, bs := range b.Result().Blocks {
		if bs.Asked != 2 {
			t.Fatalf("%s: asked=%d, ожидалось 2", bs.BlockID, bs.Asked)
		}
	}
}

func TestSummary_HiddenByJump_NotAsked(t *testing.T) {
	// Пропущенная переходом страница в знаменатель не идёт — она не показывалась.
	blocks := pagedDoc([]JumpRule{{When: leaf("src", OpIs, "no"), To: "br2"}})
	versions := []VersionedSchema{{Version: 1, Schema: FormSchema{SchemaVersion: SchemaVersion, Blocks: blocks}}}

	b := NewSummaryBuilder(versions)
	b.Add(1, answers(map[string]any{"src": "no"}))             // перескочил q2
	b.Add(1, answers(map[string]any{"src": "yes", "q2": "x"})) // прошёл всё

	for _, bs := range b.Result().Blocks {
		switch bs.BlockID {
		case "q2":
			if bs.Asked != 1 {
				t.Fatalf("q2: asked=%d, ожидалось 1", bs.Asked)
			}
		case "q3":
			if bs.Asked != 2 {
				t.Fatalf("q3: asked=%d, ожидалось 2 (страница за переходом посещается всеми)", bs.Asked)
			}
		}
	}
}
