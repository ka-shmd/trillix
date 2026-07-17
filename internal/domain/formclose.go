package domain

import (
	"time"
	"unicode/utf8"
)

// Настройки закрытия формы (фаза 8.5, шаг 4) — живые колонки forms, а НЕ схема:
// схема снапшотится при публикации и внутри версии неизменна, а лимит/дата обязаны
// меняться без перепубликации (ARCHITECTURE §3.4, ADR §10). «Фактически закрыта» не
// хранится, а вычисляется (FormClosed) — status по дате/лимиту не флипается, крон не
// нужен, продление даты переоткрывает мгновенно.

// MaxClosedMessageLen — потолок текста экрана «приём закрыт» (в рунах), как у
// прочих текстов формы-уровня (благодарность, redirect).
const MaxClosedMessageLen = 2000

// Значения колонки forms.status.
const (
	FormStatusDraft     = "draft"
	FormStatusPublished = "published"
	FormStatusClosed    = "closed"
)

// CloseSettings — живые настройки закрытия формы. Все поля необязательны:
// nil/пусто = ограничение не задано.
type CloseSettings struct {
	CloseAt       *time.Time
	ResponseLimit *int32
	ClosedMessage string
}

// ValidateCloseSettings — серверная проверка настроек (инвариант 3, независимо от
// фронта). Чистая функция без HTTP/SQL; нарушение → ErrValidation (→ 422 в
// respond.go). close_at «будущим» не ограничиваем: закрыть форму задним числом
// (моментально) — законный сценарий. response_limit > 0 дублирует БД-CHECK
// намеренно — ошибка ловится осмысленным сообщением до похода в базу.
func ValidateCloseSettings(s CloseSettings) error {
	if s.ResponseLimit != nil && *s.ResponseLimit <= 0 {
		return schemaErr("responseLimit: нужно положительное число")
	}
	if n := utf8.RuneCountInString(s.ClosedMessage); n > MaxClosedMessageLen {
		return schemaErr("closedMessage длиннее %d символов", MaxClosedMessageLen)
	}
	return nil
}

// FormClosed — «форма фактически не принимает ответы»: единый источник правды для
// публичного чтения (показать «приём закрыт») и приёма ответа. Чистая функция.
// Черновик сюда не доходит (публичный слой отдаёт 404 раньше), но на всякий случай
// считается «не принимает». count — число уже принятых ответов (нужно только для
// ветки лимита; читатель считает его лишь при заданном лимите).
func FormClosed(status string, closeAt *time.Time, responseLimit *int32, count int64, now time.Time) bool {
	return ClosedByStatusOrDate(status, closeAt, now) || closedByLimit(responseLimit, count)
}

// ClosedByStatusOrDate — та часть «закрыта», которую приём ответа проверяет ДО
// вставки. Лимит приём enforce'ит транзакционно под advisory-lock (жёсткий кап,
// ADR §10), а не этой — возможно устаревшей — проверкой, поэтому ветка лимита сюда
// не входит. Снята вручную (status != published) или наступила дата → закрыта.
func ClosedByStatusOrDate(status string, closeAt *time.Time, now time.Time) bool {
	return status != FormStatusPublished || (closeAt != nil && !now.Before(*closeAt))
}

func closedByLimit(responseLimit *int32, count int64) bool {
	return responseLimit != nil && count >= int64(*responseLimit)
}
