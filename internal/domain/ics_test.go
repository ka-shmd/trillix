package domain

import (
	"strings"
	"testing"
	"time"
)

func sampleEvent() CalendarEvent {
	at := time.Date(2026, 9, 11, 8, 0, 0, 0, time.UTC)
	return CalendarEvent{
		UID:       "booking-1@trillix.ru",
		Sequence:  0,
		Method:    ICSRequest,
		Summary:   "Запись: Мария — рисование",
		StartsAt:  at,
		EndsAt:    at.Add(time.Hour),
		Organizer: "noreply@trillix.ru",
		Attendee:  "client@example.com",
		Stamp:     at.Add(-time.Hour),
	}
}

func TestICS_Request(t *testing.T) {
	doc := string(ICS(sampleEvent()))

	for _, want := range []string{
		"BEGIN:VCALENDAR", "METHOD:REQUEST", "UID:booking-1@trillix.ru", "SEQUENCE:0",
		"DTSTART:20260911T080000Z", "DTEND:20260911T090000Z",
		"ORGANIZER:mailto:noreply@trillix.ru",
		"ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:client@example.com",
		"END:VCALENDAR",
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("в документе нет %q", want)
		}
	}
	// Строки разделены CRLF: одиночный \n часть клиентов не разбирает.
	if strings.Contains(strings.ReplaceAll(doc, "\r\n", ""), "\n") {
		t.Error("в документе есть перевод строки без возврата каретки")
	}
	if strings.Contains(doc, "STATUS:CANCELLED") {
		t.Error("живое приглашение помечено отменённым")
	}
}

// Отмена — тот же UID и БОЛЬШИЙ номер редакции: разойдись они, отмена создала бы у
// человека второе событие вместо того, чтобы погасить первое.
func TestICS_Cancel(t *testing.T) {
	e := sampleEvent()
	e.Method = ICSCancel
	e.Sequence = 1
	doc := string(ICS(e))

	for _, want := range []string{"METHOD:CANCEL", "STATUS:CANCELLED", "SEQUENCE:1", "UID:booking-1@trillix.ru"} {
		if !strings.Contains(doc, want) {
			t.Errorf("в документе нет %q", want)
		}
	}
}

func TestICS_EscapesValues(t *testing.T) {
	e := sampleEvent()
	e.Summary = "Запись; отдел, кадры"
	e.Description = "Первая строка\nвторая"
	doc := string(ICS(e))

	if !strings.Contains(doc, `SUMMARY:Запись\; отдел\, кадры`) {
		t.Errorf("точка с запятой и запятая не экранированы:\n%s", doc)
	}
	if !strings.Contains(doc, `\n`) || strings.Contains(doc, "DESCRIPTION:Первая строка\r\nвторая") {
		t.Errorf("перевод строки внутри значения разорвал документ:\n%s", doc)
	}
}

// Длинные строки переносятся, и перенос НЕ рубит кириллическую руну пополам.
func TestICS_FoldsWithoutBreakingRunes(t *testing.T) {
	e := sampleEvent()
	e.Summary = strings.Repeat("я", 100)
	doc := string(ICS(e))

	for _, line := range strings.Split(doc, "\r\n") {
		if len(line) > 75 {
			t.Fatalf("строка длиннее 75 октетов: %d", len(line))
		}
	}
	// Развернём обратно: клиент склеивает продолжения, убирая CRLF+пробел.
	unfolded := strings.ReplaceAll(doc, "\r\n ", "")
	if !strings.Contains(unfolded, "SUMMARY:"+strings.Repeat("я", 100)) {
		t.Fatal("после склейки значение не восстановилось — перенос разрубил руну")
	}
}
