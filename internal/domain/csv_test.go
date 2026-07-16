package domain

import (
	"encoding/json"
	"testing"
	"time"
)

// vs — короткий помощник: собрать VersionedSchema из блоков.
func vs(version int, blocks ...Block) VersionedSchema {
	return VersionedSchema{Version: version, Schema: FormSchema{SchemaVersion: SchemaVersion, Blocks: blocks}}
}

func ans(pairs map[string]any) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(pairs))
	for k, v := range pairs {
		raw, _ := json.Marshal(v)
		out[k] = raw
	}
	return out
}

// Объединение версий: вопрос b2, удалённый в v2, остаётся колонкой; свежая версия
// слева; подпись — из свежайшей версии, где блок есть.
func TestCSVBuilder_UnionColumnsAcrossVersions(t *testing.T) {
	b1 := Block{ID: "b1", Type: BlockShortText, Label: "Имя v1"}
	b2 := Block{ID: "b2", Type: BlockShortText, Label: "Телефон"}  // только в v1
	b1v2 := Block{ID: "b1", Type: BlockShortText, Label: "Имя v2"} // переименован
	b3 := Block{ID: "b3", Type: BlockShortText, Label: "Город"}    // добавлен в v2

	bld := NewCSVBuilder([]VersionedSchema{vs(1, b1, b2), vs(2, b1v2, b3)})

	got := bld.Header()
	want := []string{"ID ответа", "Отправлен", "Версия формы", "Имя v2", "Город", "Телефон"}
	if len(got) != len(want) {
		t.Fatalf("заголовок = %v, ожидался %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("колонка %d = %q, ожидалась %q (порядок/подпись)", i, got[i], want[i])
		}
	}
}

// Неотвечаемый блок (text) не становится колонкой CSV — у него нет ответов.
func TestCSVBuilder_ExcludesTextBlocks(t *testing.T) {
	intro := Block{ID: "intro", Type: BlockText, Label: "Раздел А"}
	name := Block{ID: "name", Type: BlockShortText, Label: "Имя"}

	bld := NewCSVBuilder([]VersionedSchema{vs(1, intro, name)})

	got := bld.Header()
	want := []string{"ID ответа", "Отправлен", "Версия формы", "Имя"}
	if len(got) != len(want) {
		t.Fatalf("заголовок = %v, ожидался без text-колонки %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("колонка %d = %q, ожидалась %q", i, got[i], want[i])
		}
	}
}

// Ответ v1 попадает в колонку выбывшего вопроса; блок, которого нет в версии ответа,
// даёт пустую ячейку.
func TestCSVBuilder_RowRespectsAnswerVersion(t *testing.T) {
	b1 := Block{ID: "b1", Type: BlockShortText, Label: "Имя"}
	b2 := Block{ID: "b2", Type: BlockShortText, Label: "Телефон"}
	b3 := Block{ID: "b3", Type: BlockShortText, Label: "Город"}
	bld := NewCSVBuilder([]VersionedSchema{vs(1, b1, b2), vs(2, b1, b3)})
	// колонки вопросов: [b1 "Имя", b3 "Город", b2 "Телефон"]

	when := time.Date(2026, 7, 12, 10, 0, 0, 0, time.UTC)
	row := bld.Row("018f", when, 1, ans(map[string]any{"b1": "Анна", "b2": "+7900"}))

	// «+7900» начинается с +, поэтому санитизация против formula injection префиксует
	// его апострофом (осознанный размен: числа/телефоны с ведущим +/- уходят текстом).
	want := []string{"018f", "2026-07-12T10:00:00Z", "1", "Анна", "", "'+7900"}
	for i := range want {
		if row[i] != want[i] {
			t.Fatalf("ячейка %d = %q, ожидалась %q", i, row[i], want[i])
		}
	}
}

// Choice выгружается подписями опций (не id), причём из версии ответа: переименование
// опции в v2 не искажает ответ v1. multi_choice — подписи через «; ».
func TestCSVBuilder_ChoiceLabelsFromAnswerVersion(t *testing.T) {
	single := func(label1 string) Block {
		return Block{ID: "s", Type: BlockSingleChoice, Label: "Источник", Settings: BlockSettings{
			Options: []Option{{ID: "o1", Label: label1}, {ID: "o2", Label: "Поиск"}},
		}}
	}
	multi := Block{ID: "m", Type: BlockMultiChoice, Label: "Интересы", Settings: BlockSettings{
		Options: []Option{{ID: "a", Label: "Go"}, {ID: "b", Label: "SQL"}},
	}}

	bld := NewCSVBuilder([]VersionedSchema{
		vs(1, single("Друзья"), multi),
		vs(2, single("Знакомые"), multi), // o1 переименован в v2
	})
	when := time.Now()

	// Ответ v1: o1 → «Друзья» (подпись версии ответа, не свежей «Знакомые»).
	r1 := bld.Row("id1", when, 1, ans(map[string]any{"s": "o1", "m": []string{"a", "b"}}))
	if r1[3] != "Друзья" {
		t.Fatalf("single v1 = %q, ожидалось «Друзья»", r1[3])
	}
	if r1[4] != "Go; SQL" {
		t.Fatalf("multi v1 = %q, ожидалось «Go; SQL»", r1[4])
	}

	// Ответ v2 на тот же o1 → «Знакомые».
	r2 := bld.Row("id2", when, 2, ans(map[string]any{"s": "o1"}))
	if r2[3] != "Знакомые" {
		t.Fatalf("single v2 = %q, ожидалось «Знакомые»", r2[3])
	}
}

// Санитизация ячеек против CSV formula injection.
func TestSanitizeCSVField(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"формула =", "=HYPERLINK(\"http://evil\")", "'=HYPERLINK(\"http://evil\")"},
		{"плюс", "+1+1", "'+1+1"},
		{"минус (число)", "-5", "'-5"},
		{"собака", "@SUM(A1)", "'@SUM(A1)"},
		{"таб", "\tx", "'\tx"},
		{"возврат каретки", "\rx", "'\rx"},
		{"пустая — без изменений", "", ""},
		{"обычный текст", "Анна", "Анна"},
		{"ведущая кириллица (не ASCII)", "–тире", "–тире"}, // U+2013, не триггер
		{"уже с апострофом — идемпотентно", "'=x", "'=x"},
		{"символ в середине — не трогаем", "a=b", "a=b"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := sanitizeCSVField(tt.in); got != tt.want {
				t.Fatalf("sanitizeCSVField(%q) = %q, ожидалось %q", tt.in, got, tt.want)
			}
		})
	}
}

// Санитизация реально подключена в выводе Header и Row (а не только в функции):
// вредоносный label и вредоносный ответ респондента приходят уже обезврежены.
func TestCSVBuilder_SanitizesHeaderAndRow(t *testing.T) {
	blk := Block{ID: "b1", Type: BlockShortText, Label: "=cmd|' /C calc'!A1"}
	bld := NewCSVBuilder([]VersionedSchema{vs(1, blk)})

	if got := bld.Header()[3]; got != "'=cmd|' /C calc'!A1" {
		t.Fatalf("заголовок = %q, ожидался с префиксом '", got)
	}

	row := bld.Row("018f", time.Now(), 1, ans(map[string]any{"b1": "=1+1"}))
	if got := row[3]; got != "'=1+1" {
		t.Fatalf("ячейка ответа = %q, ожидался с префиксом '", got)
	}
}

// Неизвестный id опции (рассинхрон) выгружается как есть — факт ответа не теряется.
func TestCSVBuilder_UnknownOptionIDFallsBackToID(t *testing.T) {
	blk := Block{ID: "s", Type: BlockSingleChoice, Label: "Q", Settings: BlockSettings{
		Options: []Option{{ID: "o1", Label: "A"}},
	}}
	bld := NewCSVBuilder([]VersionedSchema{vs(1, blk)})
	row := bld.Row("id", time.Now(), 1, ans(map[string]any{"s": "ghost"}))
	if row[3] != "ghost" {
		t.Fatalf("неизвестная опция = %q, ожидался фолбэк «ghost»", row[3])
	}
}
