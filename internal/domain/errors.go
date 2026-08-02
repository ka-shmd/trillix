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

	// ErrLinkExpired — одноразовая ссылка больше не годна: по ней уже вошли либо
	// вышел срок (приглашение в пространство, фаза 18). Маппится в 410 Gone —
	// ссылка была настоящей, её существование не скрывается, а действие у
	// человека одно в обоих случаях: попросить новую. Различать «использована» и
	// «протухла» в ответе незачем, и это заодно не даёт перебором выяснять,
	// какие токены существовали.
	ErrLinkExpired = errors.New("link expired")

	// ErrPlanRequired — возможность закрыта тарифом воркспейса (фаза 17).
	// Маппится в 402 Payment Required. Ставится ТОЛЬКО на чтении (воронка,
	// источники): приём ответа респондента не отказывает ни при каком состоянии
	// подписки — там исчерпанная квота помечает строку, а не отвергает её
	// (ADR §10). Тело ответа несёт настоящее число (сколько людей не дошло),
	// чтобы плашка апгрейда не рекламировала пустоту.
	ErrPlanRequired = errors.New("plan required")

	// Аутентификация.
	ErrEmailTaken         = errors.New("email already registered")
	ErrInvalidCredentials = errors.New("invalid email or password")
)
