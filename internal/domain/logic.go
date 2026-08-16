package domain

import (
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"unicode/utf8"
)

// Условная логика формы — дерево условий и вычислитель плана.
// Спеки: docs/design/logic.md (фаза 21) и logic-blocks.md (переезд на полотно),
// решения — ADR §10 ARCHITECTURE.md.
//
// Зеркало фронта — web/shared/entities/blocks/conditions.ts (форма узла и лимиты),
// blocks/logic.ts (действия) и web/shared/fields/logic.ts (вычислитель). Общего кода
// между Go и TS в проекте нет по построению, поэтому паритет держат одинаковые таблицы
// кейсов с обеих сторон и logicparity_test.go (состав операторов и действий). Правка
// любой стороны — тем же PR.
//
// ПРАВИЛО ЖИВЁТ В БЛОКЕ `logic`: одно условие и список действий со ссылкой на цель
// (показать, скрыть, сделать обязательным, показать/скрыть варианты, перейти на
// страницу, скрыть кнопку отправки). ПОЗИЦИЯ БЛОКА ЗНАЧИМА: источники условия обязаны
// стоять выше него, цели действий — ниже. Отсюда прежний инвариант «все источники решены
// к моменту, когда решается цель» получается следствием, а не проверкой.

//
// ГЛАВНОЕ ПРАВИЛО СЕМАНТИКИ: **инертное правило равно отсутствующему**. Условие,
// которое невозможно разрешить (источника нет, источник лежит НИЖЕ носителя, оператор
// не подходит типу источника, значение не задано), не отвергается валидатором и не
// считается ложным — оно просто не действует: вопрос показывается, обязательность не
// возникает, переход не срабатывает. Причина не в мягкости, а в том, что обратное
// невозможно построить: любая кросс-блочная проверка в схеме ловила бы 422 в автосейве,
// едва автор перетащил источник ниже зависимого (тот же довод, по которому не
// валидируются бит ряда и разрыв страницы). Инертность вместо запрета заодно делает
// циклы невозможными ПО ПОСТРОЕНИЮ обхода, а не по проверке.
//
// Скрытый источник — другое дело: его ответ считается ПУСТЫМ, и условие считается по
// пустому. «Покажи Б, если А = Да» при непоказанном А означает «Б не показывать» — это
// то, чего ждёт автор; инертность здесь показала бы всю ветку целиком.

// Лимиты дерева условий. Оба первых обязательны: без них стоимость вычисления чужого
// документа умножается на MaxBlocks — тот же класс проблемы, что у MaxSpans в тексте.
const (
	MaxLogicDepth    = 4   // глубина вложенности групп И/ИЛИ
	MaxLogicNodes    = 40  // узлов (групп и листьев) в одном правиле
	MaxLogicValueLen = 200 // длина значения сравнения, в рунах (как placeholder)
	MaxLogicActions  = 10  // действий в одном блоке logic
)

// LogicOp — оператор сравнения в листе условия. Зеркалит LOGIC_OPERATORS в logic.ts.
type LogicOp string

const (
	// Наличие ответа — у любого отвечаемого типа.
	OpAnswered LogicOp = "answered"
	OpEmpty    LogicOp = "empty"
	// Равенство: id варианта у одиночного выбора, число у шкалы и number, ConsentYes у
	// согласия, точная строка у текстовых.
	OpIs    LogicOp = "is"
	OpIsNot LogicOp = "is_not"
	// Множественный выбор: содержит ли ответ этот вариант.
	OpIncludes LogicOp = "includes"
	OpExcludes LogicOp = "excludes"
	// Числовое сравнение — только шкала и number.
	OpGt LogicOp = "gt"
	OpLt LogicOp = "lt"
)

// logicOps — все операторы одним списком, и он же источник valid(). Один список, а не
// switch плюс отдельный перечень: ровно тот урок, который фаза 16 вынесла из blockTypes.
var logicOps = []LogicOp{OpAnswered, OpEmpty, OpIs, OpIsNot, OpIncludes, OpExcludes, OpGt, OpLt}

func (op LogicOp) valid() bool { return slices.Contains(logicOps, op) }

// needsValue — оператор сравнивает ответ со значением. У answered/empty значения нет
// вовсе: непустое value у них — мусор в документе, и он отвергается.
func (op LogicOp) needsValue() bool { return op != OpAnswered && op != OpEmpty }

// appliesTo — осмыслен ли оператор у типа блока-источника. Схемой НЕ проверяется
// (changeBlockType у источника иначе ронял бы 422 в автосейв) — несовместимая пара
// делает правило инертным, а предупреждает о ней билдер.
func (op LogicOp) appliesTo(t BlockType) bool {
	if !t.isAnswerable() {
		return false // у подписи и контента нет ответа, сравнивать нечего
	}
	switch op {
	case OpAnswered, OpEmpty:
		return true
	case OpIs, OpIsNot:
		// У множественного выбора «равно» неопределимо: ответ — массив. Ему includes.
		return !t.isMultiChoice()
	case OpIncludes, OpExcludes:
		return t.isMultiChoice()
	case OpGt, OpLt:
		return t == BlockScale || t == BlockNumber
	default:
		return false
	}
}

// Condition — узел дерева условий: группа «все» (all), группа «любое» (any) или лист
// сравнения (blockId + op + value). Ровно одна из трёх форм заполнена — это
// проверяется схемой (внутриузловое правило, промежуточных состояний драга не имеет).
//
// Одна структура на три формы, а не интерфейс с тремя реализациями: так работает
// DisallowUnknownFields (лишний ключ ловится сразу), а рекурсивный JSON разбирается
// stdlib'ом без своего UnmarshalJSON.
type Condition struct {
	All []Condition `json:"all,omitempty"`
	Any []Condition `json:"any,omitempty"`
	// Лист: на КАКОЙ ответ смотрим. Всегда id отвечаемого блока — того же, которым
	// вопрос зовётся в CSV, воронке и сводке. Ссылка на подпись или контент инертна.
	BlockID string  `json:"blockId,omitempty"`
	Op      LogicOp `json:"op,omitempty"`
	// Value — значение в том же виде, в каком хранится ответ (answer.ts): id варианта,
	// число строкой, ConsentYes. Второго формата не заводим: расхождение здесь — это
	// молчащее «условие никогда не срабатывает». Пусто у answered/empty; пусто у
	// остальных — недособранный черновик (автор ещё не выбрал), правило инертно.
	Value string `json:"value,omitempty"`
}

// LogicActionKind — что правило ДЕЛАЕТ, когда условие сработало. Зеркалит LOGIC_ACTIONS
// в blocks/logic.ts; порядок списка контрактный (logicparity_test.go читает тот файл).
type LogicActionKind string

const (
	// Видимость цели: ActShow переворачивает умолчание вопроса в «скрыт» и показывает
	// по условию, ActHide оставляет «виден» и прячет по условию.
	ActShow LogicActionKind = "show"
	ActHide LogicActionKind = "hide"
	// Обязательность отвечаемого блока; складывается с флагом Required по ИЛИ.
	ActRequire LogicActionKind = "require"
	// Видимость отдельных вариантов внутри choice-вопроса (каскадные списки).
	ActShowOptions LogicActionKind = "show_options"
	ActHideOptions LogicActionKind = "hide_options"
	// Переход со страницы, на которой стоит блок.
	ActJump LogicActionKind = "jump"
	// «Кнопки нет»: обход завершается на этой странице, отправить форму нельзя.
	ActBlockSubmit LogicActionKind = "block_submit"
)

var logicActions = []LogicActionKind{
	ActShow, ActHide, ActRequire, ActShowOptions, ActHideOptions, ActJump, ActBlockSubmit,
}

func (k LogicActionKind) valid() bool { return slices.Contains(logicActions, k) }

// needsTarget — действие адресует блок. У перехода цель своя (To/End), у блокировки
// отправки цели нет вовсе: она про страницу, на которой блок стоит.
func (k LogicActionKind) needsTarget() bool {
	switch k {
	case ActShow, ActHide, ActRequire, ActShowOptions, ActHideOptions:
		return true
	default:
		return false
	}
}

// needsOptions — действие адресует варианты ВНУТРИ блока-цели.
func (k LogicActionKind) needsOptions() bool {
	return k == ActShowOptions || k == ActHideOptions
}

// LogicAction — одно действие. Одна структура на все формы, а не интерфейс с семью
// реализациями, — по тому же доводу, что у Condition: так работает
// DisallowUnknownFields, и JSON разбирается stdlib'ом без своего UnmarshalJSON.
type LogicAction struct {
	Kind LogicActionKind `json:"kind"`
	// Target — id блока-цели. Голова группы у show/hide (прячется вопрос целиком),
	// отвечаемый блок у require, choice-блок у *_options. Ссылка на groupId
	// невозможна: он ВЫВОДИТСЯ (regroup) и сущностью схемы не является.
	Target string `json:"target,omitempty"`
	// Options — id вариантов внутри Target. Списком, а не действием на вариант: автор
	// прячет «все, кроме подходящих» одним движением.
	Options []string `json:"options,omitempty"`
	// To/End — цель перехода, ровно одна из двух (довод — у JumpRule выше).
	To  string `json:"to,omitempty"`
	End bool   `json:"end,omitempty"`
}

// BlockLogic — содержимое блока logic. Обе половины НЕОБЯЗАТЕЛЬНЫ по отдельности: блок,
// у которого автор ещё не выбрал условие или ещё не выбрал действие, — законное
// состояние черновика, ровно как лист с пустым Value. Полупустой блок инертен целиком.
type Logic struct {
	When *Condition    `json:"when,omitempty"`
	Then []LogicAction `json:"then,omitempty"`
}

// validateBlockLogic — форма содержимого блока logic. Что здесь НЕ проверяется:
// существование блока-цели, её позиция относительно блока, совместимость цели с
// действием (обязательным можно сделать только отвечаемый, варианты бывают только у
// choice). Всё это кросс-блочное — см. доклок файла: неразрешимое действие ИНЕРТНО.
func validateBlockLogic(l *Logic) error {
	if l == nil {
		return nil
	}
	if err := validateCondition(l.When, "logic.when"); err != nil {
		return err
	}
	if len(l.Then) > MaxLogicActions {
		return fmt.Errorf("больше %d действий", MaxLogicActions)
	}
	for i, a := range l.Then {
		at := fmt.Sprintf("действие #%d", i)
		if !a.Kind.valid() {
			return fmt.Errorf("%s: неизвестное действие %q", at, a.Kind)
		}
		if a.Kind.needsTarget() {
			if err := validateID(a.Target); err != nil {
				return fmt.Errorf("%s: target: %s", at, err)
			}
		} else if a.Target != "" {
			return fmt.Errorf("%s: действие %q не адресует блок", at, a.Kind)
		}
		if a.Kind.needsOptions() {
			if len(a.Options) == 0 {
				return fmt.Errorf("%s: не выбрано ни одного варианта", at)
			}
			if len(a.Options) > MaxOptions {
				return fmt.Errorf("%s: больше %d вариантов", at, MaxOptions)
			}
			for _, id := range a.Options {
				if err := validateID(id); err != nil {
					return fmt.Errorf("%s: options: %s", at, err)
				}
			}
		} else if len(a.Options) > 0 {
			return fmt.Errorf("%s: действие %q не адресует варианты", at, a.Kind)
		}
		if a.Kind == ActJump {
			if (a.To != "") == a.End {
				return fmt.Errorf("%s: нужна ровно одна цель — to или end", at)
			}
			if a.To != "" {
				if err := validateID(a.To); err != nil {
					return fmt.Errorf("%s: to: %s", at, err)
				}
			}
			continue
		}
		if a.To != "" || a.End {
			return fmt.Errorf("%s: цель перехода задана у действия %q", at, a.Kind)
		}
	}
	return nil
}

// validateCondition проверяет форму дерева. Что здесь НЕ проверяется — существование
// блока-источника, его позиция, совместимость оператора с типом источника: всё это
// кросс-блочное (см. доклок файла).
func validateCondition(c *Condition, what string) error {
	if c == nil {
		return nil
	}
	nodes := 0
	return validateCondNode(*c, what, 1, &nodes)
}

func validateCondNode(c Condition, what string, depth int, nodes *int) error {
	*nodes++
	if *nodes > MaxLogicNodes {
		return fmt.Errorf("%s: больше %d условий", what, MaxLogicNodes)
	}
	if depth > MaxLogicDepth {
		return fmt.Errorf("%s: вложенность условий глубже %d", what, MaxLogicDepth)
	}

	isAll, isAny := len(c.All) > 0, len(c.Any) > 0
	isLeaf := c.BlockID != "" || c.Op != "" || c.Value != ""
	switch {
	case isAll && isAny:
		return fmt.Errorf("%s: у группы условий одновременно all и any", what)
	case (isAll || isAny) && isLeaf:
		return fmt.Errorf("%s: группа условий сама не сравнивает ответ", what)
	case !isAll && !isAny && !isLeaf:
		// Сюда же попадает `"all": []` — пустая группа. Отвергаем: «условие, которое
		// ничего не проверяет» неотличимо от отсутствия правила, и второй способ
		// сказать то же самое в каноне не нужен.
		return fmt.Errorf("%s: пустое условие", what)
	}

	if isAll || isAny {
		children := c.All
		if isAny {
			children = c.Any
		}
		for i := range children {
			if err := validateCondNode(children[i], what, depth+1, nodes); err != nil {
				return err
			}
		}
		return nil
	}

	if err := validateID(c.BlockID); err != nil {
		return fmt.Errorf("%s: blockId: %s", what, err)
	}
	if !c.Op.valid() {
		return fmt.Errorf("%s: неизвестный оператор %q", what, c.Op)
	}
	if n := utf8.RuneCountInString(c.Value); n > MaxLogicValueLen {
		return fmt.Errorf("%s: значение длиннее %d символов", what, MaxLogicValueLen)
	}
	if !c.Op.needsValue() && c.Value != "" {
		return fmt.Errorf("%s: оператор %q не сравнивает со значением", what, c.Op)
	}
	return nil
}

// validateLogic — правила логики одного блока. Всё внутриблочное, поэтому проверяется
// строго: промежуточных состояний драга и undo у этих условий не бывает.
func validateLogic(b Block) error {
	// Условие и действия несёт только блок logic. Проверка внутриблочная: тип блока и
	// его содержимое лежат рядом, промежуточных состояний драга у этой пары нет.
	if b.Logic != nil && b.Type != BlockLogic {
		return fmt.Errorf("тип %q не несёт условной логики", b.Type)
	}
	return validateBlockLogic(b.Logic)
}

// Plan — что видит респондент при данных ответах. Строится PlanForm.
//
// Отсутствие ключа значит «нет»: скрытый блок, необязательное поле. Options — только у
// блоков, где ХОТЯ БЫ У ОДНОГО варианта есть правило; nil (нет ключа) читается как
// «видны все варианты», иначе каждый потребитель платил бы картой на каждый список.
type Plan struct {
	// Pages — посещаемые страницы в порядке прохода, в них только видимые блоки.
	// Пропущенных переходом страниц здесь нет вовсе.
	Pages [][]Block
	// Visible — id блоков, которые респондент видит (включая неотвечаемые).
	Visible map[string]bool
	// Required — id отвечаемых блоков, обязательных ФАКТИЧЕСКИ (флаг Required или
	// сработавшее действие). Только среди видимых.
	Required map[string]bool
	// Options — id блока → id варианта → показан.
	Options map[string]map[string]bool
	// Blocked — обход упёрся в действие «скрыть кнопку»: на последней показанной
	// странице кнопки нет, и форму отправить нельзя. Не то же самое, что «страниц
	// больше нет»: приём такой отправки обязан её отвергнуть.
	Blocked bool
}

// logicRule — одно ПРАВИЛО, откуда бы оно ни пришло: из блока logic или из старого
// поля-носителя. Обе стороны сводятся сюда до обхода, поэтому сам обход про блоки
// логики не знает.
type logicRule struct {
	when *Condition
	// at — позиция НОСИТЕЛЯ: источники условия обязаны стоять выше неё.
	at int
	// guard — позиция, НИЖЕ которой обязана стоять цель. −1 у правил из старых полей:
	// они лежат на самой цели, и требовать «цель ниже носителя» значило бы обездвижить
	// их все.
	guard int
}

type jumpEntry struct {
	owner string
	rule  logicRule
	to    string
	end   bool
}

// compiled — правила документа, разложенные по адресатам. Карты те же, которыми обход
// пользовался и раньше; изменилось только то, откуда они заполняются.
type compiled struct {
	shows        map[string][]logicRule
	hides        map[string][]logicRule
	requires     map[string][]logicRule
	optionShows  map[string]map[string][]logicRule
	optionHides  map[string]map[string][]logicRule
	jumps        []jumpEntry
	submitBlocks []struct {
		owner string
		rule  logicRule
	}
}

func compileLogic(blocks []Block) compiled {
	c := compiled{
		shows:       map[string][]logicRule{},
		hides:       map[string][]logicRule{},
		requires:    map[string][]logicRule{},
		optionShows: map[string]map[string][]logicRule{},
		optionHides: map[string]map[string][]logicRule{},
	}
	pushOptions := func(m map[string]map[string][]logicRule, blockID string, ids []string, r logicRule) {
		byOption, ok := m[blockID]
		if !ok {
			byOption = map[string][]logicRule{}
			m[blockID] = byOption
		}
		for _, id := range ids {
			byOption[id] = append(byOption[id], r)
		}
	}

	for i := range blocks {
		b := blocks[i]
		if b.Type != BlockLogic || b.Logic == nil {
			continue
		}
		// У блока одно условие на все свои действия, и позиция блока служит обеим
		// границам сразу: источники выше неё, цели ниже.
		r := logicRule{when: b.Logic.When, at: i, guard: i}
		for _, a := range b.Logic.Then {
			switch a.Kind {
			case ActShow:
				c.shows[a.Target] = append(c.shows[a.Target], r)
			case ActHide:
				c.hides[a.Target] = append(c.hides[a.Target], r)
			case ActRequire:
				c.requires[a.Target] = append(c.requires[a.Target], r)
			case ActShowOptions:
				pushOptions(c.optionShows, a.Target, a.Options, r)
			case ActHideOptions:
				pushOptions(c.optionHides, a.Target, a.Options, r)
			case ActJump:
				c.jumps = append(c.jumps, jumpEntry{owner: b.ID, rule: r, to: a.To, end: a.End})
			case ActBlockSubmit:
				c.submitBlocks = append(c.submitBlocks, struct {
					owner string
					rule  logicRule
				}{owner: b.ID, rule: r})
			}
		}
	}
	return c
}

// OptionVisible — показан ли вариант. Отдельный метод, потому что «карты нет» и «вариант
// скрыт» — разные вещи, и путать их нельзя: без карты видны ВСЕ варианты.
func (p Plan) OptionVisible(blockID, optionID string) bool {
	opts, ok := p.Options[blockID]
	if !ok {
		return true
	}
	return opts[optionID]
}

// page — страница документа и разрыв, её закрывающий (nil у последней).
type page struct {
	blocks []Block
	closer *Block
}

// splitPages режет документ на страницы разрывами. Зеркалит splitPages в
// @fields/groups: разрыв — граница, а не элемент; пустые страницы не появляются
// (разрыв первым блоком, два подряд — законные промежуточные состояния набора, и
// валидатор их не запрещает); страница на выходе всегда хотя бы одна.
//
// Отличие от фронта одно, и оно нужно переходам: здесь запоминается ЗАКРЫВАЮЩИЙ разрыв
// каждой страницы — на нём живут правила «куда уходим». До фазы 21 Go про страницы не
// знал вовсе (ответ приходит одним запросом), но обход страниц обязан считаться и на
// сервере: он решает, какие ответы вообще попадут в базу.
func splitPages(blocks []Block) []page {
	var pages []page
	var cur []Block
	for i := range blocks {
		if blocks[i].Type != BlockPageBreak {
			cur = append(cur, blocks[i])
			continue
		}
		if len(cur) == 0 {
			continue // инертный разрыв: страницы не открывает и не закрывает
		}
		pages = append(pages, page{blocks: cur, closer: &blocks[i]})
		cur = nil
	}
	if len(cur) > 0 {
		pages = append(pages, page{blocks: cur})
	}
	if len(pages) == 0 {
		pages = append(pages, page{})
	}
	return pages
}

// groupRuns — участки блоков одной группы внутри страницы, в порядке потока. Группа
// смежна по инварианту схемы (validateGroups), поэтому достаточно сравнения с
// предыдущим groupId.
//
// Участки считаются ВНУТРИ страницы: группа, разорванная разрывом страницы (документ
// такой законен, хотя редактор его не создаёт), даёт на каждой странице свой участок со
// своей головой — правило видимости читается с головы участка.
func groupRuns(blocks []Block) [][2]int {
	var runs [][2]int
	for i := range blocks {
		if i > 0 && blocks[i].GroupID == blocks[i-1].GroupID {
			runs[len(runs)-1][1] = i + 1
			continue
		}
		runs = append(runs, [2]int{i, i + 1})
	}
	return runs
}

// answerValue — ответ в виде, пригодном для сравнения: строка у всех типов, кроме
// множественного выбора (массив id). Скрытые варианты из него уже вычищены.
type answerValue struct {
	text string
	list []string
}

func (v answerValue) empty() bool { return v.text == "" && len(v.list) == 0 }

// evaluator — состояние обхода: позиции блоков в документе, сами блоки и ответы уже
// пройденных отвечаемых блоков (у скрытых — пустые).
type evaluator struct {
	pos     map[string]int
	byID    map[string]Block
	decided map[string]answerValue
	c       compiled
}

// fires — сработало ли ОДНО правило. Инертное (нет условия, источник ниже носителя,
// оператор не подходит типу, значение не выбрано) не срабатывает никогда.
func (ev *evaluator) fires(r logicRule) bool {
	if r.when == nil {
		return false
	}
	res, ok := ev.node(*r.when, r.at)
	return ok && res
}

// collect — правила, адресованные ЦЕЛИ на позиции target: сколько из них действуют и
// сработало ли хоть одно. Действующим не считается правило, чья цель стоит выше
// носителя, — блок читает то, что над ним, и влияет на то, что под ним.
func (ev *evaluator) collect(rules []logicRule, target int) (active, fired bool) {
	for _, r := range rules {
		if r.guard >= target || r.when == nil {
			continue
		}
		res, ok := ev.node(*r.when, r.at)
		if !ok {
			continue
		}
		active = true
		if res {
			fired = true
		}
	}
	return active, fired
}

func (ev *evaluator) node(c Condition, carrier int) (result, ok bool) {
	children, and := c.All, true
	if len(c.Any) > 0 {
		children, and = c.Any, false
	}
	if len(children) == 0 {
		return ev.leaf(c, carrier)
	}

	// Дети считаются ВСЕ, без раннего выхода: инертный ребёнок делает инертным ПРАВИЛО
	// ЦЕЛИКОМ, а с ранним выходом результат зависел бы от порядка условий в группе.
	// Правило либо действует целиком, либо не действует вовсе — половинчатое условие
	// («источник одного из трёх сравнений удалён, считаем по двум») хуже отсутствующего:
	// оно показывает вопрос тем, кому автор его не адресовал.
	out := and
	for _, ch := range children {
		res, ok := ev.node(ch, carrier)
		if !ok {
			return false, false
		}
		if and {
			out = out && res
		} else {
			out = out || res
		}
	}
	return out, true
}

// leaf — сравнение одного ответа. Здесь и живут все четыре причины инертности.
func (ev *evaluator) leaf(c Condition, carrier int) (result, ok bool) {
	src, exists := ev.byID[c.BlockID]
	if !exists {
		return false, false // источника нет в документе
	}
	if ev.pos[c.BlockID] >= carrier {
		return false, false // источник не решён к этому месту обхода
	}
	if !c.Op.appliesTo(src.Type) {
		return false, false // оператор не подходит типу источника
	}
	if c.Op.needsValue() && c.Value == "" {
		return false, false // автор ещё не выбрал значение
	}
	val := ev.decided[c.BlockID]

	switch c.Op {
	case OpAnswered:
		return !val.empty(), true
	case OpEmpty:
		return val.empty(), true
	case OpIs:
		return sameAnswer(src.Type, val.text, c.Value), true
	case OpIsNot:
		// Строгое отрицание: у неотвеченного источника «не равно» истинно. Так «не
		// равно» остаётся композируемым (нужна пара «отвечено И не равно» — автор
		// складывает её группой), а не молча означает две разные вещи.
		return !sameAnswer(src.Type, val.text, c.Value), true
	case OpIncludes:
		return slices.Contains(val.list, c.Value), true
	case OpExcludes:
		return !slices.Contains(val.list, c.Value), true
	case OpGt, OpLt:
		a, errA := strconv.ParseFloat(val.text, 64)
		b, errB := strconv.ParseFloat(c.Value, 64)
		if errA != nil || errB != nil {
			return false, true // нечисловой ответ не больше и не меньше — но правило действует
		}
		if c.Op == OpGt {
			return a > b, true
		}
		return a < b, true
	default:
		return false, false
	}
}

// sameAnswer — равенство ответа значению. У шкалы и number сравнение ЧИСЛОВОЕ: «5» и
// «5.0» — один ответ, а строковое сравнение сделало бы условие зависящим от того, как
// респондент напечатал число.
func sameAnswer(t BlockType, answer, want string) bool {
	if t == BlockScale || t == BlockNumber {
		a, errA := strconv.ParseFloat(answer, 64)
		b, errB := strconv.ParseFloat(want, 64)
		if errA == nil && errB == nil {
			return a == b
		}
	}
	return answer == want
}

// PlanForm считает план формы при данных ответах — ОДНИМ проходом по документу.
//
// Зеркалит planForm в @fields/logic.ts. Чистая функция: ни HTTP, ни SQL, ни времени.
//
// Порядок обхода — порядок документа, и это не деталь реализации, а то, на чём стоит
// вся семантика: условие смотрит только НАЗАД, переходы ведут только ВПЕРЁД, поэтому
// обход монотонен, завершается по построению и не требует ни фикспойнта, ни детектора
// циклов. Пропущенные переходом страницы обходятся вместе с остальными (их блоки
// невидимы, ответы пусты) — иначе условие, ссылающееся на вопрос пропущенной страницы,
// зависело бы от того, посетили её или нет.
func PlanForm(blocks []Block, answers map[string]json.RawMessage) Plan {
	pages := splitPages(blocks)
	ev := &evaluator{
		pos:     make(map[string]int, len(blocks)),
		byID:    make(map[string]Block, len(blocks)),
		decided: make(map[string]answerValue, len(blocks)),
		c:       compileLogic(blocks),
	}
	for i := range blocks {
		ev.pos[blocks[i].ID] = i
		ev.byID[blocks[i].ID] = blocks[i]
	}

	// Куда ведёт каждый разрыв: страница, идущая СРАЗУ ЗА той, которую он закрывает.
	// Разрыв, за которым страницы нет (последний в документе) или инертный, цели не
	// имеет — переход на него не действует.
	opens := make(map[string]int, len(pages))
	for i := range pages {
		if pages[i].closer != nil && i+1 < len(pages) {
			opens[pages[i].closer.ID] = i + 1
		}
	}

	plan := Plan{
		Visible:  make(map[string]bool, len(blocks)),
		Required: make(map[string]bool),
		Options:  make(map[string]map[string]bool),
	}

	next := 0
	for i := range pages {
		visited := i == next
		var shown []Block

		for _, run := range groupRuns(pages[i].blocks) {
			head := pages[i].blocks[run[0]]
			show := visited && ev.shows(head.ID, ev.pos[head.ID])

			for _, b := range pages[i].blocks[run[0]:run[1]] {
				// Блок логики не показывается никому и ни на одной поверхности:
				// страница, где кроме него ничего нет, — не страница (её переходы
				// при этом считаются).
				if show && b.Type != BlockLogic {
					plan.Visible[b.ID] = true
					shown = append(shown, b)
				}
				if !b.Type.isAnswerable() {
					continue
				}
				// Ответ отвечаемого блока фиксируется ВСЕГДА — у скрытого пустым.
				// Условия следующих вопросов смотрят сюда, и «пусто» у скрытого это
				// ровно то, чего ждёт автор.
				if !show {
					ev.decided[b.ID] = answerValue{}
					continue
				}
				at := ev.pos[b.ID]
				opts := ev.visibleOptions(b, at)
				if opts != nil {
					plan.Options[b.ID] = opts
				}
				ev.decided[b.ID] = decodeAnswer(b, answers[b.ID], opts)
				if _, fired := ev.collect(ev.c.requires[b.ID], at); b.Required || fired {
					plan.Required[b.ID] = true
				}
			}
		}

		if !visited {
			continue
		}
		// Страница, на которой не осталось ни одного видимого блока, ПОСЕЩАЕТСЯ (её
		// переходы считаются, ответы её вопросов пусты), но респонденту не
		// показывается: пустой шаг с одной кнопкой «Далее» — это не страница.
		if len(shown) > 0 {
			plan.Pages = append(plan.Pages, shown)
		}

		here := make(map[string]bool, len(pages[i].blocks)+1)
		for _, b := range pages[i].blocks {
			here[b.ID] = true
		}
		if closer := pages[i].closer; closer != nil {
			here[closer.ID] = true
		}
		// «Скрыть кнопку» обрывает обход ЗДЕСЬ: страница показана, кнопки нет, идти
		// некуда. Проверяется до переходов — уйти со страницы, которую нельзя
		// закрыть, нельзя.
		if ev.submitBlocked(here) {
			plan.Blocked = true
			continue // next не двигается, значит остальные страницы не посещаются
		}
		next = ev.nextPage(here, i, len(pages), opens)
	}
	// Страница на выходе всегда хотя бы одна — как у splitPages: пустой документ и
	// форма, где скрыто вообще всё, дают один пустой шаг с кнопкой отправки, а не
	// «страниц нет», на котором потребителю пришлось бы заводить спецслучай.
	if len(plan.Pages) == 0 {
		plan.Pages = [][]Block{{}}
	}
	return plan
}

// shows — видна ли цель. Две корзины, и формула не зависит от порядка блоков logic
// между собой: «показать» переворачивает умолчание цели в «скрыт», «скрыть» прячет
// видимое по условию (ADR §10). Ни одного действующего правила — виден, как и было.
func (ev *evaluator) shows(id string, target int) bool {
	hasShow, showFired := ev.collect(ev.c.shows[id], target)
	_, hideFired := ev.collect(ev.c.hides[id], target)
	return (!hasShow || showFired) && !hideFired
}

// visibleOptions — видимость вариантов блока; nil, если блока не касается ни одно
// правило (значит видны все, и карту заводить незачем). Формула у варианта та же, что
// у блока.
func (ev *evaluator) visibleOptions(b Block, at int) map[string]bool {
	shows, hasShows := ev.c.optionShows[b.ID]
	hides, hasHides := ev.c.optionHides[b.ID]
	if !hasShows && !hasHides {
		return nil
	}
	out := make(map[string]bool, len(b.Settings.Options))
	for _, o := range b.Settings.Options {
		hasShow, showFired := ev.collect(shows[o.ID], at)
		_, hideFired := ev.collect(hides[o.ID], at)
		out[o.ID] = (!hasShow || showFired) && !hideFired
	}
	return out
}

// submitBlocked — есть ли на этой странице сработавшее «скрыть кнопку».
func (ev *evaluator) submitBlocked(here map[string]bool) bool {
	for _, s := range ev.c.submitBlocks {
		if here[s.owner] && ev.fires(s.rule) {
			return true
		}
	}
	return false
}

// nextPage — куда уходим со страницы i. Первое сработавшее правило В ПОРЯДКЕ ДОКУМЕНТА
// (переходы собраны обходом блоков, поэтому порядок среза уже верен); переход назад, в
// никуда и с несработавшим условием пропускается (инертен).
func (ev *evaluator) nextPage(here map[string]bool, i, total int, opens map[string]int) int {
	for _, j := range ev.c.jumps {
		if !here[j.owner] || !ev.fires(j.rule) {
			continue
		}
		if j.end {
			return total // страниц дальше нет: здесь кнопка «Отправить»
		}
		target, exists := opens[j.to]
		if !exists || target <= i {
			continue // цель раньше носителя или её нет — правило не действует
		}
		return target
	}
	return i + 1
}

// decodeAnswer разбирает сырой ответ в сравнимый вид и вычищает скрытые варианты:
// выбранный скрытый вариант — это НЕ выбор, иначе условие «выбрал X» срабатывало бы от
// значения, которого респондент не видел.
func decodeAnswer(b Block, raw json.RawMessage, opts map[string]bool) answerValue {
	if len(raw) == 0 {
		return answerValue{}
	}
	if b.Type.isMultiChoice() {
		var ids []string
		if err := json.Unmarshal(raw, &ids); err != nil {
			return answerValue{} // битое значение отвергнет ValidateAnswers
		}
		out := make([]string, 0, len(ids))
		for _, id := range ids {
			if opts != nil && !opts[id] {
				continue
			}
			out = append(out, id)
		}
		return answerValue{list: out}
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return answerValue{}
	}
	if b.Type.isSingleChoice() && v != "" && opts != nil && !opts[v] {
		return answerValue{}
	}
	return answerValue{text: v}
}

// StripHiddenAnswers убирает из ответов всё, чего респондент не видел: ответы на
// скрытые вопросы и id скрытых вариантов. Возвращает НОВУЮ карту, вход не меняет.
//
// Молча, а не ошибкой: у респондента законно остаётся в стейте ответ, данный до того,
// как он переключил вопрос-источник, и наказывать его за поведение формы нечем (ADR
// §10). Ответы на блоки, которых в схеме нет, и на неотвечаемые типы остаются
// НЕТРОНУТЫМИ — это нарушение контракта, и ловить его обязан ValidateAnswers, а не
// нормализация, которая иначе прятала бы расхождение вкладки со схемой.
//
// Инвариант, на котором стоят сводка и выгрузка: PlanForm(blocks,
// StripHiddenAnswers(blocks, a)) == PlanForm(blocks, a) — пересчёт видимости по
// сохранённому ответу воспроизводит то, что видел респондент. Держится тем, что
// вычищенное считалось пустым уже при первом счёте.
func StripHiddenAnswers(blocks []Block, answers map[string]json.RawMessage) map[string]json.RawMessage {
	plan := PlanForm(blocks, answers)
	byID := make(map[string]Block, len(blocks))
	for i := range blocks {
		byID[blocks[i].ID] = blocks[i]
	}

	out := make(map[string]json.RawMessage, len(answers))
	for id, raw := range answers {
		b, known := byID[id]
		if !known || !b.Type.isAnswerable() {
			out[id] = raw
			continue
		}
		if !plan.Visible[id] {
			continue
		}
		opts := plan.Options[id]
		if opts == nil {
			out[id] = raw
			continue
		}
		cleaned, keep := stripHiddenOptions(b, raw, opts)
		if keep {
			out[id] = cleaned
		}
	}
	return out
}

// stripHiddenOptions вычищает скрытые варианты из одного ответа. Второе значение —
// оставлять ли ключ вовсе (у одиночного выбора скрытого варианта не остаётся ничего).
// Битое значение возвращается как есть: его дело — ValidateAnswers.
func stripHiddenOptions(b Block, raw json.RawMessage, opts map[string]bool) (json.RawMessage, bool) {
	if b.Type.isMultiChoice() {
		var ids []string
		if err := json.Unmarshal(raw, &ids); err != nil {
			return raw, true
		}
		kept := make([]string, 0, len(ids))
		for _, id := range ids {
			if opts[id] {
				kept = append(kept, id)
			}
		}
		if len(kept) == len(ids) {
			return raw, true
		}
		encoded, err := json.Marshal(kept)
		if err != nil {
			return raw, true
		}
		return encoded, true
	}

	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw, true
	}
	if v != "" && !opts[v] {
		return nil, false
	}
	return raw, true
}
