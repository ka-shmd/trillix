package domain

import (
	"strings"
	"testing"
)

func TestNewSlug_LengthAndAlphabet(t *testing.T) {
	for i := 0; i < 1000; i++ {
		s := NewSlug()
		if len(s) != SlugLen {
			t.Fatalf("длина slug = %d, ожидалось %d (%q)", len(s), SlugLen, s)
		}
		for _, r := range s {
			if !strings.ContainsRune(slugAlphabet, r) {
				t.Fatalf("slug %q содержит символ %q вне алфавита", s, r)
			}
		}
	}
}

// Не гарантия отсутствия коллизий (её даёт UNIQUE в БД), а грубая проверка, что
// генератор не выдаёт постоянно одно и то же: 10 000 значений должны быть уникальны.
func TestNewSlug_NoObviousCollisions(t *testing.T) {
	const n = 10_000
	seen := make(map[string]struct{}, n)
	for i := 0; i < n; i++ {
		s := NewSlug()
		if _, dup := seen[s]; dup {
			t.Fatalf("коллизия slug %q на %d-й генерации", s, i)
		}
		seen[s] = struct{}{}
	}
}
