package ai

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestAskJSON(t *testing.T) {
	ok := func(json.RawMessage) error { return nil }
	reject := func(msg string) func(json.RawMessage) error {
		return func(json.RawMessage) error { return errors.New(msg) }
	}

	t.Run("годный ответ отдаётся с первой попытки", func(t *testing.T) {
		fake := NewFake(`{"items":[]}`)

		out, err := AskJSON(context.Background(), fake, Request{User: "анкета"}, ok)
		if err != nil {
			t.Fatalf("AskJSON() вернул ошибку: %v", err)
		}
		if string(out) != `{"items":[]}` {
			t.Errorf("ответ = %s", out)
		}
		if n := len(fake.Requests()); n != 1 {
			t.Errorf("вызовов модели = %d, ожидался один", n)
		}
	})

	t.Run("замечание уезжает модели, ответ берётся со второй попытки", func(t *testing.T) {
		fake := NewFake(`{"плохо":true}`, `{"items":[{"type":"email"}]}`)
		calls := 0
		check := func(raw json.RawMessage) error {
			calls++
			if calls == 1 {
				return errors.New("пункт 3: нет вариантов ответа")
			}
			return nil
		}

		out, err := AskJSON(context.Background(), fake, Request{User: "анкета записи"}, check)
		if err != nil {
			t.Fatalf("AskJSON() вернул ошибку: %v", err)
		}
		if !strings.Contains(string(out), "email") {
			t.Errorf("ответ = %s, ожидался ответ второй попытки", out)
		}

		reqs := fake.Requests()
		if len(reqs) != 2 {
			t.Fatalf("вызовов модели = %d, ожидалось два", len(reqs))
		}
		if !strings.Contains(reqs[1].User, "пункт 3: нет вариантов ответа") {
			t.Errorf("во второй запрос не уехало замечание: %q", reqs[1].User)
		}
		if !strings.HasPrefix(reqs[1].User, "анкета записи") {
			t.Errorf("во втором запросе потерялась исходная просьба автора: %q", reqs[1].User)
		}
		if strings.Contains(reqs[0].User, repairPrefix) {
			t.Errorf("первый запрос уже содержит починку: %q", reqs[0].User)
		}
	})

	t.Run("дважды непринятый ответ — ErrRejected с причиной", func(t *testing.T) {
		fake := NewFake(`{"а":1}`, `{"б":2}`)

		_, err := AskJSON(context.Background(), fake, Request{User: "анкета"}, reject("пункт 1: пустой текст"))
		if !errors.Is(err, ErrRejected) {
			t.Fatalf("ошибка = %v, ожидалась ErrRejected", err)
		}
		if !strings.Contains(err.Error(), "пункт 1: пустой текст") {
			t.Errorf("ошибка %q не несёт причину отказа", err)
		}
		if n := len(fake.Requests()); n != 2 {
			t.Errorf("вызовов модели = %d, ожидалось ровно два (починка одна)", n)
		}
	})

	t.Run("отказ провайдера на первой попытке отдаётся как есть", func(t *testing.T) {
		fake := NewFakeReplies(FakeReply{Err: ErrProvider})

		_, err := AskJSON(context.Background(), fake, Request{User: "анкета"}, ok)
		if !errors.Is(err, ErrProvider) {
			t.Fatalf("ошибка = %v, ожидалась ErrProvider", err)
		}
	})

	t.Run("отказ провайдера на починке — ErrRejected с первой причиной", func(t *testing.T) {
		fake := NewFakeReplies(
			FakeReply{Answer: json.RawMessage(`{"а":1}`)},
			FakeReply{Err: ErrProvider},
		)

		_, err := AskJSON(context.Background(), fake, Request{User: "анкета"}, reject("пункт 2: тип не поддерживается"))
		if !errors.Is(err, ErrRejected) {
			t.Fatalf("ошибка = %v, ожидалась ErrRejected", err)
		}
		if !strings.Contains(err.Error(), "пункт 2") {
			t.Errorf("ошибка %q потеряла причину первой попытки", err)
		}
	})
}
