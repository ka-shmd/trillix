package domain

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func ptrInt32(v int32) *int32        { return &v }
func ptrTime(t time.Time) *time.Time { return &t }

func TestValidateCloseSettings_Valid(t *testing.T) {
	cases := map[string]CloseSettings{
		"всё пусто (ничего не задано)":    {},
		"только лимит":                    {ResponseLimit: ptrInt32(100)},
		"только дата":                     {CloseAt: ptrTime(time.Now())},
		"только текст":                    {ClosedMessage: "Приём закрыт, спасибо всем!"},
		"дата в прошлом (закрыть сейчас)": {CloseAt: ptrTime(time.Now().Add(-time.Hour))},
		"текст на границе длины":          {ClosedMessage: strings.Repeat("я", MaxClosedMessageLen)},
		"лимит 1": {ResponseLimit: ptrInt32(1)},
	}
	for name, s := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ValidateCloseSettings(s); err != nil {
				t.Fatalf("ожидались валидные настройки, получена ошибка: %v", err)
			}
		})
	}
}

func TestValidateCloseSettings_Invalid(t *testing.T) {
	cases := map[string]CloseSettings{
		"лимит 0":              {ResponseLimit: ptrInt32(0)},
		"лимит отрицательный":  {ResponseLimit: ptrInt32(-5)},
		"текст длиннее лимита": {ClosedMessage: strings.Repeat("я", MaxClosedMessageLen+1)},
	}
	for name, s := range cases {
		t.Run(name, func(t *testing.T) {
			err := ValidateCloseSettings(s)
			if err == nil {
				t.Fatalf("ожидалась ошибка валидации, получено nil")
			}
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("ожидался ErrValidation (→ 422), получено: %v", err)
			}
		})
	}
}

func TestFormClosed(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Hour)
	future := now.Add(time.Hour)

	cases := []struct {
		name    string
		status  string
		closeAt *time.Time
		limit   *int32
		count   int64
		want    bool
	}{
		{"опубликована без ограничений — открыта", FormStatusPublished, nil, nil, 0, false},
		{"снята вручную — закрыта", FormStatusClosed, nil, nil, 0, true},
		{"черновик — закрыта (не принимает)", FormStatusDraft, nil, nil, 0, true},
		{"дата в прошлом — закрыта", FormStatusPublished, ptrTime(past), nil, 0, true},
		{"дата ровно сейчас — закрыта (ПОСЛЕ включает границу)", FormStatusPublished, ptrTime(now), nil, 0, true},
		{"дата в будущем — открыта", FormStatusPublished, ptrTime(future), nil, 0, false},
		{"лимит не достигнут — открыта", FormStatusPublished, nil, ptrInt32(100), 99, false},
		{"лимит достигнут ровно — закрыта", FormStatusPublished, nil, ptrInt32(100), 100, true},
		{"лимит превышен — закрыта", FormStatusPublished, nil, ptrInt32(100), 101, true},
		{"дата в будущем, но лимит достигнут — закрыта", FormStatusPublished, ptrTime(future), ptrInt32(10), 10, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := FormClosed(c.status, c.closeAt, c.limit, c.count, now); got != c.want {
				t.Fatalf("FormClosed = %v, ожидалось %v", got, c.want)
			}
		})
	}
}

// ClosedByStatusOrDate — то, что приём проверяет ДО вставки: лимит сюда не входит
// (его enforce'ит транзакция под advisory-lock), поэтому достигнутый лимит на этой
// проверке НЕ закрывает форму.
func TestClosedByStatusOrDate_IgnoresLimit(t *testing.T) {
	now := time.Date(2026, 7, 17, 12, 0, 0, 0, time.UTC)
	if ClosedByStatusOrDate(FormStatusPublished, nil, now) {
		t.Fatal("опубликованная без даты — не закрыта до вставки")
	}
	if !ClosedByStatusOrDate(FormStatusClosed, nil, now) {
		t.Fatal("снятая вручную — закрыта до вставки")
	}
	if !ClosedByStatusOrDate(FormStatusPublished, ptrTime(now.Add(-time.Hour)), now) {
		t.Fatal("дата прошла — закрыта до вставки")
	}
}
