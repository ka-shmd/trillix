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

// schemaVersionV2 — номер промежуточной версии. Литералом, а не через SchemaVersion:
// та означает «текущую», и когда она поехала с 2 на 3, апгрейд v1→v2 обязан был
// остаться апгрейдом именно до двойки.
const schemaVersionV2 = 2

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
		SchemaVersion: SchemaVersion,
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
