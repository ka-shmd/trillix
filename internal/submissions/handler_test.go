package submissions

import (
	"encoding/base64"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Курсор листинга — непрозрачная строка: encode→decode возвращает тот же id.
func TestCursorRoundTrip(t *testing.T) {
	id := uuid.New()
	got, err := decodeCursor(encodeCursor(Cursor{ID: id}))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != id {
		t.Fatalf("id после round-trip = %s, ожидался %s", got.ID, id)
	}
}

// Битый курсор — ошибка (транспорт вернёт 422), а не паника/пустой id.
func TestDecodeCursor_Garbage(t *testing.T) {
	for _, s := range []string{"not-base64!!", "cursor", ""} {
		if _, err := decodeCursor(s); err == nil {
			t.Errorf("decodeCursor(%q): ожидалась ошибка, её нет", s)
		}
	}
}

// Курсор черновиков составной: round-trip обязан вернуть и время последней правки,
// и id визита. Потеря любой половины склеила бы страницы не по той границе —
// молча, дублями или пропусками строк.
func TestTimeCursorRoundTrip(t *testing.T) {
	id := uuid.New()
	// Микросекунды — точность timestamptz: округлив их, курсор указал бы на
	// момент, которого в таблице нет.
	at := time.Date(2026, 8, 26, 9, 30, 15, 123456000, time.UTC)
	got, err := decodeTimeCursor(encodeTimeCursor(TimeCursor{At: at, ID: id}))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.ID != id {
		t.Fatalf("id после round-trip = %s, ожидался %s", got.ID, id)
	}
	if !got.At.Equal(at) {
		t.Fatalf("время после round-trip = %s, ожидалось %s", got.At, at)
	}
}

// Битый курсор черновиков — ошибка (422), а не паника и не «первая страница».
func TestDecodeTimeCursor_Garbage(t *testing.T) {
	for _, s := range []string{"not-base64!!", "cursor", "", encodeRaw("нет-разделителя"), encodeRaw("2026-08-26T09:30:15Z|не-uuid")} {
		if _, err := decodeTimeCursor(s); err == nil {
			t.Errorf("decodeTimeCursor(%q): ожидалась ошибка, её нет", s)
		}
	}
}

func encodeRaw(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
