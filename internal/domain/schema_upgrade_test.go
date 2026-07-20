package domain

import (
	"encoding/json"
	"testing"
)

// blockByID — блок из уже разобранной v2-схемы (после ValidateSchema/апгрейда).
func blockByID(s FormSchema, id string) (Block, bool) {
	for _, b := range s.Blocks {
		if b.ID == id {
			return b, true
		}
	}
	return Block{}, false
}

// v1-документ с подписью и описанием раскладывается в группу title + абзац + поле,
// причём id ОТВЕЧАЕМОГО блока сохраняется (на него ссылаются answers/визиты).
func TestUpgradeV1toV2_QuestionSplitsIntoGroup(t *testing.T) {
	raw := `{"schemaVersion":1,"blocks":[
		{"id":"blk_1","type":"short_text","label":"Ваше имя","description":"как в паспорте","required":true,"settings":{}}
	]}`
	s, err := ValidateSchema(json.RawMessage(raw))
	if err != nil {
		t.Fatalf("апгрейд+валидация упали: %v", err)
	}
	if s.SchemaVersion != SchemaVersion {
		t.Fatalf("schemaVersion = %d, ждали %d", s.SchemaVersion, SchemaVersion)
	}
	if len(s.Blocks) != 3 {
		t.Fatalf("ждали 3 блока (title+абзац+поле), получили %d: %+v", len(s.Blocks), s.Blocks)
	}
	// Поле сохранило id и потеряло собственный текст.
	input, ok := blockByID(s, "blk_1")
	if !ok {
		t.Fatalf("id отвечаемого блока не сохранён: %+v", s.Blocks)
	}
	if input.Type != BlockShortText || input.Text != "" || !input.Required {
		t.Fatalf("поле разобрано неверно: %+v", input)
	}
	// Подпись и описание — отдельными блоками той же группы.
	title, ok := blockByID(s, "t_blk_1")
	if !ok || title.Type != BlockTitle || title.Text != "Ваше имя" || title.GroupID != input.GroupID {
		t.Fatalf("блок-подпись собран неверно: %+v", title)
	}
	desc, ok := blockByID(s, "d_blk_1")
	if !ok || desc.Type != BlockText || desc.Text != "как в паспорте" || desc.GroupID != input.GroupID {
		t.Fatalf("блок-описание собран неверно: %+v", desc)
	}
}

// Порядок в группе: подпись → описание → поле.
func TestUpgradeV1toV2_GroupOrder(t *testing.T) {
	raw := `{"schemaVersion":1,"blocks":[
		{"id":"b","type":"email","label":"Почта","description":"рабочая","settings":{}}
	]}`
	s, _ := ValidateSchema(json.RawMessage(raw))
	wantTypes := []BlockType{BlockTitle, BlockText, BlockEmail}
	if len(s.Blocks) != len(wantTypes) {
		t.Fatalf("ждали %d блоков, получили %d", len(wantTypes), len(s.Blocks))
	}
	for i, wt := range wantTypes {
		if s.Blocks[i].Type != wt {
			t.Fatalf("блок #%d тип = %q, ждали %q", i, s.Blocks[i].Type, wt)
		}
	}
}

// Голое v1-поле (пустой label) не рождает пустой блок-подпись.
func TestUpgradeV1toV2_BareFieldNoTitle(t *testing.T) {
	raw := `{"schemaVersion":1,"blocks":[{"id":"b","type":"short_text","label":"","settings":{}}]}`
	s, _ := ValidateSchema(json.RawMessage(raw))
	if len(s.Blocks) != 1 {
		t.Fatalf("голое поле должно дать один блок, получили %+v", s.Blocks)
	}
	if s.Blocks[0].Type != BlockShortText || s.Blocks[0].Text != "" {
		t.Fatalf("поле разобрано неверно: %+v", s.Blocks[0])
	}
}

// consent сохраняет собственный текст (label → text того же блока), а не выносит его
// в отдельную подпись.
func TestUpgradeV1toV2_ConsentKeepsOwnText(t *testing.T) {
	raw := `{"schemaVersion":1,"blocks":[{"id":"c","type":"consent","label":"Соглашаюсь","required":true,"settings":{}}]}`
	s, _ := ValidateSchema(json.RawMessage(raw))
	if len(s.Blocks) != 1 {
		t.Fatalf("согласие должно дать один блок, получили %+v", s.Blocks)
	}
	c, ok := blockByID(s, "c")
	if !ok || c.Type != BlockConsent || c.Text != "Соглашаюсь" || !c.Required {
		t.Fatalf("согласие разобрано неверно: %+v", s.Blocks)
	}
}

// v1-абзац text держал текст в label — переезжает в text того же блока.
func TestUpgradeV1toV2_ContentTextBlock(t *testing.T) {
	raw := `{"schemaVersion":1,"blocks":[{"id":"p","type":"text","label":"Раздел А","settings":{}}]}`
	s, _ := ValidateSchema(json.RawMessage(raw))
	p, ok := blockByID(s, "p")
	if !ok || p.Type != BlockText || p.Text != "Раздел А" {
		t.Fatalf("абзац разобран неверно: %+v", s.Blocks)
	}
}

// Пустой дефолт БД (без schemaVersion) апгрейдится в пустую v2-схему.
func TestUpgradeV1toV2_EmptyDefault(t *testing.T) {
	s, err := ValidateSchema(json.RawMessage(`{"blocks":[]}`))
	if err != nil {
		t.Fatalf("пустой дефолт не прошёл: %v", err)
	}
	if s.SchemaVersion != SchemaVersion || len(s.Blocks) != 0 {
		t.Fatalf("ждали пустую v2, получили %+v", s)
	}
}

// Сквозь апгрейд аналитика видит правильную подпись: v1-форма читается воронкой/
// сводкой с подписью из бывшего label.
func TestUpgradeV1toV2_QuestionOrderCaption(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"blocks":[{"id":"b","type":"short_text","label":"Ваше имя","settings":{}}]}`)
	s, err := ValidateSchema(raw)
	if err != nil {
		t.Fatalf("валидация: %v", err)
	}
	qs := QuestionOrder([]VersionedSchema{{Version: 1, Schema: s}})
	if len(qs) != 1 || qs[0].ID != "b" || qs[0].Label != "Ваше имя" {
		t.Fatalf("вопрос из v1 разобран неверно: %+v", qs)
	}
}
