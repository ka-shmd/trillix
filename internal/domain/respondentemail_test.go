package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// Формат бланка тот же, что у письма владельцу, поэтому здесь проверяется только
// СВОЁ: идентификатор источника и то, что остальные поля действительно доехали до
// общего валидатора спанов, а не остались без проверки.
func TestValidateRespondentEmail(t *testing.T) {
	long := func(n int) []Span {
		return []Span{{T: strings.Repeat("а", n/2)}, {T: strings.Repeat("а", n-n/2)}}
	}

	tests := []struct {
		name string
		r    RespondentEmail
		ok   bool
	}{
		{
			name: "источник, чип в теме и в тексте",
			r: RespondentEmail{
				SourceBlockID: "b1",
				Subject:       []Span{{T: "Спасибо, "}, {T: "Имя", Ref: "b2"}},
				Body:          []Span{{T: "Все ответы", Ref: MentionAllAnswers}},
			},
			ok: true,
		},
		{"пустая настройка", RespondentEmail{}, true},
		{
			// Бланк без источника валиден: автор настроил текст, а вопрос выберет
			// следующей правкой. Не уйдёт такое письмо на отправке, а не на 422.
			name: "текст без источника",
			r:    RespondentEmail{Body: []Span{{T: "Спасибо!"}}},
			ok:   true,
		},
		{
			name: "источник длиннее потолка идентификатора",
			r:    RespondentEmail{SourceBlockID: strings.Repeat("b", MaxIDLen+1)},
		},
		{
			name: "битый Reply-To",
			r:    RespondentEmail{ReplyTo: "не адрес"},
		},
		{
			name: "Reply-To с именем",
			r:    RespondentEmail{ReplyTo: "Кирилл <k@example.com>"},
		},
		{
			name: "тема длиннее своего потолка, порезанная на два куска",
			r:    RespondentEmail{Subject: long(MaxNotifySubjectLen + 1)},
		},
		{
			name: "текст длиннее своего потолка",
			r:    RespondentEmail{Body: long(MaxNotifyBodyLen + 1)},
		},
		{
			name: "ссылка и подстановка на одном куске",
			r:    RespondentEmail{Body: []Span{{T: "Имя", Ref: "b1", Href: "https://example.com"}}},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateRespondentEmail(&tt.r)
			switch {
			case tt.ok && err != nil:
				t.Fatalf("настройка отвергнута: %v", err)
			case !tt.ok && err == nil:
				t.Fatal("негодная настройка принята")
			case !tt.ok && !errors.Is(err, ErrValidation):
				t.Fatalf("ошибка не доменная: %v", err)
			case !tt.ok && !strings.Contains(err.Error(), "respondentEmail"):
				t.Fatalf("ошибка не называет настройку: %v", err)
			}
		})
	}
}

// Пустота у настройки одна, и источник в неё входит: бланк, где выбран только
// вопрос, пустым уже не является — иначе он не доехал бы до базы.
func TestRespondentEmail_Empty(t *testing.T) {
	if !(&RespondentEmail{Subject: []Span{}, Body: nil}).Empty() {
		t.Fatal("пустые спаны обязаны считаться отсутствием настройки")
	}
	if (&RespondentEmail{SourceBlockID: "b1"}).Empty() {
		t.Fatal("выбранный источник считается пустой настройкой")
	}
}

// Адресат письма. Все случаи «письма нет» обязаны давать ОДНО И ТО ЖЕ — пустую
// строку: путь отправки различает их только логом, а не поведением.
func TestRespondentAddress(t *testing.T) {
	schema := FormSchema{Blocks: []Block{
		{ID: "mail", GroupID: "g1", Type: BlockEmail},
		{ID: "name", GroupID: "g2", Type: BlockShortText},
	}}
	answers := func(pairs map[string]string) map[string]json.RawMessage {
		out := make(map[string]json.RawMessage, len(pairs))
		for k, v := range pairs {
			raw, err := json.Marshal(v)
			if err != nil {
				t.Fatalf("ответ %q не сериализуется: %v", k, err)
			}
			out[k] = raw
		}
		return out
	}

	tests := []struct {
		name    string
		source  string
		answers map[string]json.RawMessage
		want    string
	}{
		{
			name:    "ответ на выбранный вопрос",
			source:  "mail",
			answers: answers(map[string]string{"mail": "k@example.com"}),
			want:    "k@example.com",
		},
		{
			name:    "источник не выбран",
			answers: answers(map[string]string{"mail": "k@example.com"}),
		},
		{
			name:    "источник удалён из схемы",
			source:  "gone",
			answers: answers(map[string]string{"mail": "k@example.com"}),
		},
		{
			// Источником назначен короткий текст: значение уходит в заголовок To,
			// и произвольная строка респондента в нём — дыра, а не неудобство.
			name:    "источник не типа email",
			source:  "name",
			answers: answers(map[string]string{"name": "k@example.com"}),
		},
		{
			name:    "на вопрос не ответили",
			source:  "mail",
			answers: answers(map[string]string{"name": "Кирилл"}),
		},
		{
			name:    "ответ пуст",
			source:  "mail",
			answers: answers(map[string]string{"mail": ""}),
		},
		{
			name:    "ответ не разбирается как адрес",
			source:  "mail",
			answers: answers(map[string]string{"mail": "нет-собаки"}),
		},
		{
			// Заголовок To собирается из этой строки: перевод строки в ней разорвал
			// бы заголовочную секцию письма.
			name:    "адрес с именем и переводом строки",
			source:  "mail",
			answers: answers(map[string]string{"mail": "Кирилл <k@example.com>\r\nBcc: chuzhoy@example.com"}),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := RespondentAddress(&RespondentEmail{SourceBlockID: tt.source}, schema, tt.answers)
			if got != tt.want {
				t.Fatalf("адрес %q, ожидался %q", got, tt.want)
			}
		})
	}
	if got := RespondentAddress(nil, schema, nil); got != "" {
		t.Fatalf("настройки нет, а адрес %q", got)
	}
}

// Адрес служебного письма записи: бланк квитанции, если он есть, иначе первый
// email-вопрос формы. Без адреса нет ссылки отмены, то есть места не вернуть.
func TestBookingAddress(t *testing.T) {
	schema := FormSchema{Blocks: []Block{
		{ID: "e1", GroupID: "g1", Type: BlockEmail},
		{ID: "e2", GroupID: "g2", Type: BlockEmail},
		{ID: "s1", GroupID: "g3", Type: BlockShortText},
	}}
	answers := map[string]json.RawMessage{
		"e1": json.RawMessage(`"first@example.com"`),
		"e2": json.RawMessage(`"second@example.com"`),
	}

	if got := BookingAddress(nil, schema, answers); got != "first@example.com" {
		t.Fatalf("без бланка адрес %q, ожидался первый email-вопрос", got)
	}
	blank := &RespondentEmail{SourceBlockID: "e2"}
	if got := BookingAddress(blank, schema, answers); got != "second@example.com" {
		t.Fatalf("с бланком адрес %q, ожидался названный в нём вопрос", got)
	}
	// Ответа нет — письма нет, и это не ошибка: вопрос про почту необязателен.
	if got := BookingAddress(nil, schema, map[string]json.RawMessage{}); got != "" {
		t.Fatalf("адрес %q при пустых ответах", got)
	}
	// Мусор вместо адреса не отправляется: письмо уходит с нашего домена.
	bad := map[string]json.RawMessage{"e1": json.RawMessage(`"Аня <a@example.com>"`)}
	if got := BookingAddress(nil, schema, bad); got != "" {
		t.Fatalf("адрес %q — строка с именем адресом не является", got)
	}
}
