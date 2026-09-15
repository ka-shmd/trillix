package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// План формы — промежуточный формат между моделью и схемой (ADR §10, фаза 26).
// Модель отдаёт плоский список пунктов, документ собирает ExpandPlan: ни групп, ни
// спанов, ни blk_* модель не видит.
//
// Родня на фронте — buildTemplateSchema (features/forms/templates/templates.ts):
// там та же сборка «пункт → блоки» для встроенных шаблонов, и правило раскладки у
// них общее. Расходиться нельзя: обе стороны строят один и тот же документ.

// PlanKind — что модель знает о типе блока. Ровно две строки, и обе такие, которые
// нельзя вывести из кода: как тип называется и когда его брать. Всё остальное
// (нужны ли варианты, нужна ли отдельная подпись, границы шкалы) выводится
// предикатами типа — иначе реестр стал бы вторым источником истины о типах.
type PlanKind struct {
	Title string
	Hint  string
}

// planKinds — ЕДИНСТВЕННОЕ место, которое растёт от новых типов вопросов. Список
// самих типов не дублируется: он берётся из blockTypes, а этот реестр лишь
// объясняет модели те из них, которые ей позволено предлагать.
//
// Тип без записи здесь модель просто не увидит — форма выйдет беднее, но валидной.
// Забыть тип нельзя молча: TestPlanKindsCoverAnswerable требует записи (или явного
// исключения с причиной) у каждого отвечаемого типа — это замена фронтовому «не
// компилируется» у исчерпывающих Record<BlockType, …>.
var planKinds = map[BlockType]PlanKind{
	BlockShortText:    {Title: "Короткий ответ", Hint: "имя, город, должность — строка в одну строку"},
	BlockLongText:     {Title: "Длинный ответ", Hint: "развёрнутый текст: пожелания, описание задачи"},
	BlockEmail:        {Title: "Email", Hint: "адрес почты; проверяется формой"},
	BlockPhone:        {Title: "Телефон", Hint: "номер телефона; проверяется формой"},
	BlockNumber:       {Title: "Число", Hint: "возраст, количество, сумма"},
	BlockScale:        {Title: "Шкала", Hint: "оценка рядом кнопок: удовлетворённость, NPS. Границы — scaleMin и scaleMax"},
	BlockRating:       {Title: "Рейтинг", Hint: "оценка звёздами: как понравилось, как оцениваете мастера. Пять звёзд"},
	BlockSingleChoice: {Title: "Один из списка", Hint: "до пяти-шести вариантов на виду; варианты обязательны"},
	BlockDropdown:     {Title: "Выпадающий список", Hint: "то же, что «один из списка», но вариантов много (город, услуга)"},
	BlockMultiChoice:  {Title: "Несколько из списка", Hint: "можно выбрать больше одного варианта"},
	BlockDate:         {Title: "Дата", Hint: "дата визита, рождения, мероприятия"},
	BlockConsent:      {Title: "Согласие", Hint: "галочка с текстом согласия; текст согласия кладётся в text"},
	BlockFile:         {Title: "Файл", Hint: "респондент прикладывает документ или фото"},
	// Запись на время. Модель ставит САМ ВОПРОС, но расписание не выбирает — оно
	// живёт в пространстве, его заводит человек, а форма ссылается на него живой
	// колонкой. Недонастроенную форму держит гейт публикации, а не молчание модели
	// (решение владельца 2026-09-03).
	BlockSlot:      {Title: "Онлайн-запись", Hint: "выбор свободного времени приёма по расписанию автора: запись к мастеру, врачу, на занятие. Ставится не больше одного на форму"},
	BlockText:      {Title: "Пояснение", Hint: "абзац текста без вопроса: что за форма, как её заполнять"},
	BlockHeading:   {Title: "Раздел", Hint: "заголовок группы вопросов; ответа не собирает"},
	BlockPageBreak: {Title: "Разрыв страницы", Hint: "делит длинную анкету на шаги; text не нужен"},
}

// planExcluded — отвечаемые типы, которые модель НЕ предлагает, и почему. Пусто —
// сегодня генерируются все. Существует ради теста покрытия: у нового типа выбор
// «описать модели» или «записать причину отказа», и молчаливого третьего нет.
var planExcluded = map[BlockType]string{}

// planTypeOrder — порядок перечисления типов в инструкции и в схеме ответа.
// Фиксированный, а не по карте: перебор map в Go случаен, и промпт менялся бы от
// запуска к запуску, ломая кэш подсказки у провайдера и воспроизводимость тестов.
var planTypeOrder = []BlockType{
	BlockShortText, BlockLongText, BlockEmail, BlockPhone, BlockNumber,
	BlockScale, BlockRating, BlockSingleChoice, BlockDropdown, BlockMultiChoice, BlockDate,
	BlockConsent, BlockFile, BlockSlot, BlockText, BlockHeading, BlockPageBreak,
}

// PlaceholderTypes — типы, у которых подсказка внутри поля видна. Считается из
// предиката, а не перечисляется руками: список в инструкции модели, список в отказе и
// правило применения обязаны быть одним и тем же знанием.
func PlaceholderTypes() []string {
	out := make([]string, 0, 5)
	for _, t := range planTypeOrder {
		if t.showsPlaceholder() {
			out = append(out, string(t))
		}
	}
	return out
}

// FormPlan — то, что вернула модель.
type FormPlan struct {
	Title string     `json:"title"`
	Items []PlanItem `json:"items"`
}

// PlanItem — один пункт плана: вопрос, пояснение, раздел или разрыв страницы.
//
// Плоская структура на все виды, а не сумма типов: сумму (oneOf) модель держит
// заметно хуже одного объекта с перечислением в поле type, а разбирать её нам всё
// равно поштучно.
type PlanItem struct {
	Type BlockType `json:"type"`
	// Text — подпись вопроса; у пояснения и раздела это сам текст; у согласия —
	// текст рядом с галочкой; у разрыва страницы не значит ничего.
	Text     string   `json:"text"`
	Required bool     `json:"required"`
	Options  []string `json:"options"`
	// ScaleMin/ScaleMax — границы шкалы. Оба нуля = «не задано» (возьмутся
	// DefaultScaleMin/DefaultScaleMax): шкалы 0..0 не бывает, а NPS 0..10 отличим
	// по верхней границе. Указатели тут не нужны — в отличие от схемы, где ноль
	// законное значение обеих границ.
	ScaleMin int `json:"scaleMin"`
	ScaleMax int `json:"scaleMax"`
	// Bold, Color, BG — оформление ПОДПИСИ целиком: жирная, цвет текста, цвет фона
	// (последние два — #rrggbb, пусто = обычный).
	//
	// Целиком, а не по кускам: богатый текст в схеме — массив спанов со своими
	// марками, и отдавать модели спаны значило бы просить её размечать текст
	// посимвольно там, где просят «сделай заголовки жирными». Кусочная разметка
	// остаётся за полотном, где её видно.
	Bold  bool   `json:"bold"`
	Color string `json:"color"`
	BG    string `json:"bg"`
	// Placeholder — подсказка ВНУТРИ поля («+7 900 000-00-00»). Есть не у всех типов:
	// у даты её гасит сам контрол, у выбора и файла показывать её негде
	// (`showsPlaceholder`).
	//
	// ПУСТАЯ СТРОКА — «НЕ ТРОГАТЬ», а не «стереть». Схема ответа требует поле в каждом
	// пункте, поэтому при любой правке (сделать заголовок жирным) модель пришлёт его
	// пустым, если не думала о подсказке, — и «пусто значит стереть» вычищало бы
	// авторские подсказки на каждой такой правке. Убрать подсказку можно в попапе
	// блока, где она набрана.
	Placeholder string `json:"placeholder"`
}

// withCreatedBold — жирность, с которой заголовок ПРИХОДИТ ОТ АССИСТЕНТА (решение
// владельца 2026-09-02): на полотне заголовки создаются жирными, и форма, собранная
// разговором, обязана выглядеть так же — иначе автор решит, что одна из двух сломана.
//
// Вес в этом продукте живёт МАРКОЙ на тексте, а не в CSS (`--rf-weight-bold` у
// .rf-title и .rf-label), поэтому «по умолчанию жирный» — это марка, проставленная в
// момент создания, а не правило вида. Уже собранные формы от этого не меняются.
//
// Только при СОЗДАНИИ (ExpandPlan и add): у правки готового пункта жирность берётся
// из ответа модели, иначе «сделай заголовки обычными» стало бы нечем выразить.
//
// Заголовками считаются подпись вопроса и заголовок раздела. Текст согласия и
// пояснение — нет: они живут в самом блоке и заголовками не являются.
func withCreatedBold(item PlanItem) PlanItem {
	item.Bold = item.Bold ||
		(item.Type.isAnswerable() && !item.Type.carriesText()) ||
		item.Type.isHeading()
	return item
}

// styledText — подпись пункта в виде спанов: один кусок с марками, названными
// правкой. Пустой текст даёт пустой массив (одно представление пустоты).
func styledText(item PlanItem) []Span {
	spans := TextFromString(item.Text)
	if len(spans) == 0 {
		return nil
	}
	if item.Bold {
		spans[0].M = []Mark{MarkBold}
	}
	spans[0].Color = normalizeHex(item.Color)
	spans[0].BG = normalizeHex(item.BG)
	return spans
}

// restyledText — подпись ПОСЛЕ ПРАВКИ ПУНКТА, а не собранная заново.
//
// МИНА: styledText строит ОДИН кусок из плоской строки, и всё, чего в словаре модели
// нет, исчезает — ссылка, курсив, подстановка ответа («Здравствуйте, {Имя}»).
// Проекция отдаёт модели PlainText, поэтому на просьбу «сделай телефон обязательным»
// она возвращает тот же текст, а правка стирала разметку, которую автор ставил руками
// (ревью ветки 2026-09-02).
//
// Три случая. Текст и оформление те же — куски остаются как есть. Текст тот же,
// оформление названо другое — новое ложится на ВСЕ куски: автор просил перекрасить
// подпись целиком, и кусочная разметка цвета этой просьбе и уступает. Текст другой —
// собираем заново одним куском: воспроизвести чужую разметку под новым текстом нечем.
func restyledText(old []Span, item PlanItem) []Span {
	if len(old) == 0 || PlainText(old) != item.Text {
		return styledText(item)
	}
	bold, color, bg := styleOf(old)
	if bold == item.Bold && color == normalizeHex(item.Color) && bg == normalizeHex(item.BG) {
		return old
	}
	out := make([]Span, len(old))
	copy(out, old)
	for i := range out {
		marks := make([]Mark, 0, len(out[i].M)+1)
		for _, m := range out[i].M {
			if m != MarkBold {
				marks = append(marks, m)
			}
		}
		if item.Bold {
			marks = append(marks, MarkBold)
		}
		if len(marks) == 0 {
			marks = nil
		}
		out[i].M = marks
		out[i].Color = normalizeHex(item.Color)
		out[i].BG = normalizeHex(item.BG)
	}
	return out
}

// styleOf — обратный ход: марки первого куска подписи. Разметка, сделанная на
// полотне по кускам, схлопывается до «жирная/не жирная» — модель видит то, что
// умеет назвать, и не пытается пересобрать чужую разметку.
func styleOf(spans []Span) (bold bool, color, bg string) {
	if len(spans) == 0 {
		return false, "", ""
	}
	first := spans[0]
	return slices.Contains(first.M, MarkBold), first.Color, first.BG
}

// MaxPlanItems — потолок пунктов плана. Меньше MaxBlocks, потому что пункт
// разворачивается в один-два блока, а анкета на сотню вопросов — не та форма,
// которую собирают одной фразой.
const MaxPlanItems = 60

// PlanTypeDoc — строка реестра для промпта: тип, его имя и когда его брать.
type PlanTypeDoc struct {
	Type  BlockType
	Title string
	Hint  string
}

// PlanTypes — реестр в порядке перечисления. Отсюда потребитель собирает часть
// инструкции про типы: перечислять их в тексте промпта руками нельзя — тогда новый
// тип пришлось бы вспоминать в двух местах.
func PlanTypes() []PlanTypeDoc {
	out := make([]PlanTypeDoc, 0, len(planTypeOrder))
	for _, t := range planTypeOrder {
		k, ok := planKinds[t]
		if !ok {
			continue
		}
		out = append(out, PlanTypeDoc{Type: t, Title: k.Title, Hint: k.Hint})
	}
	return out
}

// planItemJSONSchema — один пункт в схеме ответа модели. Общий кусок: его берут и
// генерация формы с нуля, и правка в разговоре, и перечисление типов в обоих —
// одно и то же, из реестра.
func planItemJSONSchema() string {
	types := make([]string, 0, len(planTypeOrder))
	for _, d := range PlanTypes() {
		types = append(types, string(d.Type))
	}
	enum, _ := json.Marshal(types)
	return fmt.Sprintf(`{
        "type": "object",
        "properties": {
          "type": {"type": "string", "enum": %s},
          "text": {"type": "string"},
          "required": {"type": "boolean"},
          "options": {"type": "array", "items": {"type": "string"}},
          "scaleMin": {"type": "integer"},
          "scaleMax": {"type": "integer"},
          "bold": {"type": "boolean"},
          "color": {"type": "string"},
          "bg": {"type": "string"},
          "placeholder": {"type": "string"}
        },
        "required": ["type", "text", "required", "options", "scaleMin", "scaleMax", "bold", "color", "bg", "placeholder"],
        "additionalProperties": false
      }`, enum)
}

// PlanJSONSchema — схема ответа модели (json_schema у провайдера). Перечисление
// типов берётся из реестра, поэтому новый тип попадает в схему тогда же, когда в
// инструкцию, и разойтись им нечем.
func PlanJSONSchema() json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{
  "type": "object",
  "properties": {
    "title": {"type": "string"},
    "items": {
      "type": "array",
      "items": %s
    }
  },
  "required": ["title", "items"],
  "additionalProperties": false
}`, planItemJSONSchema()))
}

// ParsePlan строго разбирает ответ модели. Строго — то есть лишние поля отвергаются,
// как и в ValidateSchema: провайдер, дописавший ключ, ошибся, и молча съесть это
// значит однажды получить документ, о котором никто не просил.
func ParsePlan(raw json.RawMessage) (FormPlan, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()

	var p FormPlan
	if err := dec.Decode(&p); err != nil {
		return FormPlan{}, planErr("не удалось разобрать план: %v", err)
	}
	if dec.More() {
		return FormPlan{}, planErr("лишние данные после плана")
	}
	return p, nil
}

// ValidatePlan проверяет план ДО сборки документа. Ошибка называет номер пункта и
// суть: её текст уезжает обратно модели на второй попытке, и «неверный план» ей
// ничего не говорит.
//
// Проверяется то, что нельзя починить молча. Инертное (required у пояснения,
// варианты у даты) не ошибка: у флага, которому некуда примениться, тот же статус,
// что у бита колонки в схеме.
func ValidatePlan(p FormPlan) error {
	if utf8.RuneCountInString(p.Title) > MaxFormTitleLen {
		return planErr("заголовок формы длиннее %d символов", MaxFormTitleLen)
	}
	if len(p.Items) == 0 {
		return planErr("в плане нет ни одного пункта")
	}
	if len(p.Items) > MaxPlanItems {
		return planErr("больше %d пунктов", MaxPlanItems)
	}

	blocks := 1 // заголовок формы
	for i, item := range p.Items {
		if err := validatePlanItem(item); err != nil {
			return fmt.Errorf("пункт %d: %w", i+1, err)
		}
		blocks += planItemBlocks(item.Type)
	}
	if blocks > MaxBlocks {
		return planErr("план разворачивается в %d блоков при потолке %d", blocks, MaxBlocks)
	}
	return nil
}

// validatePlanItem — проверка ОДНОГО пункта: она нужна и плану целиком, и правке
// в разговоре, где пункт приходит поштучно. Номер пункта дописывает вызывающий:
// в плане это порядок, в правке — ключ, и общего у них ничего нет.
//
// У выбора варианты обязательны. Это строже валидатора черновика, который пустой
// choice допускает: там пустота — состояние автора, который ещё печатает, а здесь
// — вопрос, на который нельзя ответить, и починить его вторая попытка модели
// может, а человек за неё не должен.
func validatePlanItem(item PlanItem) error {
	if _, ok := planKinds[item.Type]; !ok {
		return planErr("тип %q не поддерживается; возьми один из: %s",
			item.Type, strings.Join(planTypeNames(), ", "))
	}
	if err := checkTextLen(item.Text, MaxTextLen); err != nil {
		return err
	}
	if item.Type != BlockPageBreak && strings.TrimSpace(item.Text) == "" {
		return planErr("пустой текст у пункта %s", item.Type)
	}
	if item.Type.isChoice() {
		if len(item.Options) == 0 {
			return planErr("нет вариантов ответа у пункта %s", item.Type)
		}
		if len(item.Options) > MaxOptions {
			return planErr("больше %d вариантов", MaxOptions)
		}
		for _, o := range item.Options {
			if strings.TrimSpace(o) == "" {
				return planErr("пустой вариант ответа")
			}
			if utf8.RuneCountInString(o) > MaxOptionLabelLen {
				return planErr("вариант длиннее %d символов", MaxOptionLabelLen)
			}
		}
	}
	for _, c := range []struct{ name, value string }{{"color", item.Color}, {"bg", item.BG}} {
		if c.value != "" && !isHexColor(normalizeHex(c.value)) {
			return planErr("%s: %q — нужен цвет вида #rrggbb", c.name, c.value)
		}
	}
	if item.Placeholder != "" {
		if !item.Type.showsPlaceholder() {
			return planErr("подсказка внутри поля не показывается у типа %s; она бывает у %s",
				item.Type, strings.Join(PlaceholderTypes(), ", "))
		}
		if utf8.RuneCountInString(item.Placeholder) > MaxPlaceholderLen {
			return planErr("подсказка длиннее %d символов", MaxPlaceholderLen)
		}
	}
	if item.Type == BlockScale && (item.ScaleMin != 0 || item.ScaleMax != 0) {
		// Границы либо обе не заданы (тогда дефолт), либо осмысленны. Правило то
		// же, что в схеме: половина диапазона — ошибка.
		if item.ScaleMin < ScaleLowerBound || item.ScaleMax > ScaleUpperBound {
			return planErr("шкала вне диапазона %d..%d", ScaleLowerBound, ScaleUpperBound)
		}
		if item.ScaleMin >= item.ScaleMax {
			return planErr("начало шкалы (%d) не меньше конца (%d)", item.ScaleMin, item.ScaleMax)
		}
	}
	return nil
}

// checkTextLen — общий потолок текста: пункт плана, подпись правки и заголовок
// формы меряются одинаково (в рунах), а числа у них разные.
func checkTextLen(text string, max int) error {
	if utf8.RuneCountInString(text) > max {
		return planErr("текст длиннее %d символов", max)
	}
	return nil
}

// planItemBlocks — во сколько блоков развернётся пункт. Два у вопроса с отдельной
// подписью, один у всего остального (согласие несёт свой текст само, пояснение и
// раздел — это и есть текст, разрыв текста не несёт).
func planItemBlocks(t BlockType) int {
	if t.isAnswerable() && !t.carriesText() {
		return 2
	}
	return 1
}

func planTypeNames() []string {
	out := make([]string, 0, len(planTypeOrder))
	for _, t := range planTypeOrder {
		if _, ok := planKinds[t]; ok {
			out = append(out, string(t))
		}
	}
	return out
}

// ExpandPlan разворачивает план в документ схемы. Id генерируются на КАЖДЫЙ вызов:
// две формы, собранные по одной просьбе, не должны делить blk_* — иначе ответы,
// воронка и логика двух разных форм ссылались бы на одни и те же строки.
//
// groupId выводится ровно так же, как его выводит редактор (regroup в
// builder/store.ts): «g_» + id якоря группы, где якорь — отвечаемый блок, а у
// одиночек они сами. Совпадение не косметика: иначе первое же открытие формы в
// редакторе переписало бы все groupId, и автосохранение ушло бы с диффом, которого
// автор не делал.
func ExpandPlan(p FormPlan) (FormSchema, error) {
	if err := ValidatePlan(p); err != nil {
		return FormSchema{}, err
	}

	// Заголовок формы тоже приходит жирным (см. withCreatedBold): здесь он именно
	// создаётся, а не правится.
	titleID := newBlockID()
	blocks := []Block{{
		ID:      titleID,
		GroupID: groupIDOf(titleID),
		Type:    BlockFormTitle,
		Text:    styledText(PlanItem{Text: p.Title, Bold: true}),
	}}

	for _, item := range p.Items {
		blocks = append(blocks, expandPlanItem(item)...)
	}
	return FormSchema{SchemaVersion: SchemaVersion, Blocks: blocks}, nil
}

func expandPlanItem(item PlanItem) []Block {
	// Пояснение, раздел, согласие и разрыв — один блок: текст (или его отсутствие)
	// живёт в самом блоке.
	if !item.Type.isAnswerable() || item.Type.carriesText() {
		id := newBlockID()
		b := Block{ID: id, GroupID: groupIDOf(id), Type: item.Type}
		if item.Type != BlockPageBreak {
			b.Text = styledText(withCreatedBold(item))
		}
		if item.Type.isAnswerable() {
			b.Required = item.Required
		}
		return []Block{b}
	}

	// Вопрос: подпись отдельным блоком плюс поле. Якорь группы — поле, поэтому его
	// id нужен раньше, чем блоки складываются в список.
	fieldID := newBlockID()
	group := groupIDOf(fieldID)
	field := Block{ID: fieldID, GroupID: group, Type: item.Type, Required: item.Required}
	field.Settings.Placeholder = item.Placeholder
	if item.Type.isChoice() {
		field.Settings.Options = make([]Option, 0, len(item.Options))
		for _, label := range item.Options {
			field.Settings.Options = append(field.Settings.Options, Option{ID: newOptionID(), Label: label})
		}
	}
	if item.Type == BlockScale {
		lo, hi := item.ScaleMin, item.ScaleMax
		if lo == 0 && hi == 0 {
			lo, hi = DefaultScaleMin, DefaultScaleMax
		}
		field.Settings.ScaleMin, field.Settings.ScaleMax = &lo, &hi
	}

	caption := Block{ID: newBlockID(), GroupID: group, Type: BlockTitle, Text: styledText(withCreatedBold(item))}
	return []Block{caption, field}
}

// Префиксы те же, что генерирует фронт (store.ts, templates.ts): id блока и опции
// приходят оттуда в 99% случаев, и разнобой мешал бы читать документ глазами.
func newBlockID() string  { return "blk_" + NewID().String() }
func newOptionID() string { return "opt_" + NewID().String() }

// groupIDOf зеркалит regroup в builder/store.ts — там groupId это «g_» + id якоря.
func groupIDOf(anchorID string) string { return "g_" + anchorID }

func planErr(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrValidation}, args...)...)
}

// planAllowedTypes — типы, которые модель вправе предлагать. Нужен тестам и
// проверке покрытия; порядок — реестровый.
func planAllowedTypes() []BlockType {
	return slices.Clone(planTypeOrder)
}
