package domain

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// Форма в разговоре и правка операциями (фаза 26, ADR §10).
//
// Модель видит форму ПЛАНОМ (тем же словарём, которым отвечает), а правит её
// ОПЕРАЦИЯМИ, а не переписыванием документа целиком. Причина не в размере ответа:
// переписывание теряет всё, чего в плане нет, — плейсхолдеры, настройки файла,
// имена страниц, условную логику, картинки, оформление. Операция трогает ровно
// названный пункт, поэтому нетронутое остаётся нетронутым по построению, а id
// блоков — ключ ответов, сводки и воронки — переживают правку сами собой.

// MaxChatOps — потолок операций в одном ответе модели. Правка в разговоре мелкая
// («добавь вопрос», «убери два»); сотня операций разом означает, что модель решила
// пересобрать форму, а этого мы как раз и избегаем.
const MaxChatOps = 40

// ChatItem — пункт формы глазами модели: тот же план плюс КЛЮЧ, которым на пункт
// ссылаются операции.
//
// Ключ — «q1», «q2», … по порядку показа, а не `blk_*`. Так короче (контекст платный),
// так модель не может выдумать правдоподобный id чужого блока, и так проекция
// остаётся детерминированной: сервер строит её из той же схемы и получает те же
// ключи, поэтому передавать таблицу соответствия через клиента не нужно.
type ChatItem struct {
	Key string `json:"key,omitempty"`
	PlanItem
}

// ChatForm — вся форма в контексте разговора.
type ChatForm struct {
	Title string     `json:"title"`
	Items []ChatItem `json:"items"`
}

// ChatOp — одна правка формы.
type ChatOp struct {
	// Op — что делаем: add | update | remove | move | title.
	Op string `json:"op"`
	// Target — ключ пункта, к которому относится операция (update, remove, move).
	Target string `json:"target,omitempty"`
	// After — ключ пункта, ПОСЛЕ которого встать (add, move). Пусто — в начало формы.
	After string `json:"after,omitempty"`
	// Item — содержимое пункта (add, update) либо новый заголовок формы (title).
	Item *ChatItem `json:"item,omitempty"`
}

// Виды операций. Закрытый список: неизвестная операция — отказ с перечислением
// допустимых, и он уезжает модели на починку.
const (
	OpAdd    = "add"
	OpUpdate = "update"
	OpRemove = "remove"
	OpMove   = "move"
	OpTitle  = "title"
)

var chatOps = []string{OpAdd, OpUpdate, OpRemove, OpMove, OpTitle}

// unit — пункт формы вместе с его блоками. Единица перестановки: блоки одного
// вопроса ходят вместе, иначе подпись отрывается от поля.
type unit struct {
	key    string
	item   ChatItem
	blocks []Block
}

// ProjectForm — форма в том виде, в каком её видит модель.
//
// Показывается и то, чего модель создавать не умеет (картинка, условие): она вправе
// такой пункт подвинуть или убрать по просьбе автора, и — что важнее — обязана
// знать, что между вопросами что-то есть. Пункт без собственного текста
// (разрыв страницы, картинка) приходит с пустым text.
func ProjectForm(s FormSchema) ChatForm {
	title, _ := FormTitle(s)
	units := formUnits(s)
	items := make([]ChatItem, 0, len(units))
	for _, u := range units {
		items = append(items, u.item)
	}
	return ChatForm{Title: title, Items: items}
}

// formUnits режет документ на пункты. Группа блоков (подпись + контент + поле) —
// один пункт; одиночный контентный блок — тоже пункт. Заголовок формы пунктом не
// является: он живёт полем Title и правится своей операцией.
func formUnits(s FormSchema) []unit {
	var units []unit
	for i := 0; i < len(s.Blocks); {
		b := s.Blocks[i]
		if b.Type == BlockFormTitle {
			i++
			continue
		}
		// Блоки одной группы идут подряд (инвариант v2).
		j := i + 1
		for j < len(s.Blocks) && s.Blocks[j].GroupID == b.GroupID && s.Blocks[j].Type != BlockFormTitle {
			j++
		}
		group := s.Blocks[i:j]
		units = append(units, unit{
			key:    "q" + strconv.Itoa(len(units)+1),
			item:   projectUnit(group, len(units)+1),
			blocks: group,
		})
		i = j
	}
	return units
}

func projectUnit(group []Block, ordinal int) ChatItem {
	item := ChatItem{Key: "q" + strconv.Itoa(ordinal)}
	var caption string
	for _, b := range group {
		switch {
		case b.Type.isCaption():
			if caption == "" {
				caption = PlainText(b.Text)
			}
		case b.Type.isAnswerable():
			item.Type = b.Type
			item.Required = b.Required
			for _, o := range b.Settings.Options {
				item.Options = append(item.Options, o.Label)
			}
			if b.Settings.ScaleMin != nil && b.Settings.ScaleMax != nil {
				item.ScaleMin, item.ScaleMax = *b.Settings.ScaleMin, *b.Settings.ScaleMax
			}
			if b.Type.carriesText() {
				caption = PlainText(b.Text)
			}
		}
	}
	if item.Type == "" {
		// Одиночка: контентный блок без отвечаемого соседа. Тип — его собственный,
		// текст — его текст (у разрыва и картинки его нет).
		lead := group[0]
		for _, b := range group {
			if !b.Type.isCaption() {
				lead = b
				break
			}
		}
		item.Type = lead.Type
		caption = PlainText(lead.Text)
	}
	item.Text = caption
	return item
}

// ApplyChatOps применяет правки модели к документу.
//
// Проекция строится здесь заново из той же схемы: ключи детерминированы, поэтому
// таблица соответствия «ключ → блок» через клиента не ездит и подделать её нечем.
//
// Ошибка называет операцию и ключ: её текст уезжает модели на вторую попытку.
func ApplyChatOps(s FormSchema, ops []ChatOp) (FormSchema, error) {
	if len(ops) == 0 {
		return FormSchema{}, opErr("правок нет")
	}
	if len(ops) > MaxChatOps {
		return FormSchema{}, opErr("больше %d правок за раз", MaxChatOps)
	}

	// КОПИЯ ДОКУМЕНТА, а не работа по месту: правка пишет в блоки через указатели,
	// а срез блоков делит массив с тем, кто нам его дал. Без копии вторая попытка
	// цикла починки начинала бы с документа, уже испорченного первой, — и это же
	// молча меняло бы схему у вызывающего.
	s.Blocks = append([]Block(nil), s.Blocks...)

	units := formUnits(s)
	title := titleBlock(s)

	// added — куда легло последнее добавление ПОСЛЕ каждого ключа. Без этой памяти
	// несколько добавлений с одним «after» встают в обратном порядке: каждое лезет
	// сразу за названный пункт, отталкивая предыдущее. Сборка формы с нуля —
	// это как раз десяток добавлений с пустым «after», то есть весь список
	// переворачивался бы.
	added := map[string]int{}

	for i, op := range ops {
		var err error
		switch op.Op {
		case OpTitle:
			title, err = applyTitle(title, op)
		case OpAdd:
			units, err = applyAdd(units, op, added)
		case OpUpdate:
			units, err = applyUpdate(units, op)
		case OpRemove:
			units, err = applyRemove(units, op)
		case OpMove:
			units, err = applyMove(units, op)
		default:
			err = opErr("неизвестная операция %q; возможны: %s", op.Op, strings.Join(chatOps, ", "))
		}
		if err != nil {
			return FormSchema{}, fmt.Errorf("правка %d: %w", i+1, err)
		}
	}

	out := s
	out.Blocks = flatten(title, units)
	if len(out.Blocks) > MaxBlocks+1 {
		return FormSchema{}, opErr("в форме стало бы больше %d блоков", MaxBlocks)
	}
	return out, nil
}

func titleBlock(s FormSchema) *Block {
	for i := range s.Blocks {
		if s.Blocks[i].Type == BlockFormTitle {
			b := s.Blocks[i]
			return &b
		}
	}
	return nil
}

func flatten(title *Block, units []unit) []Block {
	out := make([]Block, 0, len(units)*2+1)
	if title != nil {
		out = append(out, *title)
	}
	for _, u := range units {
		out = append(out, u.blocks...)
	}
	return out
}

func applyTitle(title *Block, op ChatOp) (*Block, error) {
	if op.Item == nil {
		return title, opErr("заголовок не назван")
	}
	text := strings.TrimSpace(op.Item.Text)
	if err := checkTextLen(text, MaxFormTitleLen); err != nil {
		return title, err
	}
	if title == nil {
		id := newBlockID()
		return &Block{ID: id, GroupID: groupIDOf(id), Type: BlockFormTitle, Text: TextFromString(text)}, nil
	}
	// Тот же заголовок — не правка: модель охотно присылает его эхом при любой
	// просьбе, и переписывать документ ради неизменившейся строки значит гонять
	// автосейв и историю впустую.
	if PlainText(title.Text) == text {
		return title, nil
	}
	updated := *title
	updated.Text = TextFromString(text)
	return &updated, nil
}

func applyAdd(units []unit, op ChatOp, added map[string]int) ([]unit, error) {
	if op.Item == nil {
		return units, opErr("нечего добавлять: пункт не назван")
	}
	if err := validatePlanItem(op.Item.PlanItem); err != nil {
		return units, err
	}
	at, err := insertAt(units, op.After)
	if err != nil {
		return units, err
	}
	// Второе и следующие добавления с тем же «after» встают ЗА предыдущим, а не
	// перед ним: перечисленные подряд пункты обязаны сохранить порядок, в котором
	// их назвали.
	if prev, ok := added[op.After]; ok && prev+1 > at {
		at = prev + 1
	}
	added[op.After] = at

	fresh := unit{blocks: expandPlanItem(op.Item.PlanItem)}
	return append(units[:at:at], append([]unit{fresh}, units[at:]...)...), nil
}

func applyUpdate(units []unit, op ChatOp) ([]unit, error) {
	if op.Item == nil {
		return units, opErr("нечем править: пункт не назван")
	}
	i, err := indexOf(units, op.Target)
	if err != nil {
		return units, err
	}
	if err := validatePlanItem(op.Item.PlanItem); err != nil {
		return units, err
	}
	units[i].blocks = rebuildUnit(units[i].blocks, op.Item.PlanItem)
	return units, nil
}

func applyRemove(units []unit, op ChatOp) ([]unit, error) {
	i, err := indexOf(units, op.Target)
	if err != nil {
		return units, err
	}
	return append(units[:i:i], units[i+1:]...), nil
}

func applyMove(units []unit, op ChatOp) ([]unit, error) {
	from, err := indexOf(units, op.Target)
	if err != nil {
		return units, err
	}
	moved := units[from]
	rest := append(units[:from:from], units[from+1:]...)
	at, err := insertAt(rest, op.After)
	if err != nil {
		return units, err
	}
	return append(rest[:at:at], append([]unit{moved}, rest[at:]...)...), nil
}

// indexOf — пункт по ключу. Незнакомый ключ — ошибка, а не пропуск: молча
// проигнорированная правка выглядит для автора как «ассистент сказал, что сделал,
// но не сделал».
func indexOf(units []unit, key string) (int, error) {
	if key == "" {
		return 0, opErr("не назван пункт формы")
	}
	for i, u := range units {
		if u.key == key {
			return i, nil
		}
	}
	return 0, opErr("в форме нет пункта %q", key)
}

// insertAt переводит «после такого-то» в позицию вставки. Пусто — в начало.
func insertAt(units []unit, after string) (int, error) {
	if after == "" {
		return 0, nil
	}
	i, err := indexOf(units, after)
	if err != nil {
		return 0, err
	}
	return i + 1, nil
}

// rebuildUnit переписывает пункт по правке МОДЕЛИ, сохраняя всё, чего она не
// видела: id блоков, плейсхолдеры, имя вопроса, класс, настройки файла и страницы,
// биты колонок. Это и есть причина, по которой правка идёт операциями: пересборка
// документа из плана потеряла бы каждую из этих вещей молча.
func rebuildUnit(old []Block, item PlanItem) []Block {
	out := make([]Block, 0, len(old)+1)
	var field *Block
	var caption *Block
	for i := range old {
		b := old[i]
		switch {
		case b.Type.isCaption() && caption == nil:
			caption = &old[i]
		case b.Type.isAnswerable() && field == nil:
			field = &old[i]
		default:
			out = append(out, b)
		}
	}

	// Пункт без отвечаемого блока (пояснение, раздел, разрыв, картинка): правится
	// только текст, и только если он у типа есть.
	if field == nil {
		if len(out) > 0 && out[0].Type != BlockPageBreak && out[0].Type != BlockImage {
			out[0].Text = TextFromString(item.Text)
		}
		if caption != nil {
			caption.Text = TextFromString(item.Text)
			return append([]Block{*caption}, out...)
		}
		return out
	}

	updated := *field
	updated.Type = item.Type
	updated.Required = item.Required
	if item.Type.isChoice() {
		updated.Settings.Options = mergeOptions(field.Settings.Options, item.Options)
	} else {
		updated.Settings.Options = nil
	}
	if item.Type == BlockScale {
		lo, hi := item.ScaleMin, item.ScaleMax
		if lo == 0 && hi == 0 {
			lo, hi = DefaultScaleMin, DefaultScaleMax
		}
		updated.Settings.ScaleMin, updated.Settings.ScaleMax = &lo, &hi
	} else {
		updated.Settings.ScaleMin, updated.Settings.ScaleMax = nil, nil
	}

	// Текст согласия живёт в самом блоке, у остальных — в подписи.
	if item.Type.carriesText() {
		updated.Text = TextFromString(item.Text)
		return append([]Block{updated}, out...)
	}
	updated.Text = nil

	if caption == nil {
		// Голое поле получило подпись: заводим блок в той же группе.
		caption = &Block{ID: newBlockID(), GroupID: updated.GroupID, Type: BlockTitle}
	}
	caption.Text = TextFromString(item.Text)
	return append([]Block{*caption, updated}, out...)
}

// mergeOptions сохраняет id вариантов, чьи подписи модель не тронула: на id опции
// ссылаются собранные ответы, и перевыпуск id рвёт сводку выбора молча.
func mergeOptions(old []Option, labels []string) []Option {
	byLabel := make(map[string]Option, len(old))
	for _, o := range old {
		byLabel[strings.TrimSpace(strings.ToLower(o.Label))] = o
	}
	out := make([]Option, 0, len(labels))
	for _, label := range labels {
		key := strings.TrimSpace(strings.ToLower(label))
		if prev, ok := byLabel[key]; ok {
			prev.Label = label
			out = append(out, prev)
			delete(byLabel, key)
			continue
		}
		out = append(out, Option{ID: newOptionID(), Label: label})
	}
	return out
}

func opErr(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrValidation}, args...)...)
}

// ChatEdit — правка формы, как её присылает МОДЕЛЬ: четыре списка вместо одного
// разнородного.
//
// Форма ответа выбрана под строгую схему провайдера, а не под удобство кода: в
// строгом режиме каждое поле объекта обязано присутствовать, и один список
// разнородных операций потребовал бы либо необязательного вложенного объекта
// (`null` там принимают не все совместимые входы), либо пустышки-заглушки у
// remove и move. Четыре однородных списка обходятся без того и другого.
//
// КЛЮЧИ ВНУТРИ ОДНОЙ ПРАВКИ ССЫЛАЮТСЯ НА ФОРМУ, КОТОРУЮ МОДЕЛЬ ВИДЕЛА: применение
// пунктов не перенумеровывает, поэтому «после q3» значит «после того, что было
// третьим», даже если q3 к тому моменту уже переехал. Новые пункты ключа не
// получают — сослаться на них в той же правке нельзя.
type ChatEdit struct {
	// Title — новый заголовок формы; пусто = не трогаем.
	Title string `json:"title"`
	// Add — что добавить и после какого пункта (пусто — в начало формы).
	Add []ChatAdd `json:"add"`
	// Update — что заменить: ключ пункта и его новое содержимое.
	Update []ChatUpdate `json:"update"`
	// Remove — ключи пунктов на удаление.
	Remove []string `json:"remove"`
	// Move — что подвинуть и после какого пункта (пусто — в начало формы).
	Move []ChatMove `json:"move"`
}

type ChatAdd struct {
	After string   `json:"after"`
	Item  ChatItem `json:"item"`
}

type ChatUpdate struct {
	Target string   `json:"target"`
	Item   ChatItem `json:"item"`
}

type ChatMove struct {
	Target string `json:"target"`
	After  string `json:"after"`
}

// Empty — правка ничего не меняет. Пустая правка при заявленной правке формы —
// ошибка модели, а не безобидный ответ: она сказала, что что-то сделает.
func (e ChatEdit) Empty() bool {
	return strings.TrimSpace(e.Title) == "" && len(e.Add) == 0 && len(e.Update) == 0 &&
		len(e.Remove) == 0 && len(e.Move) == 0
}

// ops разворачивает правку в плоский список операций. Порядок фиксирован —
// заголовок, замены, удаления, переносы, добавления, — и это часть контракта:
// перенос, целящийся в только что удалённый пункт, обязан отказать одинаково при
// любом порядке списков в ответе модели.
func (e ChatEdit) ops() []ChatOp {
	var ops []ChatOp
	if strings.TrimSpace(e.Title) != "" {
		ops = append(ops, ChatOp{Op: OpTitle, Item: &ChatItem{PlanItem: PlanItem{Text: e.Title}}})
	}
	for _, u := range e.Update {
		item := u.Item
		ops = append(ops, ChatOp{Op: OpUpdate, Target: u.Target, Item: &item})
	}
	for _, key := range e.Remove {
		ops = append(ops, ChatOp{Op: OpRemove, Target: key})
	}
	for _, m := range e.Move {
		ops = append(ops, ChatOp{Op: OpMove, Target: m.Target, After: m.After})
	}
	for _, a := range e.Add {
		item := a.Item
		ops = append(ops, ChatOp{Op: OpAdd, After: a.After, Item: &item})
	}
	return ops
}

// ApplyChatEdit — правка модели поверх документа.
func ApplyChatEdit(s FormSchema, e ChatEdit) (FormSchema, error) {
	return ApplyChatOps(s, e.ops())
}

// Что модель может сделать в ответ на реплику автора. Закрытый список: он же
// перечислением уезжает в схему ответа, и неизвестное действие отвергается.
const (
	// ActionEdit — правка формы: reply объясняет сделанное, списки правок несут само
	// изменение.
	ActionEdit = "edit_form"
	// ActionAnswer — ответ словами, документ не трогаем.
	ActionAnswer = "answer"
)

// ChatJSONSchema — схема ответа модели в разговоре.
//
// Все поля обязательны (строгий режим провайдера иначе не работает), поэтому
// «ничего не меняем» выражается пустыми списками и пустым заголовком, а не
// отсутствием ключей.
func ChatJSONSchema() json.RawMessage {
	item := planItemJSONSchema()
	return json.RawMessage(fmt.Sprintf(`{
  "type": "object",
  "properties": {
    "action": {"type": "string", "enum": [%q, %q]},
    "reply": {"type": "string"},
    "title": {"type": "string"},
    "add": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {"after": {"type": "string"}, "item": %s},
        "required": ["after", "item"],
        "additionalProperties": false
      }
    },
    "update": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {"target": {"type": "string"}, "item": %s},
        "required": ["target", "item"],
        "additionalProperties": false
      }
    },
    "remove": {"type": "array", "items": {"type": "string"}},
    "move": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {"target": {"type": "string"}, "after": {"type": "string"}},
        "required": ["target", "after"],
        "additionalProperties": false
      }
    }
  },
  "required": ["action", "reply", "title", "add", "update", "remove", "move"],
  "additionalProperties": false
}`, ActionEdit, ActionAnswer, item, item))
}
