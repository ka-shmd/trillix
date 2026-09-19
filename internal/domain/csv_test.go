package domain

import (
	"encoding/json"
	"testing"
	"time"
)

// vs — короткий помощник: собрать VersionedSchema из плоского списка блоков.
func vs(version int, blocks ...Block) VersionedSchema {
	return VersionedSchema{Version: version, Schema: FormSchema{SchemaVersion: SchemaVersion, Blocks: blocks}}
}

// grp — вопрос как группа v2 (фаза 8.7): подпись title (если caption != "") +
// отвечаемый блок, общий groupId, id блока сохраняется. Так подпись живёт
// отдельным блоком, как в реальной схеме.
func grp(caption string, b Block) []Block {
	g := "g_" + b.ID
	b.GroupID = g
	if caption == "" {
		return []Block{b}
	}
	return []Block{{ID: "t_" + b.ID, GroupID: g, Type: BlockTitle, Text: TextFromString(caption)}, b}
}

// content — самостоятельный контентный блок (heading/text) своей группой.
func content(id string, t BlockType, text string) []Block {
	return []Block{{ID: id, GroupID: "g_" + id, Type: t, Text: TextFromString(text)}}
}

// vsg — VersionedSchema из групп: склеивает их в плоский список блоков.
func vsg(version int, groups ...[]Block) VersionedSchema {
	var blocks []Block
	for _, g := range groups {
		blocks = append(blocks, g...)
	}
	return vs(version, blocks...)
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
	b1 := Block{ID: "b1", Type: BlockShortText}
	b2 := Block{ID: "b2", Type: BlockShortText}   // только в v1
	b1v2 := Block{ID: "b1", Type: BlockShortText} // переименован
	b3 := Block{ID: "b3", Type: BlockShortText}   // добавлен в v2

	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1, grp("Имя v1", b1), grp("Телефон", b2)),
		vsg(2, grp("Имя v2", b1v2), grp("Город", b3)),
	})

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

// Демо-критерий этапа 16.4: имя вписано → колонка выгрузки называется им, а не
// заголовком вопроса. Проверяется на самой выгрузке, а не на questionLabel: путь
// «имя → заголовок колонки» и есть то, ради чего этап делался, и он должен ломаться
// целиком, если где-то по дороге потеряется поле.
func TestCSVBuilder_HeaderUsesQuestionName(t *testing.T) {
	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1,
			grp("Как вас зовут?", Block{ID: "b1", Type: BlockShortText, Name: "fio"}),
			grp("Ваш город", Block{ID: "b2", Type: BlockShortText}),
		),
	})

	got := bld.Header()
	want := []string{"ID ответа", "Отправлен", "Версия формы", "fio", "Ваш город"}
	if len(got) != len(want) {
		t.Fatalf("заголовок = %v, ожидался %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("колонка %d = %q, ожидалась %q (имя перебивает заголовок)", i, got[i], want[i])
		}
	}
}

// Неотвечаемый блок (text) не становится колонкой CSV — у него нет ответов.
func TestCSVBuilder_ExcludesTextBlocks(t *testing.T) {
	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1, content("intro", BlockText, "Раздел А"), grp("Имя", Block{ID: "name", Type: BlockShortText})),
	})

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
	b1 := Block{ID: "b1", Type: BlockShortText}
	b2 := Block{ID: "b2", Type: BlockShortText}
	b3 := Block{ID: "b3", Type: BlockShortText}
	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1, grp("Имя", b1), grp("Телефон", b2)),
		vsg(2, grp("Имя", b1), grp("Город", b3)),
	})
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
	single := func(label1 string) []Block {
		return grp("Источник", Block{ID: "s", Type: BlockSingleChoice, Settings: BlockSettings{
			Options: []Option{{ID: "o1", Label: label1}, {ID: "o2", Label: "Поиск"}},
		}})
	}
	multi := grp("Интересы", Block{ID: "m", Type: BlockMultiChoice, Settings: BlockSettings{
		Options: []Option{{ID: "a", Label: "Go"}, {ID: "b", Label: "SQL"}},
	}})

	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1, single("Друзья"), multi),
		vsg(2, single("Знакомые"), multi), // o1 переименован в v2
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
// вредоносная подпись и вредоносный ответ респондента приходят уже обезврежены.
func TestCSVBuilder_SanitizesHeaderAndRow(t *testing.T) {
	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1, grp("=cmd|' /C calc'!A1", Block{ID: "b1", Type: BlockShortText})),
	})

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
	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1, grp("Q", Block{ID: "s", Type: BlockSingleChoice, Settings: BlockSettings{
			Options: []Option{{ID: "o1", Label: "A"}},
		}})),
	})
	row := bld.Row("id", time.Now(), 1, ans(map[string]any{"s": "ghost"}))
	if row[3] != "ghost" {
		t.Fatalf("неизвестная опция = %q, ожидался фолбэк «ghost»", row[3])
	}
}

// Файлы в выгрузке: автору нужны ИМЕНА, а не id загрузок и не ссылки. Ссылку сюда
// класть нельзя вовсе — короткая подпись протухнет к моменту открытия файла, а
// вечная раздавала бы чужие персональные данные всякому, кто получил выгрузку.
func TestCSV_FileNamesInsteadOfIDs(t *testing.T) {
	versions := []VersionedSchema{vs(1, grp("Резюме", Block{ID: "cv", Type: BlockFile})...)}

	b := NewCSVBuilder(versions).WithFiles(map[string]AnswerFile{
		"u1": {Name: "резюме.pdf", Size: 100},
		"u2": {Name: "портфолио.zip", Size: 200},
	})
	row := b.Row("s1", time.Unix(0, 0).UTC(), 1, map[string]json.RawMessage{
		"cv": json.RawMessage(`["u1","u2"]`),
	})
	got := row[len(row)-1]
	if got != "резюме.pdf; портфолио.zip" {
		t.Fatalf("ячейка файлов = %q, ждали имена через «; »", got)
	}

	// Строитель без имён (форма без файлов, выгрузка не платит за запрос) не
	// печатает id: пустая ячейка честнее, чем «018f…» в колонке «Резюме».
	plain := NewCSVBuilder(versions).Row("s1", time.Unix(0, 0).UTC(), 1, map[string]json.RawMessage{
		"cv": json.RawMessage(`["u1"]`),
	})
	if cell := plain[len(plain)-1]; cell != "" {
		t.Fatalf("без имён ячейка = %q, ждали пустую", cell)
	}
}

// Ключи колонок идут в том же порядке, что подписи, и метаколонки в них —
// стабильные идентификаторы, а не человеческий текст. По ним интеграция
// сопоставляет колонку внешней таблицы с вопросом: по подписи нельзя —
// переименование вопроса перемешало бы данные.
func TestCSVBuilder_ColumnsMirrorHeader(t *testing.T) {
	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1,
			grp("Имя", Block{ID: "b1", Type: BlockShortText}),
			grp("Почта", Block{ID: "b2", Type: BlockEmail}),
		),
	})

	cols := bld.SheetColumns()
	if len(cols) != len(bld.Header()) {
		t.Fatalf("колонок %d, подписей %d — они разъехались", len(cols), len(bld.Header()))
	}
	want := []SheetColumn{
		{Key: "_id", Label: "ID ответа"},
		{Key: "_submitted_at", Label: "Отправлен"},
		{Key: "_form_version", Label: "Версия формы"},
		{Key: "b1", Label: "Имя"},
		{Key: "b2", Label: "Почта"},
	}
	for i, w := range want {
		if cols[i] != w {
			t.Errorf("колонка %d = %+v, ожидалась %+v", i, cols[i], w)
		}
	}
}

// Строка для внешней таблицы идёт БЕЗ CSV-заглушки: там значения кладутся
// режимом, который их не разбирает, и апостроф остался бы видимым символом.
// Тот же ввод в CSV по-прежнему экранируется — обе защиты живут рядом.
func TestCSVBuilder_SheetRowKeepsRawValues(t *testing.T) {
	bld := NewCSVBuilder([]VersionedSchema{
		vsg(1, grp("=опасная подпись", Block{ID: "b1", Type: BlockShortText})),
	})

	if got := bld.SheetColumns()[3].Label; got != "=опасная подпись" {
		t.Errorf("подпись для таблицы = %q, ожидалась без префикса", got)
	}
	if got := bld.Header()[3]; got != "'=опасная подпись" {
		t.Errorf("подпись для CSV = %q, ожидалась с префиксом", got)
	}

	answers := ans(map[string]any{"b1": "=1+1"})
	if got := bld.SheetRow("018f", time.Now(), 1, answers)[3]; got != "=1+1" {
		t.Errorf("ячейка для таблицы = %q, ожидалась без префикса", got)
	}
	if got := bld.Row("018f", time.Now(), 1, answers)[3]; got != "'=1+1" {
		t.Errorf("ячейка для CSV = %q, ожидалась с префиксом", got)
	}
}

func TestVisitCells(t *testing.T) {
	const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	if got := VisitCells(&VisitMeta{UserAgent: phone, UTMSource: "newsletter"}); got[0] != "newsletter" || got[1] != "Телефон" {
		t.Errorf("ячейки визита: %v", got)
	}
	if got := VisitCells(nil); got[0] != "" || got[1] != "" {
		t.Errorf("ответ без визита: %v", got)
	}
	// Метка источника — ввод посетителя: формула в ней не должна исполниться в Excel.
	if got := VisitCells(&VisitMeta{UTMSource: "=HYPERLINK(1)"}); got[0][0] == '=' {
		t.Errorf("формула в источнике не обезврежена: %q", got[0])
	}
}
