package submissions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
)

// fakeForms — коллаборатор forms с подставной опубликованной формой.
type fakeForms struct {
	pf forms.PublicForm
}

func (f fakeForms) PublicForm(context.Context, string) (forms.PublicForm, error) {
	return f.pf, nil
}

func (f fakeForms) Get(context.Context, uuid.UUID, uuid.UUID) (forms.Form, error) {
	return forms.Form{}, domain.ErrNotFound
}

func (f fakeForms) Versions(context.Context, uuid.UUID, uuid.UUID) ([]forms.Version, error) {
	return nil, domain.ErrNotFound
}

// Неразбираемая опубликованная схема — это нарушенный инвариант версии (её
// проверяли при публикации), а НЕ ошибка ввода респондента. Ошибка обязана стать
// внутренней: иначе respond.go по сентинелу ErrValidation отдаёт 422 и печатает
// внутренний текст наружу — респондент видит «json: unknown field ...».
//
// Как это ловилось живьём: старый бинарь API против схемы с новым полем
// (thankYouText/redirectUrl) — DisallowUnknownFields не разобрал снапшот, и
// техническая строка доехала до экрана формы.
func TestSubmit_UnparsableVersionSchema_IsInternalNotValidation(t *testing.T) {
	svc := NewService(nil, nil, fakeForms{pf: forms.PublicForm{
		// Опубликованная и открытая (иначе Submit отклонит как закрытую до разбора схемы).
		Status: domain.FormStatusPublished,
		// Поле из будущего формата: DisallowUnknownFields такую схему отвергнет.
		Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[],"fieldFromFuture":"x"}`),
	}}, nil, nil)

	err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{})
	if err == nil {
		t.Fatal("ожидалась ошибка: схема версии не разбирается")
	}
	if errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка помечена ErrValidation → respond.go отдаст 422 с внутренним "+
			"текстом респонденту; ожидалась внутренняя (500): %v", err)
	}
	// Контекст для лога сохраняется — скрывается он уже в respond.go (5xx).
	if !strings.Contains(err.Error(), "slug1") {
		t.Fatalf("ошибка потеряла контекст для лога: %v", err)
	}
}
