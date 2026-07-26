package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// Богатый текст блока (фаза 14, схема v3). Инварианты формата — §2.3
// docs/DESIGN-rich-text.md; зеркало на фронте — formSchema.test.ts, оба набора
// правятся одним PR.

func TestPlainText(t *testing.T) {
	tests := []struct {
		name  string
		spans []Span
		want  string
	}{
		{"пусто", nil, ""},
		{"один кусок", []Span{{T: "абв"}}, "абв"},
		{
			"склейка по кускам — разметка в данные не протекает",
			[]Span{{T: "жир", M: []Mark{MarkBold}}, {T: "но"}, {T: "!", Color: "#c026d3"}},
			"жирно!",
		},
		{"ссылка отдаёт только текст, не адрес", []Span{{T: "политика", Href: "https://a.ru/p"}}, "политика"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := PlainText(tc.spans); got != tc.want {
				t.Fatalf("PlainText = %q, ждали %q", got, tc.want)
			}
		})
	}
}

// Пустая строка даёт ОТСУТСТВИЕ текста, а не кусок с пустым текстом: одно
// представление пустоты, иначе дифф автосейва шумит на ровном месте.
func TestTextFromString(t *testing.T) {
	if got := TextFromString(""); got != nil {
		t.Fatalf("пустая строка дала %+v, ждали nil", got)
	}
	got := TextFromString("абв")
	if len(got) != 1 || got[0].T != "абв" || got[0].M != nil {
		t.Fatalf("подъём строки дал %+v", got)
	}
}

func TestValidateSpans(t *testing.T) {
	long := strings.Repeat("я", MaxTextLen+1)
	tests := []struct {
		name    string
		spans   []Span
		wantErr string // подстрока; пусто — ждём успех
	}{
		{name: "пусто", spans: nil},
		{name: "простой текст", spans: []Span{{T: "абв"}}},
		{
			name:  "все булевы марки на одном куске",
			spans: []Span{{T: "а", M: []Mark{MarkBold, MarkItalic, MarkUnderline, MarkStrike}}},
		},
		{name: "цвет и фон", spans: []Span{{T: "а", Color: "#c026d3", BG: "#ffff00"}}},
		{name: "ссылка", spans: []Span{{T: "а", Href: "https://trillix.ru/p"}}},
		{name: "ссылка http тоже годится", spans: []Span{{T: "а", Href: "http://a.ru"}}},

		{name: "пустой кусок", spans: []Span{{T: ""}}, wantErr: "пустой текст"},
		{
			name:    "кусок пуст в середине — тоже мусор",
			spans:   []Span{{T: "а"}, {T: ""}, {T: "б"}},
			wantErr: "пустой текст",
		},
		{name: "длина считается СУММОЙ по кускам", spans: []Span{{T: long}}, wantErr: "текст длиннее"},
		{
			name: "длина суммируется через несколько кусков",
			spans: []Span{
				{T: strings.Repeat("я", MaxTextLen)},
				{T: "лишний", M: []Mark{MarkBold}},
			},
			wantErr: "текст длиннее",
		},
		{name: "неизвестная марка", spans: []Span{{T: "а", M: []Mark{"blink"}}}, wantErr: "неизвестная марка"},
		{
			name:    "повторяющаяся марка",
			spans:   []Span{{T: "а", M: []Mark{MarkBold, MarkBold}}},
			wantErr: "повторяющаяся марка",
		},
		{name: "цвет словом", spans: []Span{{T: "а", Color: "red"}}, wantErr: "цвет"},
		{name: "цвет в rgb()", spans: []Span{{T: "а", Color: "rgb(1,2,3)"}}, wantErr: "цвет"},
		{name: "цвет в верхнем регистре", spans: []Span{{T: "а", Color: "#C026D3"}}, wantErr: "цвет"},
		{name: "цвет тремя цифрами", spans: []Span{{T: "а", Color: "#abc"}}, wantErr: "цвет"},
		{name: "цвет без решётки", spans: []Span{{T: "а", Color: "c026d3"}}, wantErr: "цвет"},
		{name: "фон проверяется тем же правилом", spans: []Span{{T: "а", BG: "salmon"}}, wantErr: "фон"},
		{
			name:    "ссылка javascript: — XSS на публичном домене формы",
			spans:   []Span{{T: "а", Href: "javascript:alert(1)"}},
			wantErr: "ссылка",
		},
		{name: "ссылка data:", spans: []Span{{T: "а", Href: "data:text/html,x"}}, wantErr: "ссылка"},
		{name: "ссылка относительная", spans: []Span{{T: "а", Href: "/forms/1"}}, wantErr: "ссылка"},
		{name: "ссылка без хоста", spans: []Span{{T: "а", Href: "https://"}}, wantErr: "ссылка"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateSpans(tc.spans)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("ждали успех, получили %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("ждали ошибку про %q, получили успех", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("ошибка %q не содержит %q", err, tc.wantErr)
			}
		})
	}
}

// Второй лимит существует именно потому, что первый перестал быть лимитом: 2000
// кусков по одному символу проходят проверку длины и поехали бы во все три
// поверхности, в CSV и в воронку.
func TestValidateSpans_CountLimitCatchesWhatLengthDoesNot(t *testing.T) {
	spans := make([]Span, MaxSpans+1)
	for i := range spans {
		spans[i] = Span{T: "я"}
	}
	if n := len(PlainText(spans)); n > MaxTextLen {
		t.Fatalf("тест построен неверно: длина %d уже превышает лимит длины", n)
	}
	err := validateSpans(spans)
	if err == nil || !strings.Contains(err.Error(), "спанов") {
		t.Fatalf("ждали отказ по числу спанов, получили %v", err)
	}
	// Ровно на границе — проходит.
	if err := validateSpans(spans[:MaxSpans]); err != nil {
		t.Fatalf("%d спанов должны проходить: %v", MaxSpans, err)
	}
}

// Сквозь ValidateSchema: битый спан — это 422, а не паника и не молчаливый пропуск.
func TestValidateSchema_RichText(t *testing.T) {
	tests := []struct {
		name string
		text string // JSON поля text блока-подписи
		ok   bool
	}{
		{name: "размеченный текст принимается", text: `[{"t":"жир","m":["b"]},{"t":" и цвет","color":"#c026d3"}]`, ok: true},
		{name: "ссылка принимается", text: `[{"t":"политика","href":"https://trillix.ru/privacy"}]`, ok: true},
		{name: "пустой массив принимается", text: `[]`, ok: true},
		{name: "пустой кусок отвергается", text: `[{"t":""}]`},
		{name: "цвет словом отвергается", text: `[{"t":"а","color":"red"}]`},
		{name: "javascript-ссылка отвергается", text: `[{"t":"а","href":"javascript:alert(1)"}]`},
		{name: "строка вместо массива отвергается", text: `"просто строка"`},
		{name: "лишнее поле спана отвергается", text: `[{"t":"а","bold":true}]`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			raw := json.RawMessage(`{"schemaVersion":3,"blocks":[
				{"id":"t","groupId":"g","type":"title","text":` + tc.text + `,"settings":{}},
				{"id":"f","groupId":"g","type":"short_text","settings":{}}
			]}`)
			_, err := ValidateSchema(raw)
			if tc.ok {
				if err != nil {
					t.Fatalf("ждали успех, получили %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("ждали отказ, получили успех")
			}
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("ошибка не ErrValidation (не станет 422): %v", err)
			}
		})
	}
}

// Отвечаемое поле собственного текста не несёт — правило v2 в силе и для спанов.
func TestValidateSchema_NonCarrierRejectsSpans(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":3,"blocks":[
		{"id":"f","groupId":"g","type":"short_text","text":[{"t":"нельзя"}],"settings":{}}
	]}`)
	_, err := ValidateSchema(raw)
	if err == nil || !strings.Contains(err.Error(), "не несёт собственного текста") {
		t.Fatalf("ждали отказ «не несёт собственного текста», получили %v", err)
	}
}
