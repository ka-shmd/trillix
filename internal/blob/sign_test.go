package blob

import (
	"encoding/hex"
	"testing"
)

// Регрессионный пин цепочки вывода ключа подписи для фиксированного входа
// (secret/date/region/service). Ловит без Docker случайную поломку HMAC-цепочки
// при рефакторинге. Ожидаемое значение — детерминированный вывод sigv4 для этого
// входа; его *корректность* (что мы действительно совпадаем с AWS/MinIO)
// гарантирует интеграционный round-trip против настоящего MinIO.
func TestDeriveSigningKey_Deterministic(t *testing.T) {
	const (
		secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
		want   = "004aa806e13dae88b9032d9261bcb04c67d023afadd221e6b0d206e1760e0b5e"
	)
	got := hex.EncodeToString(deriveSigningKey(secret, "20120215", "us-east-1", "iam"))
	if got != want {
		t.Fatalf("signing key = %s, want %s", got, want)
	}
}

func TestEmptyPayloadHash(t *testing.T) {
	// sha256("") — константа, которой подписываются GET/DELETE (пустое тело).
	const want = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got := hexSHA256(nil); got != want {
		t.Fatalf("empty payload hash = %s, want %s", got, want)
	}
}

func TestURIEncode(t *testing.T) {
	cases := []struct {
		in          string
		encodeSlash bool
		want        string
	}{
		{"abc", false, "abc"},
		{"-._~", false, "-._~"},
		{"a b", false, "a%20b"},
		{"a+b", false, "a%2Bb"},
		{"100%", false, "100%25"},
		{"ws/deadbeef.png", false, "ws/deadbeef.png"},
		{"ws/deadbeef.png", true, "ws%2Fdeadbeef.png"},
		{"п", false, "%D0%BF"}, // не-ASCII кодируется побайтно в UTF-8
	}
	for _, c := range cases {
		if got := uriEncode(c.in, c.encodeSlash); got != c.want {
			t.Errorf("uriEncode(%q, %v) = %q, want %q", c.in, c.encodeSlash, got, c.want)
		}
	}
}
