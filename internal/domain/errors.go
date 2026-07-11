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

	// ErrConflict — оптимистичная блокировка: клиент прислал устаревший updated_at,
	// ресурс изменён параллельно (другая вкладка). Маппится в 409 (ARCHITECTURE §5.1).
	ErrConflict = errors.New("conflict")

	// Аутентификация.
	ErrEmailTaken         = errors.New("email already registered")
	ErrInvalidCredentials = errors.New("invalid email or password")
)
