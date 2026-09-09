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

// showRule/requireRule/optionRule — блок logic с одним действием, СТОЯЩИЙ ПЕРЕД целью:
// источники условия оказываются выше него, цель — ниже. Помощники, а не литералы по
// месту: почти каждый случай ниже про семантику условия, а не про форму блока.

func lblk(id, group string, t BlockType) Block {
	return Block{ID: id, GroupID: group, Type: t}
}

func lchoice(id, group string, t BlockType, opts ...Option) Block {
	b := lblk(id, group, t)
	b.Settings.Options = opts
	return b
}

func showRule(target string, when *Condition) Block {
	return llogic("L-show-"+target, "gL-show-"+target, when, act(ActShow, target))
}

func requireRule(target string, when *Condition) Block {
	return llogic("L-req-"+target, "gL-req-"+target, when, act(ActRequire, target))
}

// optionRule — «показать варианты»: перечисленные варианты видны только по условию,
// остальные умолчания не меняют.
func optionRule(target string, when *Condition, options ...string) Block {
	b := lblk("L-opt-"+target+"-"+options[0], "gL-opt-"+target+"-"+options[0], BlockLogic)
	b.Logic = &Logic{When: when, Then: []LogicAction{{Kind: ActShow, Targets: options}}}
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
	// Документ: вопрос-источник (single_choice), блок правила и зависимый вопрос из
	// подписи и поля. Правило ПОКАЗЫВАЕТ вопрос: без условия он виден (правило инертно),
	// с несработавшим — скрыт.
	doc := func(rule *Condition) []Block {
		src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
		return []Block{
			src,
			showRule("cap", rule),
			lblk("cap", "g2", BlockTitle),
			lblk("dep", "g2", BlockShortText),
		}
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

// Два уровня видимости: голова прячет вопрос ЦЕЛИКОМ, любая другая строка группы —
// ТОЛЬКО СЕБЯ (2026-08-16).
func TestPlanForm_GroupHeadHidesWholeQuestion(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"})
	blocks := []Block{
		src,
		showRule("cap", leaf("src", OpIs, "yes")),
		lblk("cap", "g2", BlockTitle),
		lblk("dep", "g2", BlockShortText),
	}
	plan := PlanForm(blocks, answers(map[string]any{"src": "no"}))
	if plan.Visible["cap"] || plan.Visible["dep"] {
		t.Fatalf("голова прячет вопрос целиком, видимы: %v", visibleIDs(plan))
	}
}

func TestPlanForm_InnerBlockHidesItselfOnly(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"})
	blocks := []Block{
		src,
		showRule("dep", leaf("src", OpIs, "yes")),
		lblk("cap", "g2", BlockTitle),
		lblk("dep", "g2", BlockShortText),
	}
	plan := PlanForm(blocks, answers(map[string]any{"src": "no"}))
	if plan.Visible["dep"] {
		t.Fatal("строка со своим правилом обязана скрыться")
	}
	if !plan.Visible["cap"] {
		t.Fatalf("подпись того же вопроса обязана остаться, видимы: %v", visibleIDs(plan))
	}
}

// Уровни перемножаются: спрятанный вопрос не показывает своих строк, что бы про них ни
// говорили их собственные правила.
func TestPlanForm_HiddenQuestionHidesInnerRows(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"}, Option{ID: "no"})
	blocks := []Block{
		src,
		showRule("cap", leaf("src", OpIs, "yes")),
		llogic("L2", "gL2", leaf("src", OpAnswered, ""), act(ActShow, "dep")),
		lblk("cap", "g2", BlockTitle),
		lblk("dep", "g2", BlockShortText),
	}
	// Собственное правило строки сработало, правило вопроса — нет.
	plan := PlanForm(blocks, answers(map[string]any{"src": "no"}))
	if plan.Visible["dep"] {
		t.Fatal("спрятанный вопрос не показывает своих строк")
	}
}

func TestPlanForm_HiddenSourceCountsAsEmpty(t *testing.T) {
	// Цепочка А → Б → В: скрытый Б не отвечен, значит В тоже скрыт, даже если в
	// присланных ответах на Б что-то есть (устаревшая вкладка, переключённый источник).
	a := lchoice("a", "g1", BlockSingleChoice, Option{ID: "yes"}, Option{ID: "no"})
	bHead := lblk("b", "g2", BlockSingleChoice)
	bHead.Settings.Options = []Option{{ID: "dog"}}
	c := lblk("c", "g3", BlockShortText)

	blocks := []Block{
		a,
		showRule("b", leaf("a", OpIs, "yes")),
		bHead,
		showRule("c", leaf("b", OpIs, "dog")),
		c,
	}
	plan := PlanForm(blocks, answers(map[string]any{"a": "no", "b": "dog"}))
	if plan.Visible["b"] || plan.Visible["c"] {
		t.Fatalf("скрытый источник обязан считаться пустым, видимы: %v", visibleIDs(plan))
	}
}

// ---------- обязательность ----------

func TestPlanForm_Required(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "call"}, Option{ID: "mail"})

	cases := []struct {
		name     string
		flag     bool
		rule     *Condition
		answers  map[string]any
		required bool
	}{
		{"required без условия", true, nil, map[string]any{}, true},
		{"условие обязательности сработало", false, leaf("src", OpIs, "call"), map[string]any{"src": "call"}, true},
		{"условие обязательности не сработало", false, leaf("src", OpIs, "call"), map[string]any{"src": "mail"}, false},
		{"условие обязательности инертно — не обязателен", false, leaf("нет-такого", OpIs, "x"), map[string]any{}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dep := lblk("dep", "g2", BlockPhone)
			dep.Required = tc.flag
			blocks := []Block{src}
			if tc.rule != nil {
				blocks = append(blocks, requireRule("dep", tc.rule))
			}
			blocks = append(blocks, dep)
			plan := PlanForm(blocks, answers(tc.answers))
			if got := plan.Required["dep"]; got != tc.required {
				t.Fatalf("обязательность: got %v, want %v", got, tc.required)
			}
		})
	}

	t.Run("скрытый вопрос не обязателен никогда", func(t *testing.T) {
		dep := lblk("dep", "g2", BlockPhone)
		dep.Required = true
		blocks := []Block{src, showRule("dep", leaf("src", OpIs, "call")), dep}
		plan := PlanForm(blocks, answers(map[string]any{"src": "mail"}))
		if plan.Required["dep"] {
			t.Fatal("скрытый вопрос попал в обязательные")
		}
	})
}

// ---------- варианты ----------

func TestPlanForm_Options(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "dog"}, Option{ID: "cat"})
	list := lchoice("list", "g2", BlockMultiChoice,
		Option{ID: "leash"}, Option{ID: "tray"}, Option{ID: "food"},
	)
	blocks := []Block{
		src,
		optionRule("list", leaf("src", OpIs, "dog"), "leash"),
		optionRule("list", leaf("src", OpIs, "cat"), "tray"),
		list,
	}

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
		rule := showRule("dep", leaf("list", OpIncludes, "tray"))
		plan := PlanForm(append(slices.Clone(blocks), rule, dep), answers(map[string]any{
			"src":  "dog",
			"list": []string{"tray", "food"},
		}))
		if plan.Visible["dep"] {
			t.Fatal("условие сработало от скрытого варианта")
		}
	})

	t.Run("includes по видимому варианту работает", func(t *testing.T) {
		dep := lblk("dep", "g3", BlockShortText)
		rule := showRule("dep", leaf("list", OpIncludes, "leash"))
		plan := PlanForm(append(slices.Clone(blocks), rule, dep), answers(map[string]any{
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
			blocks := []Block{
				scale, num, lblk("txt", "g3", BlockShortText),
				showRule("dep", tc.rule), dep,
			}
			plan := PlanForm(blocks, answers(tc.answers))
			if got := plan.Visible["dep"]; got != tc.visible {
				t.Fatalf("видимость: got %v, want %v", got, tc.visible)
			}
		})
	}
}

// ---------- правая часть: ссылка на ответ другого вопроса ----------

// leafRef — лист, у которого правая часть не значение, а ОТВЕТ другого блока.
func leafRef(blockID string, op LogicOp, ref string) *Condition {
	return &Condition{BlockID: blockID, Op: op, ValueRef: ref}
}

func TestPlanForm_ValueRef(t *testing.T) {
	mail := lblk("mail", "g1", BlockEmail)
	mail2 := lblk("mail2", "g2", BlockShortText)
	budget := lblk("budget", "g3", BlockNumber)
	price := lblk("price", "g4", BlockNumber)
	pick := lchoice("pick", "g5", BlockSingleChoice, Option{ID: "o1"}, Option{ID: "o2"})
	pick2 := lchoice("pick2", "g6", BlockSingleChoice, Option{ID: "o3"})

	cases := []struct {
		name    string
		rule    *Condition
		answers map[string]any
		visible bool
	}{
		{"равенство по ссылке сработало", leafRef("mail", OpIs, "mail2"), map[string]any{"mail": "a@b", "mail2": "a@b"}, true},
		{"равенство по ссылке не сработало", leafRef("mail", OpIs, "mail2"), map[string]any{"mail": "a@b", "mail2": "c@d"}, false},
		{"неравенство по ссылке", leafRef("mail", OpIsNot, "mail2"), map[string]any{"mail": "a@b", "mail2": "c@d"}, true},
		// Инертное «показать» показало бы цель — значит true здесь означал бы, что
		// пустая ссылка сделала правило инертным. Она его таковым НЕ делает.
		{"пустой ответ по ссылке — пустая правая часть, а не инертность", leafRef("mail", OpIs, "mail2"), map[string]any{"mail": "a@b"}, false},
		{"оба ответа пусты — равны", leafRef("mail", OpIs, "mail2"), map[string]any{}, true},
		{"число больше, чем ответ другого вопроса", leafRef("budget", OpGt, "price"), map[string]any{"budget": "100", "price": "50"}, true},
		{"число не больше ответа другого вопроса", leafRef("budget", OpGt, "price"), map[string]any{"budget": "40", "price": "50"}, false},
		{"почта и короткий текст — один домен", leafRef("mail", OpIs, "mail2"), map[string]any{"mail": "x", "mail2": "x"}, true},
		{"ссылка на удалённый блок — инертна", leafRef("mail", OpIs, "нет-такого"), map[string]any{"mail": "a@b"}, true},
		{"ссылка на другой домен — инертна", leafRef("mail", OpIs, "budget"), map[string]any{"mail": "5", "budget": "5"}, true},
		{"ссылка на выбор — инертна: id вариантов разных списков не совпадают", leafRef("pick", OpIs, "pick2"), map[string]any{"pick": "o1", "pick2": "o1"}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dep := lblk("dep", "g9", BlockShortText)
			blocks := []Block{
				mail, mail2, budget, price, pick, pick2,
				showRule("dep", tc.rule), dep,
			}
			plan := PlanForm(blocks, answers(tc.answers))
			if got := plan.Visible["dep"]; got != tc.visible {
				t.Fatalf("видимость: got %v, want %v", got, tc.visible)
			}
		})
	}
}

// Ссылка ниже ЦЕЛИ инертна ровно так же, как источник ниже цели: к моменту, когда
// решается цель, ответа по ссылке ещё нет, и сравнивать не с чем.
func TestPlanForm_ValueRefBelowTarget(t *testing.T) {
	mail := lblk("mail", "g1", BlockEmail)
	dep := lblk("dep", "g2", BlockShortText)
	later := lblk("later", "g3", BlockShortText)
	blocks := []Block{
		mail, showRule("dep", leafRef("mail", OpIs, "later")), dep, later,
	}
	plan := PlanForm(blocks, answers(map[string]any{"mail": "a@b", "later": "a@b"}))
	if !plan.Visible["dep"] {
		t.Fatal("правило со ссылкой ниже цели обязано быть инертным — цель видима")
	}
}

// ---------- страницы и переходы ----------

// pagedDoc — три страницы: [src] | [q2] | [q3]; разрывы br1 и br2. Переходы приезжают
// блоками logic на ПЕРВОЙ странице: правило принадлежит странице, с которой уходят.
func pagedDoc(jumps ...LogicAction) []Block {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes"}, Option{ID: "no"})
	out := []Block{src}
	if len(jumps) > 0 {
		out = append(out, llogic("L", "gL", leaf("src", OpIs, "no"), jumps...))
	}
	return append(out,
		lblk("br1", "gb1", BlockPageBreak),
		lblk("q2", "g2", BlockShortText),
		lblk("br2", "gb2", BlockPageBreak),
		lblk("q3", "g3", BlockShortText),
	)
}

func TestPlanForm_Pages(t *testing.T) {
	t.Run("без переходов страницы идут подряд", func(t *testing.T) {
		plan := PlanForm(pagedDoc(), answers(map[string]any{}))
		want := [][]string{{"src"}, {"q2"}, {"q3"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("переход вперёд пропускает страницу", func(t *testing.T) {
		jump := LogicAction{Kind: ActJump, To: "br2"}
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
		jump := LogicAction{Kind: ActJump, To: "br2"}
		plan := PlanForm(pagedDoc(jump), answers(map[string]any{"src": "yes"}))
		if got := len(plan.Pages); got != 3 {
			t.Fatalf("страниц: got %d, want 3", got)
		}
	})

	t.Run("end обрывает форму на текущей странице", func(t *testing.T) {
		jump := LogicAction{Kind: ActJump, End: true}
		plan := PlanForm(pagedDoc(jump), answers(map[string]any{"src": "no"}))
		want := [][]string{{"src"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("переход назад инертен", func(t *testing.T) {
		// Правило на ВТОРОМ разрыве ведёт на первый — назад. Обход обязан пойти подряд.
		// Правило стоит на ВТОРОЙ странице и ведёт на первую — назад.
		blocks := pagedDoc()
		blocks = append(blocks[:3], append([]Block{
			llogic("L", "gL", leaf("src", OpIs, "no"), LogicAction{Kind: ActJump, To: "br1"}),
		}, blocks[3:]...)...)
		plan := PlanForm(blocks, answers(map[string]any{"src": "no"}))
		want := [][]string{{"src"}, {"q2"}, {"q3"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("переход в никуда инертен", func(t *testing.T) {
		jump := LogicAction{Kind: ActJump, To: "нет-такого"}
		plan := PlanForm(pagedDoc(jump), answers(map[string]any{"src": "no"}))
		if got := len(plan.Pages); got != 3 {
			t.Fatalf("страниц: got %d, want 3", got)
		}
	})

	t.Run("выигрывает первое сработавшее правило", func(t *testing.T) {
		jump := []LogicAction{
			{Kind: ActJump, To: "br2"},
			{Kind: ActJump, End: true},
		}
		plan := PlanForm(pagedDoc(jump...), answers(map[string]any{"src": "no"}))
		want := [][]string{{"src"}, {"q3"}}
		if got := pageIDs(plan); !reflect.DeepEqual(got, want) {
			t.Fatalf("страницы: got %v, want %v", got, want)
		}
	})

	t.Run("страница, где скрыто всё, не показывается", func(t *testing.T) {
		blocks := pagedDoc()
		blocks = append(blocks[:2], append([]Block{
			showRule("q2", leaf("src", OpIs, "yes")),
		}, blocks[2:]...)...)
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
		blocks := pagedDoc()
		dep := lblk("dep", "g4", BlockShortText)
		blocks = append([]Block{blocks[0], showRule("dep", leaf("src", OpIs, "yes")), dep}, blocks[1:]...)
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
	list := lchoice("list", "g3", BlockMultiChoice, Option{ID: "a"}, Option{ID: "b"})
	single := lchoice("single", "g4", BlockDropdown, Option{ID: "x"}, Option{ID: "y"})
	yes := leaf("src", OpIs, "yes")
	blocks := []Block{
		src,
		showRule("dep", yes), dep,
		optionRule("list", yes, "a"), list,
		optionRule("single", yes, "x"), single,
	}

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
	schema := FormSchema{
		SchemaVersion: SchemaVersion,
		Blocks:        []Block{src, showRule("dep", leaf("src", OpIs, "yes")), dep},
	}

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

	t.Run("обязателен только при сработавшем условии", func(t *testing.T) {
		phone := lblk("phone", "g2", BlockPhone)
		s := FormSchema{
			SchemaVersion: SchemaVersion,
			Blocks:        []Block{src, requireRule("phone", leaf("src", OpIs, "yes")), phone},
		}

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

// ---------- правила из блока logic ----------
//
// ЭТОТ ЖЕ состав случаев — в web/app/src/entities/logic.test.ts, describe'ы
// «planForm: блок logic — …». Названия совпадают, чтобы расхождение было видно диффом.

func llogic(id, group string, when *Condition, actions ...LogicAction) Block {
	b := lblk(id, group, BlockLogic)
	b.Logic = &Logic{When: when, Then: actions}
	return b
}

func act(kind LogicActionKind, targets ...string) LogicAction {
	return LogicAction{Kind: kind, Targets: targets}
}

func TestPlanForm_LogicBlockVisibility(t *testing.T) {
	// [src] [L] [cap dep] — цель стоит НИЖЕ блока, источник ВЫШЕ него.
	doc := func(l Block) []Block {
		src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
		return []Block{src, l, lblk("cap", "g2", BlockTitle), lblk("dep", "g2", BlockShortText)}
	}

	cases := []struct {
		name    string
		logic   Block
		answers map[string]any
		visible bool
	}{
		{
			"show: сработало — показан",
			llogic("L", "gL", leaf("src", OpIs, "yes"), act(ActShow, "cap")),
			map[string]any{"src": "yes"},
			true,
		},
		{
			"show: не сработало — скрыт (умолчание перевёрнуто)",
			llogic("L", "gL", leaf("src", OpIs, "yes"), act(ActShow, "cap")),
			map[string]any{"src": "no"},
			false,
		},
		{
			"hide: сработало — скрыт",
			llogic("L", "gL", leaf("src", OpIs, "yes"), act(ActHide, "cap")),
			map[string]any{"src": "yes"},
			false,
		},
		{
			"hide: не сработало — виден",
			llogic("L", "gL", leaf("src", OpIs, "yes"), act(ActHide, "cap")),
			map[string]any{"src": "no"},
			true,
		},
		{
			"блок без условия инертен",
			llogic("L", "gL", nil, act(ActShow, "cap")),
			map[string]any{"src": "no"},
			true,
		},
		{
			"блок без действий ничего не делает",
			llogic("L", "gL", leaf("src", OpIs, "yes")),
			map[string]any{"src": "no"},
			true,
		},
		{
			"действие на удалённую цель инертно",
			llogic("L", "gL", leaf("src", OpIs, "yes"), act(ActShow, "призрак")),
			map[string]any{"src": "no"},
			true,
		},
		{
			"источник НИЖЕ блока — правило инертно",
			llogic("L", "gL", leaf("dep", OpAnswered, ""), act(ActShow, "cap")),
			map[string]any{},
			true,
		},
		{
			"ссылка на несуществующий источник инертна",
			llogic("L", "gL", leaf("нет-такого", OpIs, "x"), act(ActShow, "cap")),
			map[string]any{},
			true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			plan := PlanForm(doc(tc.logic), answers(tc.answers))
			// Действие адресует ГОЛОВУ группы и прячет вопрос целиком.
			if plan.Visible["dep"] != tc.visible || plan.Visible["cap"] != tc.visible {
				t.Fatalf("видимость вопроса: ожидалось %v, получено cap=%v dep=%v",
					tc.visible, plan.Visible["cap"], plan.Visible["dep"])
			}
		})
	}
}

// Блок волен стоять ГДЕ УГОДНО, в том числе ниже того, что прячет: обходу важно лишь
// то, что источник решён к моменту, когда решается цель (ADR §10, 2026-08-16).
func TestPlanForm_LogicBlockBelowTarget(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
	blocks := []Block{
		src,
		lblk("cap", "g2", BlockTitle),
		lblk("dep", "g2", BlockShortText),
		llogic("L", "gL", leaf("src", OpIs, "yes"), act(ActShow, "cap")),
	}
	if PlanForm(blocks, answers(map[string]any{"src": "no"})).Visible["dep"] {
		t.Fatal("блок ниже цели обязан действовать: источник стоит выше цели")
	}
	if !PlanForm(blocks, answers(map[string]any{"src": "yes"})).Visible["dep"] {
		t.Fatal("условие сработало — вопрос обязан быть виден")
	}
}

// А вот источник НИЖЕ цели — инертен: к моменту, когда решается цель, он не решён.
func TestPlanForm_LogicBlockSourceBelowTarget(t *testing.T) {
	blocks := []Block{
		lblk("cap", "g1", BlockTitle),
		lblk("dep", "g1", BlockShortText),
		lchoice("src", "g2", BlockSingleChoice, Option{ID: "yes", Label: "Да"}),
		llogic("L", "gL", leaf("src", OpIs, "yes"), act(ActShow, "cap")),
	}
	if !PlanForm(blocks, answers(map[string]any{"src": "no"})).Visible["dep"] {
		t.Fatal("источник ниже цели — правило обязано быть инертным")
	}
}

func TestPlanForm_LogicBlockHideBeatsShow(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
	blocks := []Block{
		src,
		llogic("L1", "gL1", leaf("src", OpAnswered, ""), act(ActShow, "cap")),
		llogic("L2", "gL2", leaf("src", OpIs, "yes"), act(ActHide, "cap")),
		lblk("cap", "g2", BlockTitle),
		lblk("dep", "g2", BlockShortText),
	}
	if PlanForm(blocks, answers(map[string]any{"src": "yes"})).Visible["dep"] {
		t.Fatal("скрыть обязано побеждать показать")
	}
	if !PlanForm(blocks, answers(map[string]any{"src": "no"})).Visible["dep"] {
		t.Fatal("сработало только показать — вопрос обязан быть виден")
	}
}

func TestPlanForm_LogicBlockOrderIndependent(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
	a := llogic("L1", "gL1", leaf("src", OpIs, "yes"), act(ActShow, "cap"))
	b := llogic("L2", "gL2", leaf("src", OpIs, "no"), act(ActShow, "cap"))
	tail := []Block{lblk("cap", "g2", BlockTitle), lblk("dep", "g2", BlockShortText)}

	for _, given := range []map[string]any{{"src": "yes"}, {"src": "no"}, {}} {
		first := PlanForm(append([]Block{src, a, b}, tail...), answers(given)).Visible["dep"]
		second := PlanForm(append([]Block{src, b, a}, tail...), answers(given)).Visible["dep"]
		if first != second {
			t.Fatalf("порядок блоков logic изменил результат при ответах %v: %v против %v", given, first, second)
		}
	}
}

func TestPlanForm_LogicBlockShowsOr(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
	blocks := []Block{
		src,
		llogic("L1", "gL1", leaf("src", OpIs, "yes"), act(ActShow, "cap")),
		llogic("L2", "gL2", leaf("src", OpIs, "no"), act(ActShow, "cap")),
		lblk("cap", "g2", BlockTitle),
		lblk("dep", "g2", BlockShortText),
	}
	for _, tc := range []struct {
		given   map[string]any
		visible bool
	}{
		{map[string]any{"src": "yes"}, true},
		{map[string]any{"src": "no"}, true},
		{map[string]any{}, false},
	} {
		if got := PlanForm(blocks, answers(tc.given)).Visible["dep"]; got != tc.visible {
			t.Fatalf("несколько «показать» складываются по ИЛИ: при %v ожидалось %v", tc.given, tc.visible)
		}
	}
}

func TestPlanForm_LogicBlockMultipleActions(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
	blocks := []Block{
		src,
		llogic("L", "gL", leaf("src", OpIs, "yes"), act(ActShow, "cap"), act(ActRequire, "dep")),
		lblk("cap", "g2", BlockTitle),
		lblk("dep", "g2", BlockShortText),
	}
	plan := PlanForm(blocks, answers(map[string]any{"src": "yes"}))
	if !plan.Visible["dep"] || !plan.Required["dep"] {
		t.Fatalf("одно условие обязано раздать оба действия: visible=%v required=%v",
			plan.Visible["dep"], plan.Required["dep"])
	}
}

func TestPlanForm_LogicBlockNotVisible(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"})
	blocks := []Block{
		src,
		llogic("L", "gL", leaf("src", OpAnswered, "")),
		lblk("cap", "g2", BlockTitle),
		lblk("dep", "g2", BlockShortText),
	}
	plan := PlanForm(blocks, answers(map[string]any{"src": "yes"}))
	if plan.Visible["L"] {
		t.Fatal("блок logic не показывается респонденту")
	}
	if got := pageIDs(plan); !reflect.DeepEqual(got, [][]string{{"src", "cap", "dep"}}) {
		t.Fatalf("блок logic попал на страницу: %v", got)
	}
}

func TestPlanForm_LogicBlockRequired(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "call", Label: "Звонок"}, Option{ID: "mail", Label: "Почта"})

	t.Run("действие сработало — обязателен", func(t *testing.T) {
		blocks := []Block{src, llogic("L", "gL", leaf("src", OpIs, "call"), act(ActRequire, "dep")), lblk("dep", "g2", BlockPhone)}
		if !PlanForm(blocks, answers(map[string]any{"src": "call"})).Required["dep"] {
			t.Fatal("сработавшее действие обязано делать вопрос обязательным")
		}
		if PlanForm(blocks, answers(map[string]any{"src": "mail"})).Required["dep"] {
			t.Fatal("несработавшее действие обязательности не создаёт")
		}
	})

	t.Run("флаг required и действие складываются по ИЛИ", func(t *testing.T) {
		dep := lblk("dep", "g2", BlockPhone)
		dep.Required = true
		blocks := []Block{src, llogic("L", "gL", leaf("src", OpIs, "call"), act(ActRequire, "dep")), dep}
		if !PlanForm(blocks, answers(map[string]any{"src": "mail"})).Required["dep"] {
			t.Fatal("флаг required действует независимо от условия")
		}
	})

	t.Run("скрытый вопрос не обязателен никогда", func(t *testing.T) {
		blocks := []Block{
			src,
			llogic("L", "gL", leaf("src", OpIs, "call"), act(ActHide, "dep"), act(ActRequire, "dep")),
			lblk("dep", "g2", BlockPhone),
		}
		if PlanForm(blocks, answers(map[string]any{"src": "call"})).Required["dep"] {
			t.Fatal("видимость старше обязательности")
		}
	})
}

func TestPlanForm_LogicBlockOptions(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "dog", Label: "Собака"}, Option{ID: "cat", Label: "Кот"})
	list := lchoice("list", "g2", BlockMultiChoice,
		Option{ID: "leash", Label: "Поводок"}, Option{ID: "tray", Label: "Лоток"}, Option{ID: "food", Label: "Корм"})
	rule := func(kind LogicActionKind, ids ...string) Block {
		b := lblk("L", "gL", BlockLogic)
		b.Logic = &Logic{When: leaf("src", OpIs, "dog"), Then: []LogicAction{{Kind: kind, Targets: ids}}}
		return b
	}

	t.Run("«скрыть варианты» прячет названные", func(t *testing.T) {
		plan := PlanForm([]Block{src, rule(ActHide, "tray"), list}, answers(map[string]any{"src": "dog"}))
		if plan.OptionVisible("list", "tray") {
			t.Fatal("названный вариант обязан быть скрыт")
		}
		if !plan.OptionVisible("list", "leash") || !plan.OptionVisible("list", "food") {
			t.Fatal("не названные варианты обязаны остаться видимыми")
		}
	})

	t.Run("«показать варианты» переворачивает умолчание названных", func(t *testing.T) {
		blocks := []Block{src, rule(ActShow, "leash"), list}
		if PlanForm(blocks, answers(map[string]any{"src": "cat"})).OptionVisible("list", "leash") {
			t.Fatal("условие не сработало — названный вариант обязан быть скрыт")
		}
		if !PlanForm(blocks, answers(map[string]any{"src": "dog"})).OptionVisible("list", "leash") {
			t.Fatal("условие сработало — названный вариант обязан быть виден")
		}
		if !PlanForm(blocks, answers(map[string]any{"src": "cat"})).OptionVisible("list", "food") {
			t.Fatal("не названный вариант умолчания не менял")
		}
	})

	t.Run("скрытый вариант не считается выбором", func(t *testing.T) {
		dep := lblk("dep", "g3", BlockShortText)
		blocks := []Block{
			src, rule(ActHide, "tray"), list,
			showRule("dep", leaf("list", OpIncludes, "tray")), dep,
		}
		plan := PlanForm(blocks, answers(map[string]any{"src": "dog", "list": []string{"tray", "food"}}))
		if plan.Visible["dep"] {
			t.Fatal("выбранный скрытый вариант не считается выбором")
		}
	})
}

func TestPlanForm_LogicBlockJumpAndSubmit(t *testing.T) {
	// Три страницы: [src, L] | [q2] | [q3].
	paged := func(actions ...LogicAction) []Block {
		src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
		return []Block{
			src,
			llogic("L", "gL", leaf("src", OpIs, "no"), actions...),
			lblk("br1", "gb1", BlockPageBreak),
			lblk("q2", "g2", BlockShortText),
			lblk("br2", "gb2", BlockPageBreak),
			lblk("q3", "g3", BlockShortText),
		}
	}
	no := answers(map[string]any{"src": "no"})
	yes := answers(map[string]any{"src": "yes"})

	t.Run("переход со СВОЕЙ страницы пропускает следующую", func(t *testing.T) {
		got := pageIDs(PlanForm(paged(LogicAction{Kind: ActJump, To: "br2"}), no))
		if !reflect.DeepEqual(got, [][]string{{"src"}, {"q3"}}) {
			t.Fatalf("страницы: %v", got)
		}
	})

	t.Run("условие не сработало — идём подряд", func(t *testing.T) {
		if got := PlanForm(paged(LogicAction{Kind: ActJump, To: "br2"}), yes); len(got.Pages) != 3 {
			t.Fatalf("страниц: %d", len(got.Pages))
		}
	})

	t.Run("end обрывает форму на текущей странице", func(t *testing.T) {
		got := pageIDs(PlanForm(paged(LogicAction{Kind: ActJump, End: true}), no))
		if !reflect.DeepEqual(got, [][]string{{"src"}}) {
			t.Fatalf("страницы: %v", got)
		}
	})

	t.Run("переход назад инертен", func(t *testing.T) {
		if got := PlanForm(paged(LogicAction{Kind: ActJump, To: "br1"}), no); len(got.Pages) != 3 {
			t.Fatalf("страниц: %d", len(got.Pages))
		}
	})

	t.Run("«скрыть кнопку» обрывает обход и помечает план", func(t *testing.T) {
		plan := PlanForm(paged(LogicAction{Kind: ActBlockSubmit}), no)
		if !plan.Blocked {
			t.Fatal("план обязан быть помечен заблокированным")
		}
		if got := pageIDs(plan); !reflect.DeepEqual(got, [][]string{{"src"}}) {
			t.Fatalf("страницы: %v", got)
		}
	})

	t.Run("«скрыть кнопку» не сработало — план не заблокирован", func(t *testing.T) {
		plan := PlanForm(paged(LogicAction{Kind: ActBlockSubmit}), yes)
		if plan.Blocked || len(plan.Pages) != 3 {
			t.Fatalf("blocked=%v страниц=%d", plan.Blocked, len(plan.Pages))
		}
	})

	t.Run("«скрыть кнопку» старше перехода с той же страницы", func(t *testing.T) {
		plan := PlanForm(paged(LogicAction{Kind: ActJump, To: "br2"}, LogicAction{Kind: ActBlockSubmit}), no)
		if !plan.Blocked {
			t.Fatal("кнопка обязана перевесить переход")
		}
		if got := pageIDs(plan); !reflect.DeepEqual(got, [][]string{{"src"}}) {
			t.Fatalf("страницы: %v", got)
		}
	})

	t.Run("форма без блоков logic не заблокирована", func(t *testing.T) {
		if PlanForm([]Block{lblk("q", "g1", BlockShortText)}, nil).Blocked {
			t.Fatal("форма без логики не блокируется")
		}
	})
}

// Спрятанная разметкой кнопка не защищает от curl: приём обязан отвергнуть отправку
// сам (инвариант безопасности 3).
func TestNormalizeAnswers_BlockedFormRejected(t *testing.T) {
	src := lchoice("src", "g1", BlockSingleChoice, Option{ID: "yes", Label: "Да"}, Option{ID: "no", Label: "Нет"})
	schema := FormSchema{Blocks: []Block{
		src,
		llogic("L", "gL", leaf("src", OpIs, "no"), LogicAction{Kind: ActBlockSubmit}),
	}}

	if _, err := NormalizeAnswers(schema, answers(map[string]any{"src": "no"})); err == nil {
		t.Fatal("отправка заблокированной формы обязана быть отвергнута")
	} else if !errors.Is(err, ErrValidation) {
		t.Fatalf("ошибка обязана быть ErrValidation, получено: %v", err)
	}

	// Та же форма при другом ответе принимается: блокировка — это ветка, а не режим.
	if _, err := NormalizeAnswers(schema, answers(map[string]any{"src": "yes"})); err != nil {
		t.Fatalf("незаблокированная ветка обязана приниматься: %v", err)
	}
}

// ---------- форма правил в схеме ----------

func TestValidateSchema_LogicValid(t *testing.T) {
	cases := map[string]string{
		"условие листом": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да"}]}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"is","value":"o1"},"then":[{"kind":"show","targets":["b"]}]}},
			{"id":"b","groupId":"g2","type":"short_text","settings":{}}
		]}`,
		"условие вложенными группами": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"any":[
				{"all":[{"blockId":"a","op":"answered"},{"blockId":"a","op":"is","value":"x"}]},
				{"blockId":"a","op":"is","value":"y"}
			]}}}
		]}`,
		"значение не выбрано — законный черновик": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"is","value":""}}}
		]}`,
		"правая часть ссылкой на ответ": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"number","settings":{}},
			{"id":"b","groupId":"g2","type":"number","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"gt","valueRef":"b"}}}
		]}`,
		"ссылка на несравнимый тип — инертна, но валидна": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"number","settings":{}},
			{"id":"b","groupId":"g2","type":"short_text","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"is","valueRef":"b"}}}
		]}`,
		"пустая ссылка — как отсутствующая": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"is","value":"x","valueRef":""}}}
		]}`,
		"ссылка вперёд — инертна, но валидна": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"answered"}}},
			{"id":"a","groupId":"g1","type":"short_text","settings":{}}
		]}`,
		"ссылка на удалённый блок — инертна, но валидна": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"призрак","op":"answered"}}}
		]}`,
		"обязательность по условию": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"answered"},"then":[{"kind":"require","targets":["b"]}]}},
			{"id":"b","groupId":"g2","type":"phone","settings":{}}
		]}`,
		"скрытие варианта": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"is","value":"dog"},"then":[{"kind":"hide","targets":["o1"]}]}},
			{"id":"b","groupId":"g2","type":"multi_choice","settings":{"options":[{"id":"o1","label":"Поводок"}]}}
		]}`,
		"переходы блоком": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"empty"},"then":[
				{"kind":"jump","to":"br2"},
				{"kind":"jump","end":true}
			]}},
			{"id":"br","groupId":"g2","type":"page_break"},
			{"id":"c","groupId":"g3","type":"short_text","settings":{}}
		]}`,
		"глубина ровно в лимит": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":
				{"all":[{"any":[{"all":[{"blockId":"a","op":"answered"}]}]}]}}}
		]}`,
		"блок logic: условие и все виды действий": `{"schemaVersion":1,"blocks":[
			{"id":"a","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да"}]}},
			{"id":"L","groupId":"g2","type":"logic","logic":{
				"when":{"blockId":"a","op":"is","value":"o1"},
				"then":[
					{"kind":"show","targets":["b"]},
					{"kind":"hide","targets":["c"]},
					{"kind":"require","targets":["b"]},
					{"kind":"show","targets":["o2"]},
					{"kind":"hide","targets":["o2","o3"]},
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
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"show","targets":["призрак"]}]}}
		]}`,
		"цель СТОИТ ВЫШЕ блока — инертно, но валидно": `{"schemaVersion":1,"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{}},
			{"id":"L","groupId":"g2","type":"logic","logic":{"then":[{"kind":"show","targets":["b"]}]}}
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
		strings.Repeat(`{"kind":"show","targets":["b"]},`, MaxLogicActions+1), ",")

	cases := map[string]string{
		"пустое условие": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{}}}
		]}`,
		"пустая группа": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"all":[]}}}
		]}`,
		"all и any одновременно": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{
				"all":[{"blockId":"a","op":"answered"}],"any":[{"blockId":"a","op":"empty"}]}}}
		]}`,
		"группа с полями листа": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{
				"all":[{"blockId":"a","op":"answered"}],"blockId":"a","op":"is","value":"x"}}}
		]}`,
		"и значение, и ссылка сразу": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"is","value":"x","valueRef":"b"}}}
		]}`,
		"ссылка у оператора, который не сравнивает": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"answered","valueRef":"b"}}}
		]}`,
		"неизвестный оператор": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"matches","value":"x"}}}
		]}`,
		"оператора нет вовсе": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a"}}}
		]}`,
		"пустой blockId": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"","op":"answered","value":"x"}}}
		]}`,
		"значение у answered": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"answered","value":"x"}}}
		]}`,
		"значение длиннее лимита": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"is","value":"` + long + `"}}}
		]}`,
		"вложенность глубже лимита": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":` + deep + `}}
		]}`,
		"лишний ключ в условии": `{"schemaVersion":1,"blocks":[
			{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"blockId":"a","op":"is","value":"x","not":true}}}
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
			{"id":"b","groupId":"g1","type":"short_text","settings":{},"logic":{"then":[{"kind":"show","targets":["c"]}]}}
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
			{"id":"L","groupId":"g1","type":"logic","logic":{"then":[{"kind":"hide","targets":[]}]}}
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
		return `{"schemaVersion":1,"blocks":[{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"all":[` +
			strings.Join(leaves[:n], ",") + `]}}}]}`
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
		{"id":"a","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да"}]}},
		{"id":"L","groupId":"gL","type":"logic","logic":{
			"when":{"all":[{"blockId":"a","op":"is","value":"o1"}]},
			"then":[
				{"kind":"show","targets":["b"]},
				{"kind":"require","targets":["b"]},
				{"kind":"hide","targets":["o9"]},
				{"kind":"jump","end":true}
			]}},
		{"id":"b","groupId":"g2","type":"short_text","settings":{}},
		{"id":"c","groupId":"g4","type":"multi_choice","settings":{"options":[{"id":"o9","label":"Девять"}]}}
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
	for _, want := range []string{`"logic"`, `"when"`, `"then"`, `"targets":["o9"]`, `"end":true`} {
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
	schema := FormSchema{
		SchemaVersion: SchemaVersion,
		Blocks:        []Block{src, showRule("dep", leaf("src", OpIs, "yes")), dep},
	}
	versions := []VersionedSchema{{Version: 1, Schema: schema}}

	b := NewSummaryBuilder(versions)
	// Трое ответили «Нет» — им «Какой?» не показывали; один «Да» и заполнил.
	for range 3 {
		b.Add(1, sampleTime, answers(map[string]any{"src": "no"}))
	}
	b.Add(1, sampleTime, answers(map[string]any{"src": "yes", "dep": "Барсик"}))

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
	b.Add(1, sampleTime, answers(map[string]any{"q1": "а"}))
	b.Add(1, sampleTime, answers(map[string]any{"q1": "б", "q2": "в"}))

	for _, bs := range b.Result().Blocks {
		if bs.Asked != 2 {
			t.Fatalf("%s: asked=%d, ожидалось 2", bs.BlockID, bs.Asked)
		}
	}
}

func TestSummary_HiddenByJump_NotAsked(t *testing.T) {
	// Пропущенная переходом страница в знаменатель не идёт — она не показывалась.
	blocks := pagedDoc(LogicAction{Kind: ActJump, To: "br2"})
	versions := []VersionedSchema{{Version: 1, Schema: FormSchema{SchemaVersion: SchemaVersion, Blocks: blocks}}}

	b := NewSummaryBuilder(versions)
	b.Add(1, sampleTime, answers(map[string]any{"src": "no"}))             // перескочил q2
	b.Add(1, sampleTime, answers(map[string]any{"src": "yes", "q2": "x"})) // прошёл всё

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

// РЕГРЕСС (ревью фазы 24). Ответ-файл — массив id загрузок. Пока разбор знал только
// про multi_choice, строковая ветка отвергала массив, ответ выглядел пустым, и
// правило «если файл приложен» не срабатывало НИКОГДА — молча, без ошибок.
func TestLogic_FileAnswerIsVisibleToConditions(t *testing.T) {
	blocks := []Block{
		{ID: "cv", GroupID: "g1", Type: BlockFile},
		{ID: "rule", GroupID: "g2", Type: BlockLogic, Logic: &Logic{
			When: &Condition{BlockID: "cv", Op: OpAnswered},
			Then: []LogicAction{{Kind: ActShow, Targets: []string{"note"}}},
		}},
		{ID: "note", GroupID: "g3", Type: BlockShortText},
	}

	withFile := PlanForm(blocks, map[string]json.RawMessage{"cv": json.RawMessage(`["u1"]`)})
	if !withFile.Visible["note"] {
		t.Error("условие «файл приложен» не сработало на непустом списке загрузок")
	}

	withoutFile := PlanForm(blocks, map[string]json.RawMessage{"cv": json.RawMessage(`[]`)})
	if withoutFile.Visible["note"] {
		t.Error("условие сработало на пустом списке файлов")
	}
}
