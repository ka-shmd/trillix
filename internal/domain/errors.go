package domain

import "errors"

// Доменные ошибки-сентинелы. Единственное место маппинга на HTTP-статусы —
// httpserver/respond.go; handler'ы свои http.Error не пишут (internal/CLAUDE.md).
// Сервисы возвращают эти ошибки (при необходимости обёрнутые контекстом через %w).
var (
	ErrNotFound     = errors.New("not found")
	ErrForbidden    = errors.New("forbidden")
	ErrValidation   = errors.New("validation failed")
	ErrUnauthorized = errors.New("unauthorized")
	ErrRateLimited  = errors.New("too many requests")

	// ErrTooLarge — тело запроса превысило потолок (MaxBytesReader). Маппится в 413.
	// Приём ответа ограничивает тело 256 КБ (ARCHITECTURE §4.4, инвариант 3).
	ErrTooLarge = errors.New("request entity too large")

	// ErrConflict — оптимистичная блокировка: клиент прислал устаревший updated_at,
	// ресурс изменён параллельно (другая вкладка). Маппится в 409 (ARCHITECTURE §5.1).
	ErrConflict = errors.New("conflict")

	// ErrFormClosed — форма больше не принимает ответы (снята вручную, наступила дата
	// закрытия или достигнут лимит; фаза 8.5 шаг 4). Маппится в 410 Gone — форма была
	// публичной, поэтому её существование не скрывается (инвариант 5 распространяется
	// только на черновик → 404). Рендерер по этому коду показывает «приём закрыт».
	ErrFormClosed = errors.New("form closed")

	// Аутентификация.
	ErrEmailTaken         = errors.New("email already registered")
	ErrInvalidCredentials = errors.New("invalid email or password")
)
