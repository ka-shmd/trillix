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
	// Title — заголовок формы ВМЕСТЕ С ОФОРМЛЕНИЕМ (той же формы, что правка `title`).
	//
	// Оформление показывается не для симметрии: правка заголовка описывает его ЖЕЛАЕМОЕ
	// состояние целиком, и модель, не видя нынешнего, отвечала эхом с `bold: false` —
	// посторонняя просьба («сделай телефон необязательным») снимала жирность заголовка
	// формы. Замер 2026-09-02: один прогон из трёх.
	Title ChatTitle `json:"title"`
	// Cover — чем залита обложка: "" — обложки нет, "#rrggbb" — цветом,
	// ChatCoverImage — картинкой автора. Модель заливает обложку только цветом и
	// должна видеть картинку, чтобы не заменить её цветом без прямой просьбы.
	Cover string     `json:"cover"`
	Items []ChatItem `json:"items"`
}

// ChatCoverImage — обложка-картинка в проекции формы. Ключ объекта модели не нужен.
const ChatCoverImage = "image"

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
	text, _ := FormTitle(s)
	title := ChatTitle{Text: text}
	if b := titleBlock(s); b != nil {
		title.Bold, title.Color, title.BG = styleOf(b.Text)
	}
	units := formUnits(s)
	items := make([]ChatItem, 0, len(units))
	for _, u := range units {
		items = append(items, u.item)
	}
	var cover string
	switch {
	case s.Cover == nil:
	case s.Cover.ImageKey != "":
		cover = ChatCoverImage
	default:
		cover = s.Cover.Color
	}
	return ChatForm{Title: title, Cover: cover, Items: items}
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
				item.Bold, item.Color, item.BG = styleOf(b.Text)
			}
		case b.Type.isAnswerable():
			item.Type = b.Type
			item.Required = b.Required
			// Подсказка видна модели: иначе на просьбу «поменяй подсказку» ей нечего
			// менять, а на любой другой правке она не знает, что подсказка уже есть.
			item.Placeholder = b.Settings.Placeholder
			for _, o := range b.Settings.Options {
				item.Options = append(item.Options, o.Label)
			}
			if b.Settings.ScaleMin != nil && b.Settings.ScaleMax != nil {
				item.ScaleMin, item.ScaleMax = *b.Settings.ScaleMin, *b.Settings.ScaleMax
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
		item.Bold, item.Color, item.BG = styleOf(lead.Text)
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
	styled := *op.Item
	styled.Text = strings.TrimSpace(styled.Text)
	if err := checkTextLen(styled.Text, MaxFormTitleLen); err != nil {
		return title, err
	}
	// Заголовок, который ассистент СОЗДАЁТ (блока нет или он пустой), приходит жирным —
	// как заголовок, набранный на полотне (withCreatedBold). У переименования готового
	// заголовка жирность берётся из ответа модели: автор мог снять её сам, и вернуть её
	// обратно за него значило бы спорить с ним при каждой правке названия.
	if title == nil || PlainText(title.Text) == "" {
		styled.Bold = true
	}
	// Пустой текст при заданном оформлении — «покрась, не переименовывая»: берём
	// нынешний заголовок. Иначе просьба «выдели заголовок фоном» стирала бы его.
	if styled.Text == "" && title != nil {
		styled.Text = PlainText(title.Text)
	}
	if title == nil {
		id := newBlockID()
		return &Block{ID: id, GroupID: groupIDOf(id), Type: BlockFormTitle, Text: styledText(styled.PlanItem)}, nil
	}
	// Тот же заголовок И то же оформление — не правка: модель охотно присылает
	// заголовок эхом при любой просьбе, и переписывать документ ради неизменившейся
	// строки значит гонять автосейв и историю впустую.
	bold, color, bg := styleOf(title.Text)
	if PlainText(title.Text) == styled.Text && bold == styled.Bold &&
		color == normalizeHex(styled.Color) && bg == normalizeHex(styled.BG) {
		return title, nil
	}
	updated := *title
	updated.Text = restyledText(title.Text, styled.PlanItem)
	return &updated, nil
}

func applyAdd(units []unit, op ChatOp, added map[string]int) ([]unit, error) {
	if op.Item == nil {
		return units, opErr("нечего добавлять: пункт не назван")
	}
	if err := validatePlanItem(op.Item.PlanItem); err != nil {
		return units, err
	}
	// НЕИЗВЕСТНЫЙ ЯКОРЬ У ДОБАВЛЕНИЯ — НЕ ОШИБКА, А «В КОНЕЦ». Собирая форму с нуля,
	// модель нумерует пункты на ходу и ссылается на только что добавленный
	// («after»: «q1»), которого в форме ещё нет; строгий отказ тратил на это вторую
	// попытку, а когда она приходила такой же — терял ВЕСЬ ответ, и автор вместо
	// собранной формы получал отказ. «After» — это место, а не адресат правки:
	// промахнувшись местом, пункт всё равно нужен автору. У update и move якорь
	// остаётся строгим — там названный пункт и есть предмет правки.
	at, err := insertAt(units, op.After)
	if err != nil {
		at = len(units)
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
	// ПОРЯДОК БЛОКОВ ВНУТРИ ПУНКТА СОХРАНЯЕТСЯ. Между подписью и полем автор мог
	// поставить картинку или пояснение — regroup держит их в той же группе, — и
	// прежняя сборка «подпись, поле, всё остальное» уводила их ПОД поле. При
	// следующем regroup они вываливались из вопроса в одиночки, и автосейв сохранял
	// перестановку, о которой никто не просил.
	out := make([]Block, len(old))
	copy(out, old)

	capIdx, fieldIdx, leadIdx := -1, -1, -1
	for i := range out {
		switch {
		case out[i].Type.isCaption():
			if capIdx == -1 {
				capIdx = i
			}
		case out[i].Type.isAnswerable():
			if fieldIdx == -1 {
				fieldIdx = i
			}
		}
		if !out[i].Type.isCaption() && leadIdx == -1 {
			leadIdx = i
		}
	}

	// Пункт без отвечаемого блока (пояснение, раздел, разрыв, картинка): правится
	// только текст, и только если он у типа есть.
	if fieldIdx == -1 {
		if capIdx != -1 {
			out[capIdx].Text = restyledText(out[capIdx].Text, item)
		}
		if leadIdx != -1 && out[leadIdx].Type != BlockPageBreak && out[leadIdx].Type != BlockImage {
			out[leadIdx].Text = restyledText(out[leadIdx].Text, item)
		}
		return out
	}

	updated := out[fieldIdx]
	updated.Type = item.Type
	updated.Required = item.Required
	// МИНА: пустая подсказка означает «не трогать», а не «стереть». Схема ответа
	// требует поле в каждом пункте, и на правке про жирность модель пришлёт его
	// пустым — «пусто значит стереть» вычищало бы авторские подсказки при каждой
	// посторонней правке. Тип, который подсказку не показывает, теряет её вместе с
	// остальными своими настройками: строка в документе, которой негде появиться, —
	// мусор, а не сохранённая работа автора.
	switch {
	case !item.Type.showsPlaceholder():
		updated.Settings.Placeholder = ""
	case item.Placeholder != "":
		updated.Settings.Placeholder = item.Placeholder
	}
	if item.Type.isChoice() {
		updated.Settings.Options = mergeOptions(out[fieldIdx].Settings.Options, item.Options)
	} else {
		updated.Settings.Options = nil
	}
	// НАСТРОЙКИ ФАЙЛА УХОДЯТ ВМЕСТЕ С ТИПОМ, как варианты и шкала: ValidateSchema
	// требует их отсутствия у нефайлового типа, и «замени вопрос про фото на короткий
	// ответ» собирало документ, который отвергал наш же валидатор, — автор видел в
	// чате текст валидатора вместо ответа, а деньги провайдеру были уплачены.
	if item.Type != BlockFile {
		updated.Settings.MaxFiles, updated.Settings.MaxFileSize = 0, 0
		updated.Settings.Accept = nil
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
	// Число звёзд уходит вместе с типом по той же причине, что диапазон шкалы.
	if item.Type != BlockRating {
		updated.Settings.RatingStars = 0
	}

	updated.Text = nil
	out[fieldIdx] = updated

	if capIdx != -1 {
		out[capIdx].Text = restyledText(out[capIdx].Text, item)
		return out
	}
	// Голое поле получило подпись: заводим блок в той же группе и ставим ПЕРЕД полем,
	// а не в начало пункта — между ними мог оказаться чужой блок.
	caption := Block{ID: newBlockID(), GroupID: updated.GroupID, Type: BlockTitle, Text: styledText(item)}
	out = append(out, Block{})
	copy(out[fieldIdx+1:], out[fieldIdx:])
	out[fieldIdx] = caption
	return out
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
	// Title — новый заголовок формы; пустой text = не трогаем. Объект, а не строка:
	// заголовок красят так же, как подписи вопросов («выдели заголовок фоном»), и
	// голая строка этого не выражала.
	Title ChatTitle `json:"title"`
	// Add — что добавить и после какого пункта (пусто — в начало формы).
	Add []ChatAdd `json:"add"`
	// Update — что заменить: ключ пункта и его новое содержимое.
	Update []ChatUpdate `json:"update"`
	// Remove — ключи пунктов на удаление.
	Remove []string `json:"remove"`
	// Move — что подвинуть и после какого пункта (пусто — в начало формы).
	Move []ChatMove `json:"move"`
}

// ChatTitle — заголовок формы вместе с его оформлением.
type ChatTitle struct {
	Text  string `json:"text"`
	Bold  bool   `json:"bold"`
	Color string `json:"color"`
	BG    string `json:"bg"`
}

// Empty — заголовок не трогаем. Пустого ТЕКСТА для этого мало: «выдели заголовок
// фоном» приходит стилем без текста, и считать такую правку пустой значило бы
// молча её потерять.
func (t ChatTitle) Empty() bool {
	return strings.TrimSpace(t.Text) == "" && !t.Bold && t.Color == "" && t.BG == ""
}

func (t ChatTitle) item() ChatItem {
	return ChatItem{PlanItem: PlanItem{Text: t.Text, Bold: t.Bold, Color: t.Color, BG: t.BG}}
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
	return e.Title.Empty() && len(e.Add) == 0 && len(e.Update) == 0 &&
		len(e.Remove) == 0 && len(e.Move) == 0
}

// ops разворачивает правку в плоский список операций. Порядок фиксирован —
// заголовок, замены, удаления, переносы, добавления, — и это часть контракта:
// перенос, целящийся в только что удалённый пункт, обязан отказать одинаково при
// любом порядке списков в ответе модели.
func (e ChatEdit) ops() []ChatOp {
	var ops []ChatOp
	if !e.Title.Empty() {
		item := e.Title.item()
		ops = append(ops, ChatOp{Op: OpTitle, Item: &item})
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
//
// ПОРЯДОК ПОЛЕЙ — ПОРЯДОК, в котором модель пишет ответ: reply и planBlocked стоят
// ПОСЛЕ правок, чтобы ответ описывал сделанное. Пока reply шёл вторым, модель писала
// «обложку поставить не могу» и следом ставила её.
//
// withCover — есть ли в правке вида поле обложки. Его дают, только когда автор
// просит обложку: модель, заполняя блок design, заполняла его целиком и ставила
// обложку на любую просьбу про вид, указание «только по прямой просьбе» не держала.
func ChatJSONSchema(withCover bool) json.RawMessage {
	item := planItemJSONSchema()
	// Каждое перечисление получает пустую строку: в строгом режиме поле обязано
	// присутствовать, и «не трогать» выражается ею.
	withEmpty := func(vals []string) string {
		out, _ := json.Marshal(append([]string{""}, vals...))
		return string(out)
	}
	themes, fonts := withEmpty(designThemes), withEmpty(designFonts)
	densities, aligns := withEmpty(designDensities), withEmpty(designAligns)
	outlines := withEmpty(designOutlines)
	btnVariants, btnWidths := withEmpty(designButtonVariant), withEmpty(designButtonWidth)
	btnAligns := withEmpty(designButtonAligns)
	coverProp, coverReq := "", ""
	if withCover {
		coverProp, coverReq = `
        "cover": {"type": "string"},`, `"cover", `
	}
	return json.RawMessage(fmt.Sprintf(`{
  "type": "object",
  "properties": {
    "action": {"type": "string", "enum": [%q, %q]},
    "title": {
      "type": "object",
      "properties": {
        "text": {"type": "string"},
        "bold": {"type": "boolean"},
        "color": {"type": "string"},
        "bg": {"type": "string"}
      },
      "required": ["text", "bold", "color", "bg"],
      "additionalProperties": false
    },
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
    },
    "design": {
      "type": "object",
      "properties": {%s
        "theme": {"type": "string", "enum": %s},
        "font": {"type": "string", "enum": %s},
        "accent": {"type": "string"},
        "canvas": {"type": "string"},
        "textColor": {"type": "string"},
        "buttonColor": {"type": "string"},
        "width": {"type": "integer"},
        "fontSize": {"type": "integer"},
        "density": {"type": "string", "enum": %s},
        "align": {"type": "string", "enum": %s},
        "radius": {"type": "integer"},
        "borderWidth": {"type": "integer"},
        "outline": {"type": "string", "enum": %s},
        "buttonVariant": {"type": "string", "enum": %s},
        "buttonWidth": {"type": "string", "enum": %s},
        "buttonAlign": {"type": "string", "enum": %s},
        "buttonRadius": {"type": "integer"}
      },
      "required": [%s"theme", "font", "accent", "canvas", "textColor", "buttonColor",
        "width", "fontSize", "density", "align", "radius", "borderWidth", "outline",
        "buttonVariant", "buttonWidth", "buttonAlign", "buttonRadius"],
      "additionalProperties": false
    },
    "reply": {"type": "string"},
    "planBlocked": {"type": "boolean"}
  },
  "required": ["action", "reply", "planBlocked", "title", "add", "update", "remove", "move", "design"],
  "additionalProperties": false
}`, ActionEdit, ActionAnswer, item, item, coverProp, themes, fonts,
		densities, aligns, outlines, btnVariants, btnWidths, btnAligns, coverReq))
}

// ChatDesign — оформление глазами модели: узкий срез FormDesign, а не он целиком.
//
// Срез, потому что оформление — двадцать с лишним ключей (палитра из девяти цветов,
// раскладка, контролы, кнопка, свой CSS), и просить у модели документ целиком значит
// получать обратно то, чего автор не просил. Разговор оперирует семнадцатью
// настройками (слайс F): тема, шрифт, четыре цвета, ширина и кегль, плотность и
// выравнивание, скругление и край поля, вид контура, четыре свойства кнопки, — и
// заливкой обложки цветом. Обложка — не часть FormDesign (cover.go), но автор просит
// её теми же словами, что и цвета, поэтому в правке вида она соседнее поле. Свой CSS,
// обложка-картинка, логотип и тонкая настройка размеров остаются панели оформления:
// картинку модели подставить нечем.
//
// Пустая строка значит «не трогать»: своего «сбросить» у чата нет — сброс живёт
// кнопкой в панели, и путать «поставь светлую тему» со «сними всё оформление»
// нельзя.
type ChatDesign struct {
	// Строки: пусто — не трогать. Числа: -1 — не трогать. Сентинел у чисел
	// обязателен, а не выбран для симметрии: у скругления и толщины края НОЛЬ —
	// осмысленное значение («без скруглений», «без края»), и совпади он с «не
	// задано», просьбу «убери скругления» стало бы нечем выразить.
	Theme string `json:"theme"`
	Font  string `json:"font"`

	// Цвета в формате #rrggbb; регистр приводим сами (normalizeHex).
	Accent      string `json:"accent"`
	Canvas      string `json:"canvas"`
	TextColor   string `json:"textColor"`
	ButtonColor string `json:"buttonColor"`

	// Раскладка.
	Width    int    `json:"width"`
	FontSize int    `json:"fontSize"`
	Density  string `json:"density"`
	Align    string `json:"align"`

	// Поля ввода.
	Radius      int    `json:"radius"`
	BorderWidth int    `json:"borderWidth"`
	Outline     string `json:"outline"`

	// Кнопка отправки.
	ButtonVariant string `json:"buttonVariant"`
	ButtonWidth   string `json:"buttonWidth"`
	ButtonAlign   string `json:"buttonAlign"`
	ButtonRadius  int    `json:"buttonRadius"`

	// Cover — залить обложку этим цветом (#rrggbb); пусто — не трогать. Обложку-
	// картинку правка отвергает (ApplyChatDesign). В схеме ответа поле есть, только
	// когда автор просит обложку (ChatJSONSchema).
	Cover string `json:"cover"`
}

// ChatDesignEmpty — правка оформления, которая ничего не меняет.
//
// Нужна ПЕРЕД разбором ответа модели: нулевое значение структуры означало бы
// «поставить ширину 0 и скругление 0», то есть ответ, где блока design нет вовсе
// (обычный edit_form), читался бы как правка оформления. Разбор кладёт это
// значение в поле и позволяет JSON перебить его.
func ChatDesignEmpty() ChatDesign {
	return ChatDesign{
		Width: ChatDesignKeep, FontSize: ChatDesignKeep, Radius: ChatDesignKeep,
		BorderWidth: ChatDesignKeep, ButtonRadius: ChatDesignKeep,
	}
}

// ChatDesignKeep — значение числового поля, означающее «не трогать».
const ChatDesignKeep = -1

// chatDesignForm собирает из правки кусок FormDesign — ровно те ключи, которые
// правка называет. Один код на три задачи: наложение, счёт платного и счёт
// бесплатного, — иначе три места разъедутся на первом же новом поле.
func (d ChatDesign) chatDesignForm() FormDesign {
	out := FormDesign{Theme: d.Theme, Font: d.Font}

	if d.Accent != "" || d.Canvas != "" || d.TextColor != "" || d.ButtonColor != "" {
		out.Palette = &DesignPalette{
			Accent: normalizeHex(d.Accent), Canvas: normalizeHex(d.Canvas),
			Text: normalizeHex(d.TextColor), Button: normalizeHex(d.ButtonColor),
		}
	}
	if d.Width != ChatDesignKeep || d.FontSize != ChatDesignKeep || d.Density != "" || d.Align != "" {
		layout := DesignLayout{Density: d.Density, Align: d.Align}
		if d.Width != ChatDesignKeep {
			width := d.Width
			layout.Width = &width
		}
		if d.FontSize != ChatDesignKeep {
			size := d.FontSize
			layout.FontSize = &size
		}
		out.Layout = &layout
	}
	if d.Radius != ChatDesignKeep || d.BorderWidth != ChatDesignKeep || d.Outline != "" {
		controls := DesignControls{Outline: d.Outline}
		if d.Radius != ChatDesignKeep {
			radius := d.Radius
			controls.Radius = &radius
		}
		if d.BorderWidth != ChatDesignKeep {
			border := d.BorderWidth
			controls.BorderWidth = &border
		}
		out.Controls = &controls
	}
	if d.ButtonVariant != "" || d.ButtonWidth != "" || d.ButtonAlign != "" || d.ButtonRadius != ChatDesignKeep {
		button := DesignButton{Variant: d.ButtonVariant, Width: d.ButtonWidth, Align: d.ButtonAlign}
		if d.ButtonRadius != ChatDesignKeep {
			radius := d.ButtonRadius
			button.Radius = &radius
		}
		out.Button = &button
	}
	return out
}

// Empty — правка вида ничего не меняет: ни оформления, ни обложки.
func (d ChatDesign) Empty() bool {
	return d.designEmpty() && d.Cover == ""
}

// designEmpty — правка не называет ни одного ключа FormDesign (обложка живёт вне его).
func (d ChatDesign) designEmpty() bool {
	form := d.chatDesignForm()
	return form.Theme == "" && form.Font == "" && form.Palette == nil &&
		form.Layout == nil && form.Controls == nil && form.Button == nil
}

// ApplyChatDesign накладывает правку оформления на документ.
//
// Наложением, а не заменой: у формы уже может быть оформление, выставленное панелью,
// и «сделай тёмной» не должно снимать выбранный автором шрифт.
func ApplyChatDesign(s FormSchema, patch ChatDesign) (FormSchema, error) {
	if patch.Empty() {
		return FormSchema{}, opErr("оформление не названо")
	}

	// КОПИЯ ГЛУБОКАЯ, а не присваивание структуры: у оформления пять полей-указателей
	// (палитра, лэйаут, контролы, кнопка), и `design = *s.Design` оставил бы их общими
	// со входом — mergeDesign писал бы прямо в документ автора.
	//
	// МИНА: цена этой строки — обход гейта тарифа. Проверка цикла починки применяет
	// правку ДО того, как сервер отсечёт платное, и без копии платная настройка уже
	// лежала бы в схеме, которую кабинет сохранит автосейвом. Тот же довод, что у
	// копии блоков в ApplyChatOps, и та же цена ошибки: отвергнутая первая попытка
	// модели отравляла бы вторую.
	out := s
	if !patch.designEmpty() {
		design, err := cloneDesign(s.Design)
		if err != nil {
			return FormSchema{}, err
		}
		mergeDesign(&design, patch.chatDesignForm())
		if err := validateDesign(&design); err != nil {
			return FormSchema{}, fmt.Errorf("%w: %v", ErrValidation, err)
		}
		out.Design = &design
	}
	if patch.Cover != "" {
		// Картинку автора чат цветом не заменяет: модель делала это и на постороннюю
		// просьбу («сделай ярче»), а вернуть картинку разговором нечем. Отказ уезжает
		// модели на вторую попытку; заменить её автор может в окне обложки.
		if s.Cover != nil && s.Cover.ImageKey != "" {
			return FormSchema{}, opErr("обложка формы — картинка автора, цветом её не заменяй: оставь cover пустым " +
				"и, если просили именно обложку, скажи, что картинку меняют в окне обложки на полотне")
		}
		cover := coverColor(s.Cover, normalizeHex(patch.Cover))
		if err := validateCover(cover); err != nil {
			return FormSchema{}, fmt.Errorf("%w: %v", ErrValidation, err)
		}
		out.Cover = cover
	}
	return out, nil
}

// coverColor — обложка, залитая цветом. Высота полосы сохраняется. Зеркалит coverFill в
// web/app/src/features/forms/builder/designEdit.ts. Новый объект, а не правка старого:
// старый принадлежит документу автора (та же мина, что у копии оформления выше).
func coverColor(old *FormCover, color string) *FormCover {
	out := &FormCover{Color: color}
	if old != nil && old.Height != nil {
		height := *old.Height
		out.Height = &height
	}
	return out
}

// cloneDesign — глубокая копия оформления, ЧЕРЕЗ JSON, а не по полям.
//
// По полям было бы быстрее и молча ломалось бы: у оформления два десятка указателей
// (палитра, лэйаут, контролы, кнопка и числа внутри них), и поле, добавленное завтра,
// снова оказалось бы общим со входом — ровно тот дефект, ради которого копия и
// заводится. Правка оформления приходит разговором, то есть раз в несколько секунд:
// цена сериализации здесь не измерима, а цена пропущенного поля — правка чужого
// документа.
func cloneDesign(src *FormDesign) (FormDesign, error) {
	if src == nil {
		return FormDesign{}, nil
	}
	raw, err := json.Marshal(src)
	if err != nil {
		return FormDesign{}, fmt.Errorf("clone design: %w", err)
	}
	var out FormDesign
	if err := json.Unmarshal(raw, &out); err != nil {
		return FormDesign{}, fmt.Errorf("clone design: %w", err)
	}
	return out, nil
}

// mergeDesign накладывает названное правкой на то, что у формы уже есть. Ключ, о
// котором правка молчит, остаётся прежним: «убери скругления» не трогает цвета.
func mergeDesign(dst *FormDesign, patch FormDesign) {
	setString(&dst.Theme, patch.Theme)
	setString(&dst.Font, patch.Font)
	if p := patch.Palette; p != nil {
		if dst.Palette == nil {
			dst.Palette = &DesignPalette{}
		}
		setString(&dst.Palette.Accent, p.Accent)
		setString(&dst.Palette.Canvas, p.Canvas)
		setString(&dst.Palette.Text, p.Text)
		setString(&dst.Palette.Button, p.Button)
	}
	if l := patch.Layout; l != nil {
		if dst.Layout == nil {
			dst.Layout = &DesignLayout{}
		}
		setString(&dst.Layout.Density, l.Density)
		setString(&dst.Layout.Align, l.Align)
		setInt(&dst.Layout.Width, l.Width)
		setInt(&dst.Layout.FontSize, l.FontSize)
	}
	if c := patch.Controls; c != nil {
		if dst.Controls == nil {
			dst.Controls = &DesignControls{}
		}
		setString(&dst.Controls.Outline, c.Outline)
		setInt(&dst.Controls.Radius, c.Radius)
		setInt(&dst.Controls.BorderWidth, c.BorderWidth)
	}
	if b := patch.Button; b != nil {
		if dst.Button == nil {
			dst.Button = &DesignButton{}
		}
		setString(&dst.Button.Variant, b.Variant)
		setString(&dst.Button.Width, b.Width)
		setString(&dst.Button.Align, b.Align)
		setInt(&dst.Button.Radius, b.Radius)
	}
}

func setString(dst *string, v string) {
	if v != "" {
		*dst = v
	}
}

func setInt(dst **int, v *int) {
	if v != nil {
		*dst = v
	}
}

// normalizeHex приводит цвет к тому виду, который принимает схема. Регистр —
// единственное, что мы правим за модель: он не несёт смысла, а отказ из-за него
// стоил бы автору лишнего ожидания.
func normalizeHex(c string) string { return strings.ToLower(strings.TrimSpace(c)) }

// ChatDesignPaid — что из ПРАВКИ платно (перечень для человека; пусто — правка
// бесплатна на любом тарифе).
//
// Считается по самой правке, а не по документу после наложения: иначе автор
// бесплатного тарифа, у которого цвет уже стоит с прежних времён, не смог бы
// переключить даже тему.
func ChatDesignPaid(patch ChatDesign) []string {
	form := patch.chatDesignForm()
	form.Theme = "" // тема бесплатна на любом тарифе
	return DesignPaidFeatures(&form)
}

// ChatDesignFree — та часть правки, которая бесплатна на любом тарифе.
//
// Что бесплатно, решает не список здесь, а DesignPaidFeatures: каждое поле пробуется
// оставить, и остаётся то, из-за которого правка не становится платной. Поэтому
// открытие завтра любой настройки бесплатному тарифу не потребует второй копии
// правила — достаточно одной строки там.
func ChatDesignFree(patch ChatDesign) ChatDesign {
	free := ChatDesignEmpty()
	keepString := []struct{ dst, src *string }{
		{&free.Theme, &patch.Theme},
		{&free.Font, &patch.Font},
		{&free.Accent, &patch.Accent},
		{&free.Canvas, &patch.Canvas},
		{&free.TextColor, &patch.TextColor},
		{&free.ButtonColor, &patch.ButtonColor},
		{&free.Density, &patch.Density},
		{&free.Align, &patch.Align},
		{&free.Outline, &patch.Outline},
		{&free.ButtonVariant, &patch.ButtonVariant},
		{&free.ButtonWidth, &patch.ButtonWidth},
		{&free.ButtonAlign, &patch.ButtonAlign},
		{&free.Cover, &patch.Cover},
	}
	for _, k := range keepString {
		if *k.src == "" {
			continue
		}
		*k.dst = *k.src
		if len(ChatDesignPaid(free)) > 0 {
			*k.dst = ""
		}
	}
	keepInt := []struct {
		dst *int
		src int
	}{
		{&free.Width, patch.Width},
		{&free.FontSize, patch.FontSize},
		{&free.Radius, patch.Radius},
		{&free.BorderWidth, patch.BorderWidth},
		{&free.ButtonRadius, patch.ButtonRadius},
	}
	for _, k := range keepInt {
		if k.src == ChatDesignKeep {
			continue
		}
		*k.dst = k.src
		if len(ChatDesignPaid(free)) > 0 {
			*k.dst = ChatDesignKeep
		}
	}
	return free
}

// DesignThemes и DesignFonts — что модель вправе назвать. Отдаются списками, потому
// что уезжают перечислением в схему ответа: второй копии этих значений в проекте не
// заводится.
func DesignThemes() []string         { return append([]string(nil), designThemes...) }
func DesignFonts() []string          { return append([]string(nil), designFonts...) }
func DesignDensities() []string      { return append([]string(nil), designDensities...) }
func DesignAligns() []string         { return append([]string(nil), designAligns...) }
func DesignOutlines() []string       { return append([]string(nil), designOutlines...) }
func DesignButtonVariants() []string { return append([]string(nil), designButtonVariant...) }
func DesignButtonWidths() []string   { return append([]string(nil), designButtonWidth...) }
func DesignButtonAligns() []string   { return append([]string(nil), designButtonAligns...) }
