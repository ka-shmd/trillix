package domain

import (
	"strings"
	"testing"
)

// Подстановка ответов в письме (mentions.md §10). Таблица кейсов «чем подставляется
// ответ» — ОДНОГО СОСТАВА с web/app/src/entities/mention.test.tsx, и названия кейсов
// совпадают дословно: расхождение двух реализаций одного правила видно диффом, а
// иначе оно не падает — автор просто получает в письме не то, что видел в превью.

// opts — вопрос выбора с готовыми вариантами.
func opts(id string, typ BlockType, pairs ...[2]string) Block {
	b := Block{ID: id, Type: typ}
	for _, p := range pairs {
		b.Settings.Options = append(b.Settings.Options, Option{ID: p[0], Label: p[1]})
	}
	return b
}

// mentionCtx — контекст подстановки по одной схеме и одному ответу.
func mentionCtx(groups [][]Block, answers map[string]any, files map[string]AnswerFile) MentionContext {
	return NewMentionContext(vsg(1, groups...).Schema, ans(answers), files)
}

// chip — спан-подстановка: имя вопроса в тексте, ссылка в ref.
func chip(name, ref string) Span { return Span{T: name, Ref: ref} }

func TestMentionAnswerText(t *testing.T) {
	tests := []struct {
		name   string
		block  Block
		answer any
		want   string
	}{
		{
			name:   "текстовые типы отдают значение как есть",
			block:  Block{ID: "b1", Type: BlockShortText},
			answer: "Кирилл",
			want:   "Кирилл",
		},
		{
			name:   "выбор отдаёт подпись варианта, а не его id",
			block:  opts("b1", BlockSingleChoice, [2]string{"o1", "Красный"}),
			answer: "o1",
			want:   "Красный",
		},
		{
			name:   "несколько вариантов — подписи через запятую",
			block:  opts("b1", BlockMultiChoice, [2]string{"o1", "Красный"}, [2]string{"o2", "Синий"}),
			answer: []string{"o1", "o2"},
			want:   "Красный, Синий",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := mentionCtx([][]Block{grp("Вопрос", tt.block)}, map[string]any{"b1": tt.answer}, nil)
			if got := MentionText([]Span{chip("Вопрос", "b1")}, ctx); got != tt.want {
				t.Fatalf("подстановка = %q, want %q", got, tt.want)
			}
		})
	}
}

// Текст вокруг чипа остаётся текстом, а сам чип НЕ печатается своим именем: имя —
// это то, что видит автор на бланке, а получатель обязан увидеть ответ.
func TestMentionText_ChipReplacedInPlace(t *testing.T) {
	ctx := mentionCtx(
		[][]Block{grp("Имя", Block{ID: "b1", Type: BlockShortText})},
		map[string]any{"b1": "Кирилл"}, nil)

	got := MentionText([]Span{{T: "Ответ от "}, chip("Имя", "b1"), {T: ", смотрите таблицу"}}, ctx)
	if want := "Ответ от Кирилл, смотрите таблицу"; got != want {
		t.Fatalf("текст = %q, want %q", got, want)
	}
}

// Инертность (§4 спеки): неразрешимая ссылка даёт ПУСТОТУ, а не имя вопроса и не
// ошибку. Скрытый условной логикой источник сюда приходит уже вычеркнутым из ответов
// (NormalizeAnswers), поэтому отдельного случая у него нет — он равен «нет ответа».
func TestMentionText_Inert(t *testing.T) {
	groups := [][]Block{grp("Имя", Block{ID: "b1", Type: BlockShortText})}

	tests := []struct {
		name    string
		ref     string
		answers map[string]any
	}{
		{"источника нет в этой версии", "b404", map[string]any{"b1": "Кирилл"}},
		{"на вопрос не ответили", "b1", map[string]any{}},
		{"ответ пуст", "b1", map[string]any{"b1": ""}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := mentionCtx(groups, tt.answers, nil)
			if got := MentionText([]Span{{T: "["}, chip("Имя", tt.ref), {T: "]"}}, ctx); got != "[]" {
				t.Fatalf("подстановка = %q, want пустоту между скобками", got)
			}
		})
	}
}

// «Все ответы» — весь ответ строками «вопрос: ответ», в порядке формы. Вопрос без
// ответа НЕ пропускается (решение владельца 2026-08-30): письмо о неполном ответе
// обязано показывать, чего в нём нет.
func TestMentionText_AllAnswers(t *testing.T) {
	ctx := mentionCtx([][]Block{
		grp("Имя", Block{ID: "b1", Type: BlockShortText}),
		grp("Телефон", Block{ID: "b2", Type: BlockPhone}),
		grp("Цвет", opts("b3", BlockSingleChoice, [2]string{"o1", "Красный"})),
	}, map[string]any{"b1": "Кирилл", "b3": "o1"}, nil)

	got := MentionText([]Span{chip("Все ответы", MentionAllAnswers)}, ctx)
	want := "Имя: Кирилл\nТелефон: без ответа\nЦвет: Красный"
	if got != want {
		t.Fatalf("все ответы =\n%q\nwant\n%q", got, want)
	}
}

// Контентные блоки в «Все ответы» не попадают: у них нет ответов, и строка
// «Заголовок: без ответа» была бы выдумкой.
func TestMentionText_AllAnswersSkipsContent(t *testing.T) {
	ctx := mentionCtx([][]Block{
		content("h1", BlockHeading, "Раздел"),
		grp("Имя", Block{ID: "b1", Type: BlockShortText}),
	}, map[string]any{"b1": "Кирилл"}, nil)

	if got := MentionText([]Span{chip("Все ответы", MentionAllAnswers)}, ctx); got != "Имя: Кирилл" {
		t.Fatalf("все ответы = %q", got)
	}
}

// Вопрос-файл внутри «Все ответы» читается ИМЕНАМИ файлов. Имён нет (сборка без
// файлов, сбой запроса) — вопрос читается как оставшийся без ответа: это честнее
// выдуманной строки про приложенный файл.
func TestMentionText_AllAnswersFiles(t *testing.T) {
	groups := [][]Block{grp("Резюме", Block{ID: "b1", Type: BlockFile})}
	answers := map[string]any{"b1": []string{"f1", "f2"}}

	ctx := mentionCtx(groups, answers, map[string]AnswerFile{
		"f1": {Name: "cv.pdf"}, "f2": {Name: "письмо.docx"},
	})
	if got := MentionText([]Span{chip("Все ответы", MentionAllAnswers)}, ctx); got != "Резюме: cv.pdf, письмо.docx" {
		t.Fatalf("файлы = %q", got)
	}

	ctx = mentionCtx(groups, answers, nil)
	if got := MentionText([]Span{chip("Все ответы", MentionAllAnswers)}, ctx); got != "Резюме: без ответа" {
		t.Fatalf("файлы без имён = %q", got)
	}
}

// ТЕМА письма — одна строка. Перевод строки в ней рвал бы заголовочную секцию
// письма, а приезжает он из недоверенного ввода респондента.
func TestMentionLine_NoCRLF(t *testing.T) {
	ctx := mentionCtx(
		[][]Block{grp("Комментарий", Block{ID: "b1", Type: BlockLongText})},
		map[string]any{"b1": "первая\r\nSubject: подделка\nтретья"}, nil)

	got := MentionLine([]Span{{T: "Ответ: "}, chip("Комментарий", "b1")}, ctx)
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("в тему уехал перевод строки: %q", got)
	}
	if want := "Ответ: первая Subject: подделка третья"; got != want {
		t.Fatalf("тема = %q, want %q", got, want)
	}
}

// Тело письма переводы строк, наоборот, СОХРАНЯЕТ: в нём они и есть текст автора.
func TestMentionText_KeepsAuthorLineBreaks(t *testing.T) {
	ctx := mentionCtx(nil, nil, nil)
	if got := MentionText([]Span{{T: "первая\nвторая"}}, ctx); got != "первая\nвторая" {
		t.Fatalf("тело = %q", got)
	}
}

// Два условия похода в базу за именами файлов. Спрашиваются ДО запроса: письмо
// ставится на самом нагруженном пути продукта.
func TestMentionsAllAnswersAndFileQuestion(t *testing.T) {
	if MentionsAllAnswers([]Span{{T: "текст"}, chip("Имя", "b1")}) {
		t.Fatal("обычный чип принят за «Все ответы»")
	}
	if !MentionsAllAnswers([]Span{chip("Все ответы", MentionAllAnswers)}) {
		t.Fatal("«Все ответы» не найдены")
	}

	withFile := vsg(1, grp("Резюме", Block{ID: "b1", Type: BlockFile})).Schema
	noFile := vsg(1, grp("Имя", Block{ID: "b1", Type: BlockShortText})).Schema
	if !HasFileQuestion(withFile) || HasFileQuestion(noFile) {
		t.Fatal("вопрос-файл определяется неверно")
	}
}
