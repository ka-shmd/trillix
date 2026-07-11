package domain

import (
	"bytes"
	"testing"

	"github.com/google/uuid"
)

// UUIDv7 обязан быть седьмой версии — на это опираются индексы и сортировка по id.
func TestNewID_Version7(t *testing.T) {
	if v := NewID().Version(); v != 7 {
		t.Fatalf("version = %d, want 7", v)
	}
}

// Главное свойство: последовательно сгенерированные id строго возрастают в
// байтовом (= индексном) порядке, включая множество вызовов внутри одной
// миллисекунды. Заодно проверяется уникальность.
func TestNewID_MonotonicAndUnique(t *testing.T) {
	const n = 10_000
	prev := NewID()
	seen := make(map[uuid.UUID]struct{}, n)
	seen[prev] = struct{}{}
	for i := 1; i < n; i++ {
		cur := NewID()
		if bytes.Compare(cur[:], prev[:]) <= 0 {
			t.Fatalf("id %d не строго возрастает: prev=%s cur=%s", i, prev, cur)
		}
		if _, dup := seen[cur]; dup {
			t.Fatalf("дубликат id на %d: %s", i, cur)
		}
		seen[cur] = struct{}{}
		prev = cur
	}
}
