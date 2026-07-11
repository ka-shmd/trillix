package domain

import (
	"crypto/rand"
	"fmt"
)

// slugAlphabet — 64 URL-безопасных символа (nanoid-стиль). Ровно степень двойки,
// поэтому маскирование `b & 63` выбирает символ без modulo-смещения: каждый
// символ равновероятен, энтропия честная.
const slugAlphabet = "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

// SlugLen — длина публичного slug формы. 10 символов из 64-буквенного алфавита
// дают 60 бит энтропии — коллизии астрономически редки; страховкой служит
// UNIQUE-ограничение forms.slug (повтор → ошибка вставки, не тихий дубль).
const SlugLen = 10

// NewSlug возвращает случайный slug для публичной ссылки формы — свой nanoid
// вместо зависимости (internal/CLAUDE.md: десятки строк пишутся руками).
// Паникует лишь при отказе системного источника случайности (как domain.NewID):
// событие катастрофическое и невосстановимое.
func NewSlug() string {
	b := make([]byte, SlugLen)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Errorf("domain: read random for slug: %w", err))
	}
	for i, c := range b {
		b[i] = slugAlphabet[c&63]
	}
	return string(b)
}
