package domain

import (
	"errors"
	"strings"
	"testing"
)

// Тема и текст письма — СПАНЫ (mentions.md §10), и проверяются тем же валидатором,
// что текст блока полотна: те же марки, тот же запрет пары «ссылка + подстановка».
// Отличие одно — свои потолки длины, и оба считаются суммой по кускам: строка,
// порезанная редактором на двадцать кусков, обязана мериться как один текст.
func TestValidateNotifyEmail_Spans(t *testing.T) {
	// Текст из ДВУХ кусков: потолок, считающий длину одного куска, такой текст
	// пропустил бы. Кусков именно два, а не n, чтобы не упереться в MaxSpans —
	// иначе тест мерил бы число кусков, а не длину.
	long := func(n int) []Span {
		return []Span{{T: strings.Repeat("а", n/2)}, {T: strings.Repeat("а", n-n/2)}}
	}

	tests := []struct {
		name string
		n    NotifyEmail
		ok   bool
	}{
		{
			name: "чип в теме и в тексте",
			n: NotifyEmail{
				Subject: []Span{{T: "Ответ от "}, {T: "Имя", Ref: "b1"}},
				Body:    []Span{{T: "Все ответы", Ref: MentionAllAnswers}},
			},
			ok: true,
		},
		{"пустая настройка", NotifyEmail{}, true},
		{
			name: "ссылка и подстановка на одном куске",
			n:    NotifyEmail{Body: []Span{{T: "Имя", Ref: "b1", Href: "https://example.com"}}},
		},
		{
			name: "неизвестная марка",
			n:    NotifyEmail{Body: []Span{{T: "текст", M: []Mark{"blink"}}}},
		},
		{
			name: "пустой кусок",
			n:    NotifyEmail{Subject: []Span{{T: ""}}},
		},
		{
			name: "тема длиннее своего потолка, порезанная на два куска",
			n:    NotifyEmail{Subject: long(MaxNotifySubjectLen + 1)},
		},
		{
			name: "текст длиннее своего потолка",
			n:    NotifyEmail{Body: long(MaxNotifyBodyLen + 1)},
		},
		{
			// Потолок темы СВОЙ, а не общий с текстом блока: 201 символ проходит
			// проверку спанов полотна (там 2000) и обязан упасть здесь.
			name: "тема ровно на своём потолке",
			n:    NotifyEmail{Subject: long(MaxNotifySubjectLen)},
			ok:   true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateNotifyEmail(&tt.n)
			switch {
			case tt.ok && err != nil:
				t.Fatalf("настройка отвергнута: %v", err)
			case !tt.ok && err == nil:
				t.Fatal("негодная настройка принята")
			case !tt.ok && !errors.Is(err, ErrValidation):
				t.Fatalf("ошибка не доменная: %v", err)
			case !tt.ok && !strings.Contains(err.Error(), "notifyEmail"):
				t.Fatalf("ошибка не называет настройку: %v", err)
			}
		})
	}
}

// Пустота у настройки одна: массив без кусков и отсутствие настройки — одно
// состояние, и второе в базу не попадает.
func TestNotifyEmail_EmptyWithSpans(t *testing.T) {
	if !(&NotifyEmail{Subject: []Span{}, Body: nil}).Empty() {
		t.Fatal("пустые спаны обязаны считаться отсутствием настройки")
	}
	if (&NotifyEmail{Body: TextFromString("текст")}).Empty() {
		t.Fatal("настройка с текстом считается пустой")
	}
}
