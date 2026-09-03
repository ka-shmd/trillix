package domain

import (
	"fmt"
	"strings"
	"time"
)

// ПРИГЛАШЕНИЕ В КАЛЕНДАРЬ (фаза 27, design/booking.md §11). Текстовый формат iCalendar
// (RFC 5545), который понимают все почтовые клиенты: вложение с типом text/calendar
// они узнают и вместо скрепки показывают карточку события.
//
// МЕТОД — REQUEST, а не PUBLISH (решение владельца 2026-09-03). REQUEST даёт связь по
// UID: второе письмо с тем же UID, METHOD:CANCEL и бо́льшим SEQUENCE гасит событие у
// обеих сторон, тогда как PUBLISH кладёт на ту сторону копию, к которой наш CANCEL уже
// не применится. Цена названа вслух: ORGANIZER — служебный адрес сервиса (домен, с
// которого мы шлём, автору не принадлежит, и From не перебивается никогда), поэтому
// RSVP получателя уедет на ящик, который его не читает.
//
// Своей библиотеки не заводим: документ — десяток строк фиксированной формы, и правила
// его сборки (перенос строк, экранирование) короче любой зависимости.

// ICSMethod — METHOD документа: приглашение или его отмена.
type ICSMethod string

const (
	ICSRequest ICSMethod = "REQUEST"
	ICSCancel  ICSMethod = "CANCEL"
)

// CalendarEvent — событие календаря для письма о записи.
type CalendarEvent struct {
	// UID — ПОСТОЯННЫЙ идентификатор события: один и тот же у приглашения и у его
	// отмены. Разойдись они — отмена создала бы у человека второе событие вместо
	// того, чтобы погасить первое.
	UID string
	// Sequence — номер редакции. Отмена обязана иметь БОЛЬШИЙ номер, иначе клиент
	// вправе её проигнорировать как устаревшую.
	Sequence int
	Method   ICSMethod
	Summary  string
	StartsAt time.Time
	EndsAt   time.Time
	// Organizer — служебный адрес сервиса; Attendee — тот, кому письмо.
	Organizer string
	Attendee  string
	// Description — что написать в теле события (ссылка на отмену, например).
	Description string
	// Stamp — момент выпуска документа (DTSTAMP). Отдельным полем, а не time.Now():
	// функция чистая и проверяется таблицей.
	Stamp time.Time
}

// ICS собирает документ. Время пишется в UTC (суффикс Z) — так его понимают все
// клиенты и не нужен VTIMEZONE, который иначе пришлось бы выдавать вместе с событием.
func ICS(e CalendarEvent) []byte {
	var b strings.Builder
	line := func(s string) { b.WriteString(foldICS(s)); b.WriteString("\r\n") }

	line("BEGIN:VCALENDAR")
	line("VERSION:2.0")
	// PRODID — кто выпустил документ. Формально обязателен.
	line("PRODID:-//Trillix//Booking//RU")
	line("METHOD:" + string(e.Method))
	line("BEGIN:VEVENT")
	line("UID:" + e.UID)
	line("SEQUENCE:" + fmt.Sprint(e.Sequence))
	line("DTSTAMP:" + icsTime(e.Stamp))
	line("DTSTART:" + icsTime(e.StartsAt))
	line("DTEND:" + icsTime(e.EndsAt))
	line("SUMMARY:" + escapeICS(e.Summary))
	if e.Description != "" {
		line("DESCRIPTION:" + escapeICS(e.Description))
	}
	if e.Organizer != "" {
		line("ORGANIZER:mailto:" + e.Organizer)
	}
	if e.Attendee != "" {
		// RSVP=TRUE — приглашение спрашивает ответ. Ответ уедет ORGANIZER'у, то есть
		// на служебный ящик; см. комментарий у метода.
		line("ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:" + e.Attendee)
	}
	// STATUS:CANCELLED дублирует METHOD:CANCEL — часть клиентов смотрит на одно,
	// часть на другое, и стоить это может ровно одну строку.
	if e.Method == ICSCancel {
		line("STATUS:CANCELLED")
	}
	line("END:VEVENT")
	line("END:VCALENDAR")
	return []byte(b.String())
}

// icsTime — «20260911T080000Z». Только UTC: локальное время потребовало бы VTIMEZONE.
func icsTime(t time.Time) string {
	return t.UTC().Format("20060102T150405Z")
}

// escapeICS экранирует спецсимволы значения (RFC 5545 §3.3.11). Перевод строки внутри
// значения обязан стать литеральным \n: сырой он разорвал бы документ на две строки, и
// вторая перестала бы быть значением.
func escapeICS(v string) string {
	r := strings.NewReplacer(
		"\\", "\\\\",
		";", `\;`,
		",", "\\,",
		"\r\n", "\\n",
		"\n", "\\n",
		"\r", "\\n",
	)
	return r.Replace(v)
}

// foldICS переносит длинные строки: RFC 5545 требует не длиннее 75 ОКТЕТОВ, продолжение
// начинается с пробела. Считаем байты, а не руны, но резать посреди руны нельзя —
// кириллица в UTF-8 двухбайтная, и разрубленный символ превратил бы название формы в
// мусор у получателя.
func foldICS(s string) string {
	const limit = 74 // 75 минус ведущий пробел продолжения
	if len(s) <= limit {
		return s
	}
	var b strings.Builder
	cur := 0
	for i, r := range s {
		size := len(string(r))
		if cur+size > limit {
			b.WriteString("\r\n ")
			cur = 1
		}
		b.WriteString(s[i : i+size])
		cur += size
	}
	return b.String()
}
