package submissions

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Приём ответа и согласие (design/privacy-consent.md §3.4): у формы с включённым
// согласием без галочки ответа нет, а записывается та ревизия, которую видел человек.
func TestSubmit_Consent(t *testing.T) {
	current, older, foreign := uuid.New(), uuid.New(), uuid.New()

	cases := []struct {
		name     string
		required bool // согласие у формы сейчас включено
		sent     uuid.UUID
		wantErr  bool
		want     *uuid.UUID
	}{
		{"включено, галочки нет — отказ", true, uuid.Nil, true, nil},
		{"включено, текущая ревизия", true, current, false, &current},
		// Автор сохранил новую ревизию, пока человек заполнял форму.
		{"включено, прежняя включённая ревизия — пишется она", true, older, false, &older},
		{"включено, чужая ревизия — отказ", true, foreign, true, nil},
		{"выключено, галочки нет", false, uuid.Nil, false, nil},
		{"выключено, прежняя включённая ревизия — пишется", false, older, false, &older},
		{"выключено, чужая ревизия — молча не пишется", false, foreign, false, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pf := validPublishedForm(false)
			if c.required {
				pf.ConsentRevisionID = &current
			}
			store := &fakeSubStore{insertN: 1}
			svc := NewService(nil, fakeTx{},
				fakeForms{pf: pf, consentRevisions: map[uuid.UUID]bool{current: true, older: true}},
				nil, &fakeMailer{}, okPlans(), store, "https://app.test")

			err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{ConsentRevision: c.sent})
			if c.wantErr {
				if !errors.Is(err, domain.ErrValidation) {
					t.Fatalf("err = %v, ожидалась ErrValidation", err)
				}
				if store.inserted {
					t.Fatal("отклонённый ответ дошёл до вставки")
				}
				return
			}
			if err != nil {
				t.Fatalf("Submit: %v", err)
			}
			got := store.lastInsert.ConsentRevisionID
			if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
				t.Fatalf("записана ревизия %v, ожидалась %v", got, c.want)
			}
		})
	}
}
