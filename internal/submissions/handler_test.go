package submissions

import (
	"testing"

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
