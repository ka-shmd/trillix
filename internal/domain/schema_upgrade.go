package domain

import (
	"bytes"
	"encoding/json"
)

// Апгрейд формата схемы v1→v2 (фаза 8.7). v1: один блок = вопрос, подпись в
// `label`, описание в `description`. v2: вопрос — группа блоков (подпись title +
// [абзац description] + отвечаемое поле). Применяется на чтении в ValidateSchema —
// БД не мигрируется (ARCHITECTURE 3.4).
//
// Функция чистая и ДЕТЕРМИНИРОВАННАЯ: id производных блоков выводятся из id
// исходного (`t_`/`d_`/`g_`-префиксы), а не генерируются случайно. Иначе
// иммутабельная опубликованная версия читалась бы каждый раз с разными id, а юнит
// не мог бы сверить точный результат. Id ОТВЕЧАЕМОГО блока сохраняется без
// изменений — на него ссылаются answers и form_visits.last_block_id.

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

func upgradeV1toV2(raw json.RawMessage) (json.RawMessage, error) {
	// Строгий разбор v1: лишние поля запрещены так же, как у v2 (DisallowUnknownFields).
	// Реальные v1-документы канонизированы валидатором v1 и посторонних полей не несут,
	// зато строгость сохраняет проверку «лишнее поле блока» и на legacy-пути.
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var v1 v1Schema
	if err := dec.Decode(&v1); err != nil {
		return nil, schemaErr("апгрейд v1→v2: %v", err)
	}
	if dec.More() {
		return nil, schemaErr("апгрейд v1→v2: лишние данные после схемы")
	}

	out := FormSchema{
		SchemaVersion: SchemaVersion,
		Blocks:        make([]Block, 0, len(v1.Blocks)),
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
			nb := Block{ID: b.ID, GroupID: gid, Type: b.Type, Settings: b.Settings}
			if b.Type == BlockText {
				nb.Text = b.Label
			}
			out.Blocks = append(out.Blocks, nb)

		case b.Type == BlockConsent:
			// Согласие несёт собственный текст (рядом с галочкой) — label уходит в
			// text того же блока, а не в отдельную подпись. Описание, если было, —
			// абзацем перед согласием.
			if b.Description != "" {
				out.Blocks = append(out.Blocks, Block{ID: "d_" + b.ID, GroupID: gid, Type: BlockText, Text: b.Description})
			}
			out.Blocks = append(out.Blocks, Block{ID: b.ID, GroupID: gid, Type: BlockConsent, Text: b.Label, Required: b.Required, Settings: b.Settings})

		default:
			// Прочие отвечаемые: подпись → блок title, описание → абзац text, поле —
			// с сохранённым id и без собственного текста.
			if b.Label != "" {
				out.Blocks = append(out.Blocks, Block{ID: "t_" + b.ID, GroupID: gid, Type: BlockTitle, Text: b.Label})
			}
			if b.Description != "" {
				out.Blocks = append(out.Blocks, Block{ID: "d_" + b.ID, GroupID: gid, Type: BlockText, Text: b.Description})
			}
			out.Blocks = append(out.Blocks, Block{ID: b.ID, GroupID: gid, Type: b.Type, Required: b.Required, Settings: b.Settings})
		}
	}

	return json.Marshal(out)
}
