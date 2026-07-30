package domain

import (
	"bytes"
	"encoding/json"
)

// Апгрейд формата схемы на чтении — БД не мигрируется ни разу (ARCHITECTURE 3.4).
// Переходы делаются ЦЕПОЧКОЙ (v1→v2→v3), поэтому каждая новая версия добавляет одну
// функцию, а не по конвертеру на каждую пару версий.
//
// v1→v2 (фаза 8.7): один блок = вопрос, подпись в `label`, описание в `description`
// → вопрос как группа блоков (подпись title + [абзац description] + поле).
// v2→v3 (фаза 14): текст блока из строки становится плоским массивом спанов.
//
// Функции чистые и ДЕТЕРМИНИРОВАННЫЕ: id производных блоков выводятся из id
// исходного (`t_`/`d_`/`g_`-префиксы), а не генерируются случайно. Иначе
// иммутабельная опубликованная версия читалась бы каждый раз с разными id, а юнит
// не мог бы сверить точный результат. Id ОТВЕЧАЕМОГО блока сохраняется без
// изменений — на него ссылаются answers и form_visits.last_block_id.

// schemaVersionV2/V3 — номера промежуточных версий. Литералом, а не через SchemaVersion:
// та означает «текущую», и когда она поехала с 2 на 3, апгрейд v1→v2 обязан был
// остаться апгрейдом именно до двойки.
const (
	schemaVersionV2 = 2
	schemaVersionV3 = 3
)

// v1Block — блок формата v1 (label/description вместо отдельных блоков-подписей).
// Разбирается нестрого: v1-документы в БД уже канонизированы валидатором v1.
type v1Block struct {
	ID          string        `json:"id"`
	Type        BlockType     `json:"type"`
	Label       string        `json:"label"`
	Description string        `json:"description"`
	Required    bool          `json:"required"`
	Settings    BlockSettings `json:"settings"`
}

type v1Schema struct {
	SchemaVersion int       `json:"schemaVersion"`
	Blocks        []v1Block `json:"blocks"`
	SubmitLabel   string    `json:"submitLabel"`
	ThankYouText  string    `json:"thankYouText"`
	RedirectURL   string    `json:"redirectUrl"`
}

// v2Block — блок формата v2: текст блока ещё плоская строка. Нужен обоим переходам —
// v1→v2 его пишет, v2→v3 читает. Отдельный тип, а не переиспользованный Block:
// канонический Block с фазы 14 несёт спаны, и попытка «сэкономить» на общем типе
// означала бы, что v1→v2 молча производит документ уже третьей версии.
type v2Block struct {
	ID       string        `json:"id"`
	GroupID  string        `json:"groupId"`
	Type     BlockType     `json:"type"`
	Text     string        `json:"text,omitempty"`
	Required bool          `json:"required,omitempty"`
	Settings BlockSettings `json:"settings"`
}

type v2Schema struct {
	SchemaVersion int       `json:"schemaVersion"`
	Blocks        []v2Block `json:"blocks"`
	SubmitLabel   string    `json:"submitLabel"`
	ThankYouText  string    `json:"thankYouText"`
	RedirectURL   string    `json:"redirectUrl"`
}

func upgradeV1toV2(raw json.RawMessage) (json.RawMessage, error) {
	// Строгий разбор v1: лишние поля запрещены так же, как у канона
	// (DisallowUnknownFields). Реальные v1-документы канонизированы валидатором v1 и
	// посторонних полей не несут, зато строгость сохраняет проверку «лишнее поле
	// блока» и на legacy-пути.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var v1 v1Schema
	if err := dec.Decode(&v1); err != nil {
		return nil, schemaErr("апгрейд v1→v2: %v", err)
	}
	if dec.More() {
		return nil, schemaErr("апгрейд v1→v2: лишние данные после схемы")
	}

	out := v2Schema{
		SchemaVersion: schemaVersionV2,
		Blocks:        make([]v2Block, 0, len(v1.Blocks)),
		SubmitLabel:   v1.SubmitLabel,
		ThankYouText:  v1.ThankYouText,
		RedirectURL:   v1.RedirectURL,
	}

	for _, b := range v1.Blocks {
		gid := "g_" + b.ID

		switch {
		case b.Type.isContent():
			// v1-контент — только text/image. Абзац text держал текст в label;
			// image — в settings (imageKey/alt), собственного текста не несёт.
			nb := v2Block{ID: b.ID, GroupID: gid, Type: b.Type, Settings: b.Settings}
			if b.Type == BlockText {
				nb.Text = b.Label
			}
			out.Blocks = append(out.Blocks, nb)

		case b.Type == BlockConsent:
			// Согласие несёт собственный текст (рядом с галочкой) — label уходит в
			// text того же блока, а не в отдельную подпись. Описание, если было, —
			// абзацем перед согласием.
			if b.Description != "" {
				out.Blocks = append(out.Blocks, v2Block{ID: "d_" + b.ID, GroupID: gid, Type: BlockText, Text: b.Description})
			}
			out.Blocks = append(out.Blocks, v2Block{ID: b.ID, GroupID: gid, Type: BlockConsent, Text: b.Label, Required: b.Required, Settings: b.Settings})

		default:
			// Прочие отвечаемые: подпись → блок title, описание → абзац text, поле —
			// с сохранённым id и без собственного текста.
			if b.Label != "" {
				out.Blocks = append(out.Blocks, v2Block{ID: "t_" + b.ID, GroupID: gid, Type: BlockTitle, Text: b.Label})
			}
			if b.Description != "" {
				out.Blocks = append(out.Blocks, v2Block{ID: "d_" + b.ID, GroupID: gid, Type: BlockText, Text: b.Description})
			}
			out.Blocks = append(out.Blocks, v2Block{ID: b.ID, GroupID: gid, Type: b.Type, Required: b.Required, Settings: b.Settings})
		}
	}

	return json.Marshal(out)
}

// upgradeV2toV3 поднимает плоский текст блока в спаны (фаза 14). Переход тривиален и
// без потерь: "abc" → [{t:"abc"}], пустая строка → отсутствие текста. Всё остальное —
// id, группы, настройки, обязательность, бит ряда — переносится байт в байт, поэтому
// форма, собранная до фазы, выглядит после апгрейда ровно как раньше.
func upgradeV2toV3(raw json.RawMessage) (json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var v2 v2Schema
	if err := dec.Decode(&v2); err != nil {
		return nil, schemaErr("апгрейд v2→v3: %v", err)
	}
	if dec.More() {
		return nil, schemaErr("апгрейд v2→v3: лишние данные после схемы")
	}

	out := FormSchema{
		// Литерал, а не SchemaVersion: этот переход поднимает ДО ТРОЙКИ, и когда
		// текущая версия поехала на 4, он обязан был остаться собой — иначе документ
		// уехал бы с v4 в заголовке, не пройдя v3→v4.
		SchemaVersion: schemaVersionV3,
		Blocks:        make([]Block, 0, len(v2.Blocks)),
		SubmitLabel:   v2.SubmitLabel,
		ThankYouText:  v2.ThankYouText,
		RedirectURL:   v2.RedirectURL,
	}
	for _, b := range v2.Blocks {
		out.Blocks = append(out.Blocks, Block{
			ID:       b.ID,
			GroupID:  b.GroupID,
			Type:     b.Type,
			Text:     TextFromString(b.Text),
			Required: b.Required,
			Settings: b.Settings,
		})
	}
	return json.Marshal(out)
}

// upgradeV3toV4 — переход фазы 15. Форма документа у v3 и v4 одна и та же, поэтому
// разбор идёт текущим типом; переход меняет номер версии и НОСИТЕЛЯ БИТА РЯДА.
//
// Заголовок формы он НЕ синтезирует, хотя блок form_title появился именно в v4:
// апгрейд видит один JSON, а заголовок старых форм лежит в колонке forms.title —
// в соседней таблице, которой здесь нет и быть не должно (функция чистая и
// детерминированная, её выход сверяют юниты). Блок дописывается на чтении
// черновика кабинетом — EnsureFormTitle, спека §3.5.
//
// Перенос бита (спека §6.3, ADR §10). У v3 бит `settings.column: "right"` живёт на
// отвечаемом блоке и значит «моя ГРУППА встаёт в ряд с предыдущей». У v4 тот же
// ключ работает на двух уровнях, и уровень задаёт место блока в группе: на ПЕРВОМ
// блоке — «справа от предыдущей группы», на любом другом — «справа от предыдущего
// блока в моей группе». У мульти-группы (подпись…поле) отвечаемый блок не первый,
// поэтому оставленный на месте бит означал бы у v4 не то, что означал у v3, —
// его переносят на первый блок группы. У групп из одного блока первый блок и есть
// отвечаемый: не меняется ничего.
//
// Версия при этом второй раз не поднимается: обе части v4 решены в 15.0, и документ,
// сохранённый между 15.1 и 15.4, переноса уже не получит — плата, принятая владельцем
// и ограниченная контуром разработки (прод до конца фазы на v3).
func upgradeV3toV4(raw json.RawMessage) (json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var v3 FormSchema
	if err := dec.Decode(&v3); err != nil {
		return nil, schemaErr("апгрейд v3→v4: %v", err)
	}
	if dec.More() {
		return nil, schemaErr("апгрейд v3→v4: лишние данные после схемы")
	}
	v3.SchemaVersion = SchemaVersion
	moveRowBitToGroupHead(v3.Blocks)
	return json.Marshal(v3)
}

// moveRowBitToGroupHead — вторая часть v3→v4: бит ряда с отвечаемого блока
// мульти-группы переезжает на первый блок этой группы.
//
// Идемпотентна по построению: после переноса бит стоит на первом блоке группы, а
// первый блок ни на какой другой не переносится — повторный проход не находит,
// что двигать. Группы v3 смежны и проверены валидатором, поэтому граница группы
// ищется по смене groupId, как и во всех остальных проходах по блокам.
func moveRowBitToGroupHead(blocks []Block) {
	for i := 0; i < len(blocks); {
		head := i
		for i++; i < len(blocks) && blocks[i].GroupID == blocks[head].GroupID; i++ {
			if blocks[i].Settings.Column == "" {
				continue
			}
			// Голое поле сюда не попадает (оно и есть head), значит это
			// отвечаемый блок мульти-группы: бит принадлежал группе.
			blocks[head].Settings.Column = blocks[i].Settings.Column
			blocks[i].Settings.Column = ""
		}
	}
}
