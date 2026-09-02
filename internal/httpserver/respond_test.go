package httpserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
)

func TestWriteError_Mapping(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"validation", domain.ErrValidation, http.StatusUnprocessableEntity, "validation_failed"},
		{"email taken", domain.ErrEmailTaken, http.StatusConflict, "email_taken"},
		{"conflict", domain.ErrConflict, http.StatusConflict, "conflict"},
		{"invalid creds", domain.ErrInvalidCredentials, http.StatusUnauthorized, "invalid_credentials"},
		{"unauthorized", domain.ErrUnauthorized, http.StatusUnauthorized, "unauthorized"},
		{"forbidden", domain.ErrForbidden, http.StatusForbidden, "forbidden"},
		{"not found", domain.ErrNotFound, http.StatusNotFound, "not_found"},
		{"rate limited", domain.ErrRateLimited, http.StatusTooManyRequests, "rate_limited"},
		// Отказ по тарифу — свой код и свой статус: кабинет отличает «нужен план»
		// от «нет прав» (403) и от «нет формы» (404), и рисует плашку апгрейда.
		{"plan required", domain.ErrPlanRequired, http.StatusPaymentRequired, "plan_required"},
		{"wrapped validation", fmt.Errorf("%w: bad email", domain.ErrValidation), http.StatusUnprocessableEntity, "validation_failed"},
		{"unknown -> 500", errors.New("boom"), http.StatusInternalServerError, "internal"},
		// Голый сентинел без дописанного текста: объяснять нечем, и наружу идёт
		// та же общая фраза, что у любой пятисотки.
		{"unavailable без текста", domain.ErrUnavailable, http.StatusServiceUnavailable, "unavailable"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/", nil)

			WriteError(rec, req, c.err)

			if rec.Code != c.status {
				t.Fatalf("статус = %d, ожидалось %d", rec.Code, c.status)
			}
			var env errorEnvelope
			if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
				t.Fatalf("тело не JSON: %v", err)
			}
			if env.Error.Code != c.code {
				t.Fatalf("code = %q, ожидалось %q", env.Error.Code, c.code)
			}
			if c.status >= 500 && env.Error.Message != internalMessage {
				t.Fatalf("5xx не должен раскрывать внутренний текст: %q", env.Error.Message)
			}
		})
	}

	// Единственное исключение из правила «5xx молчит»: текст, дописанный к
	// ErrUnavailable, написан ДЛЯ ЧЕЛОВЕКА, и клиент показывает его как есть. Пока
	// он резался вместе с прочими пятисотками, автор формы читал в чате ассистента
	// английское «internal server error» вместо объяснения.
	// Человеку на экран не уходит английского: `code` конверта английский и
	// предназначен коду, а `message` читает автор формы.
	t.Run("общий текст пятисотки — по-русски", func(t *testing.T) {
		rec := httptest.NewRecorder()
		WriteError(rec, httptest.NewRequest(http.MethodGet, "/", nil), errors.New("boom"))

		var env errorEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("тело не JSON: %v", err)
		}
		for _, r := range env.Error.Message {
			if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
				t.Fatalf("в сообщении для человека латиница: %q", env.Error.Message)
			}
		}
	})

	t.Run("503 доносит дописанный текст до клиента", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/", nil)

		WriteError(rec, req, fmt.Errorf("%w: модель сейчас не отвечает, попробуйте ещё раз", domain.ErrUnavailable))

		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("статус = %d, ожидалось 503", rec.Code)
		}
		var env errorEnvelope
		if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
			t.Fatalf("тело не JSON: %v", err)
		}
		if env.Error.Message != "модель сейчас не отвечает, попробуйте ещё раз" {
			t.Fatalf("сообщение = %q, ожидался текст для человека без служебного префикса", env.Error.Message)
		}
	})
}
