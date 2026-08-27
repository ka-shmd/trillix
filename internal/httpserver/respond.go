package httpserver

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/ka-shmd/trillix/internal/domain"
)

// errorEnvelope — единый формат ошибок API (ARCHITECTURE §4.4):
// {"error":{"code":"...","message":"...","fields":{...}}}.
type errorEnvelope struct {
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Fields  map[string]string `json:"fields,omitempty"`
}

// WriteJSON сериализует payload в JSON с заданным статусом. Ошибку кодирования
// логирует (заголовки клиенту уже отправлены — тело просто оборвётся).
func WriteJSON(w http.ResponseWriter, r *http.Request, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if payload == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		loggerFrom(r.Context()).Error("encode json response", slog.String("error", err.Error()))
	}
}

// WriteHTML пишет готовый HTML-документ (уже отрендеренный вызывающим) с заданным
// статусом. Ошибку записи логирует (заголовки уже ушли — тело просто оборвётся).
// Content-Type ставит сам; прочие заголовки (Cache-Control) вызывающий выставляет
// на w.Header() до вызова.
func WriteHTML(w http.ResponseWriter, r *http.Request, status int, html []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	if _, err := w.Write(html); err != nil {
		loggerFrom(r.Context()).Error("write html response", slog.String("error", err.Error()))
	}
}

// WriteError — единственное место маппинга доменных ошибок на HTTP-статусы
// (handler'ы своих http.Error не пишут). 5xx не раскрывают внутренний текст
// клиенту, но логируются с request_id.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	status, code := statusForError(err)

	message := humanMessage(err)
	if status >= http.StatusInternalServerError {
		loggerFrom(r.Context()).Error("request failed", slog.String("error", err.Error()))
		message = "internal server error"
	}

	// Пофайловые нарушения (валидация ответа респондента: block_id → сообщение)
	// кладутся в fields конверта — рендерер подсветит конкретные поля.
	var fields domain.AnswerErrors
	if errors.As(err, &fields) {
		WriteJSON(w, r, status, errorEnvelope{Error: errorBody{Code: code, Message: message, Fields: fields}})
		return
	}

	WriteJSON(w, r, status, errorEnvelope{Error: errorBody{Code: code, Message: message}})
}

// humanMessage — текст ошибки БЕЗ служебного префикса сентинела.
//
// Доменные ошибки заворачиваются как fmt.Errorf("%w: человеческий текст", …),
// поэтому err.Error() начинается с текста самого сентинела — «validation failed:
// в первой строке листа…». Этот кусок написан для кода: он английский, он
// повторяет то, что уже сказано полем `code` конверта, и посреди русского
// сообщения на экране выглядит утечкой внутренностей. Режем в одном месте — том
// же, где живёт вся раскладка ошибок на HTTP.
//
// Сообщение БЕЗ префикса (сам сентинел без обёртки) остаётся как есть: у него
// нет человеческой части, и обрезать нечего.
func humanMessage(err error) string {
	msg := err.Error()
	for _, sentinel := range wrappedSentinels {
		prefix := sentinel.Error() + ": "
		if after, found := strings.CutPrefix(msg, prefix); found {
			return after
		}
	}
	return msg
}

// wrappedSentinels — те доменные ошибки, которые оборачивают человеческий текст.
// Список короче таблицы ниже намеренно: у остальных обёртки нет, и проверять их
// на каждом отказе незачем.
var wrappedSentinels = []error{
	domain.ErrValidation,
	domain.ErrConflict,
	domain.ErrPlanRequired,
	domain.ErrFormClosed,
}

// statusForError — единственная таблица соответствия доменных ошибок и HTTP.
func statusForError(err error) (int, string) {
	switch {
	case errors.Is(err, domain.ErrValidation):
		return http.StatusUnprocessableEntity, "validation_failed"
	case errors.Is(err, domain.ErrEmailTaken):
		return http.StatusConflict, "email_taken"
	case errors.Is(err, domain.ErrConflict):
		return http.StatusConflict, "conflict"
	case errors.Is(err, domain.ErrInvalidCredentials):
		return http.StatusUnauthorized, "invalid_credentials"
	case errors.Is(err, domain.ErrUnauthorized):
		return http.StatusUnauthorized, "unauthorized"
	case errors.Is(err, domain.ErrForbidden):
		return http.StatusForbidden, "forbidden"
	case errors.Is(err, domain.ErrNotFound):
		return http.StatusNotFound, "not_found"
	case errors.Is(err, domain.ErrFormClosed):
		return http.StatusGone, "form_closed"
	case errors.Is(err, domain.ErrLinkExpired):
		return http.StatusGone, "link_expired"
	case errors.Is(err, domain.ErrWorkspaceFrozen):
		return http.StatusPaymentRequired, "workspace_frozen"
	case errors.Is(err, domain.ErrPlanRequired):
		return http.StatusPaymentRequired, "plan_required"
	case errors.Is(err, domain.ErrRateLimited):
		return http.StatusTooManyRequests, "rate_limited"
	case errors.Is(err, domain.ErrTooLarge):
		return http.StatusRequestEntityTooLarge, "payload_too_large"
	default:
		return http.StatusInternalServerError, "internal"
	}
}
