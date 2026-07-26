package domain

import (
	"encoding/json"
	"testing"
)

// blockByID — блок из уже разобранной канонической схемы (после ValidateSchema и
// апгрейда цепочкой v1→v2→v3).
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
	if input.Type != BlockShortText || len(input.Text) != 0 || !input.Required {
		t.Fatalf("поле разобрано неверно: %+v", input)
	}
	// Подпись и описание — отдельными блоками той же группы.
	title, ok := blockByID(s, "t_blk_1")
	if !ok || title.Type != BlockTitle || PlainText(title.Text) != "Ваше имя" || title.GroupID != input.GroupID {
		t.Fatalf("блок-подпись собран неверно: %+v", title)
	}
	desc, ok := blockByID(s, "d_blk_1")
	if !ok || desc.Type != BlockText || PlainText(desc.Text) != "как в паспорте" || desc.GroupID != input.GroupID {
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
	if s.Blocks[0].Type != BlockShortText || len(s.Blocks[0].Text) != 0 {
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
	if !ok || c.Type != BlockConsent || PlainText(c.Text) != "Соглашаюсь" || !c.Required {
		t.Fatalf("согласие разобрано неверно: %+v", s.Blocks)
	}
}

// v1-абзац text держал текст в label — переезжает в text того же блока.
func TestUpgradeV1toV2_ContentTextBlock(t *testing.T) {
	raw := `{"schemaVersion":1,"blocks":[{"id":"p","type":"text","label":"Раздел А","settings":{}}]}`
	s, _ := ValidateSchema(json.RawMessage(raw))
	p, ok := blockByID(s, "p")
	if !ok || p.Type != BlockText || PlainText(p.Text) != "Раздел А" {
		t.Fatalf("абзац разобран неверно: %+v", s.Blocks)
	}
}

// Пустой дефолт БД (без schemaVersion) апгрейдится в пустую каноническую схему.
func TestUpgradeV1toV2_EmptyDefault(t *testing.T) {
	s, err := ValidateSchema(json.RawMessage(`{"blocks":[]}`))
	if err != nil {
		t.Fatalf("пустой дефолт не прошёл: %v", err)
	}
	if s.SchemaVersion != SchemaVersion || len(s.Blocks) != 0 {
		t.Fatalf("ждали пустую каноническую схему, получили %+v", s)
	}
}

// ---------- v2 → v3: текст блока из строки в спаны (фаза 14) ----------

// Главное свойство апгрейда: форма, собранная ДО фазы, после неё выглядит ровно как
// раньше. Проверяется не «схема разобралась», а что каждое поле доехало.
func TestUpgradeV2toV3_TextBecomesSpans(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":2,"blocks":[
		{"id":"t","groupId":"g","type":"title","text":"Ваше имя","settings":{}},
		{"id":"f","groupId":"g","type":"short_text","required":true,"settings":{"placeholder":"Иван","column":"right"}}
	],"submitLabel":"Готово","thankYouText":"Спасибо","redirectUrl":"https://a.ru"}`)
	s, err := ValidateSchema(raw)
	if err != nil {
		t.Fatalf("апгрейд+валидация упали: %v", err)
	}
	if s.SchemaVersion != SchemaVersion {
		t.Fatalf("schemaVersion = %d, ждали %d", s.SchemaVersion, SchemaVersion)
	}
	title, ok := blockByID(s, "t")
	if !ok {
		t.Fatalf("подпись потерялась: %+v", s.Blocks)
	}
	// Текст поднялся в РОВНО один кусок без разметки — не в пустой массив и не в
	// несколько кусков.
	if len(title.Text) != 1 || title.Text[0].T != "Ваше имя" || title.Text[0].M != nil {
		t.Fatalf("текст подписи поднят неверно: %+v", title.Text)
	}
	// Всё, что не текст, переносится байт в байт.
	f, _ := blockByID(s, "f")
	if !f.Required || f.Settings.Placeholder != "Иван" || f.Settings.Column != ColumnRight {
		t.Fatalf("поле потеряло настройки при апгрейде: %+v", f)
	}
	if s.SubmitLabel != "Готово" || s.ThankYouText != "Спасибо" || s.RedirectURL != "https://a.ru" {
		t.Fatalf("поля формы-уровня потерялись: %+v", s)
	}
}

// Пустой текст v2 не превращается в кусок с пустым текстом (тот отвергается
// валидатором — иначе апгрейд рождал бы невалидный документ).
func TestUpgradeV2toV3_EmptyTextGivesNoSpans(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":2,"blocks":[
		{"id":"t","groupId":"g","type":"title","text":"","settings":{}}
	]}`)
	s, err := ValidateSchema(raw)
	if err != nil {
		t.Fatalf("апгрейд+валидация упали: %v", err)
	}
	if len(s.Blocks[0].Text) != 0 {
		t.Fatalf("пустой текст дал %+v, ждали отсутствие спанов", s.Blocks[0].Text)
	}
}

// Цепочка целиком: v1-документ доезжает до v3 за два перехода, и подпись из бывшего
// label оказывается спаном.
func TestUpgrade_V1ReachesV3ThroughChain(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"blocks":[
		{"id":"b","type":"short_text","label":"Ваше имя","settings":{}}
	]}`)
	s, err := ValidateSchema(raw)
	if err != nil {
		t.Fatalf("цепочка апгрейдов упала: %v", err)
	}
	if s.SchemaVersion != SchemaVersion {
		t.Fatalf("schemaVersion = %d, ждали %d", s.SchemaVersion, SchemaVersion)
	}
	title, ok := blockByID(s, "t_b")
	if !ok || len(title.Text) != 1 || title.Text[0].T != "Ваше имя" {
		t.Fatalf("подпись из v1 не доехала спаном: %+v", s.Blocks)
	}
}

// CanonicalV3 идемпотентна: её выход, поданный ей же, даёт тот же байт-в-байт JSON.
// Свойство держит отдачу фронту — иначе автосейв видел бы «изменения» на каждом
// чтении и молотил бы PUT'ами.
func TestCanonicalV3_Idempotent(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":2,"blocks":[
		{"id":"t","groupId":"g","type":"title","text":"Вопрос","settings":{}},
		{"id":"f","groupId":"g","type":"email","settings":{}}
	]}`)
	once, err := CanonicalV3(raw)
	if err != nil {
		t.Fatalf("первый проход: %v", err)
	}
	twice, err := CanonicalV3(once)
	if err != nil {
		t.Fatalf("второй проход: %v", err)
	}
	if string(once) != string(twice) {
		t.Fatalf("не идемпотентна:\n1: %s\n2: %s", once, twice)
	}
}

// Версия из будущего отвергается, а не трактуется как текущая.
func TestValidateSchema_UnknownFutureVersion(t *testing.T) {
	_, err := ValidateSchema(json.RawMessage(`{"schemaVersion":4,"blocks":[]}`))
	if err == nil {
		t.Fatal("v4 должна отвергаться")
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
