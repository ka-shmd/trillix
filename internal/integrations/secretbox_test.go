package integrations

import (
	"bytes"
	"strings"
	"testing"
)

var testKey = []byte("form-token-secret-of-decent-length")

// Запечатанный токен читается обратно тем же ключом — и НЕ читается другим.
// Второе важнее первого: именно оно означает, что утёкший дамп БД без
// FORM_TOKEN_SECRET не даёт доступа к чужому Диску.
func TestSealToken_Roundtrip(t *testing.T) {
	const token = "1//0gRefreshTokenFromGoogle"

	sealed, err := sealToken(testKey, token)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if bytes.Contains(sealed, []byte(token)) {
		t.Fatal("шифротекст содержит открытый токен")
	}

	got, err := openToken(testKey, sealed)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if got != token {
		t.Fatalf("расшифровано %q, ожидалось %q", got, token)
	}

	if _, err := openToken([]byte("совершенно другой ключ приложения"), sealed); err == nil {
		t.Fatal("токен расшифровался чужим ключом")
	}
}

// Один и тот же токен под тем же ключом даёт РАЗНЫЙ шифротекст: nonce
// случайный. Иначе по базе было бы видно, у кого совпадают подключения.
func TestSealToken_NonceIsRandom(t *testing.T) {
	a, err := sealToken(testKey, "same-token")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	b, err := sealToken(testKey, "same-token")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if bytes.Equal(a, b) {
		t.Fatal("два запечатывания дали одинаковый шифротекст — nonce не случаен")
	}
}

// Порча шифротекста ловится аутентификацией GCM, а не молча даёт мусор.
func TestOpenToken_RejectsTampered(t *testing.T) {
	sealed, err := sealToken(testKey, "token")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	sealed[len(sealed)-1] ^= 0xFF

	if _, err := openToken(testKey, sealed); err == nil {
		t.Fatal("испорченный шифротекст принят")
	}

	if _, err := openToken(testKey, []byte("abc")); err == nil {
		t.Fatal("огрызок короче nonce принят за шифротекст")
	} else if !strings.Contains(err.Error(), "too short") {
		t.Fatalf("ошибка не про длину: %v", err)
	}
}
