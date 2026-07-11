package auth

import (
	"strings"
	"testing"
)

func TestHashPassword_RoundTrip(t *testing.T) {
	const pw = "correct horse battery staple"
	hash, err := HashPassword(pw)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}

	ok, err := VerifyPassword(hash, pw)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if !ok {
		t.Fatal("верный пароль не прошёл проверку")
	}

	ok, err = VerifyPassword(hash, "wrong password")
	if err != nil {
		t.Fatalf("VerifyPassword (wrong): %v", err)
	}
	if ok {
		t.Fatal("неверный пароль прошёл проверку")
	}
}

// Соль случайна: два хеша одного пароля обязаны различаться, иначе одинаковые
// пароли видны в дампе БД.
func TestHashPassword_UniqueSalt(t *testing.T) {
	a, err := HashPassword("same")
	if err != nil {
		t.Fatalf("HashPassword a: %v", err)
	}
	b, err := HashPassword("same")
	if err != nil {
		t.Fatalf("HashPassword b: %v", err)
	}
	if a == b {
		t.Fatal("два хеша одного пароля совпали — соль не случайна")
	}
}

// Параметры OWASP (ARCHITECTURE §4.5) едут в самом хеше.
func TestHashPassword_EncodesOWASPParams(t *testing.T) {
	hash, err := HashPassword("x")
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=65536,t=3,p=1$") {
		t.Fatalf("неожиданный формат/параметры хеша: %s", hash)
	}
}

func TestVerifyPassword_MalformedHash(t *testing.T) {
	cases := map[string]string{
		"мусор":           "not a hash at all",
		"чужой алгоритм":  "$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA",
		"битые параметры": "$argon2id$v=19$m=abc,t=3,p=1$c2FsdA$aGFzaA",
		"неверная версия": "$argon2id$v=13$m=65536,t=3,p=1$c2FsdA$aGFzaA",
		"не-base64 соль":  "$argon2id$v=19$m=65536,t=3,p=1$!!!$aGFzaA",
		"мало сегментов":  "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA",
	}
	for name, h := range cases {
		t.Run(name, func(t *testing.T) {
			ok, err := VerifyPassword(h, "whatever")
			if ok {
				t.Fatal("битый хеш неожиданно прошёл проверку")
			}
			if err != ErrInvalidHash {
				t.Fatalf("err = %v, want ErrInvalidHash", err)
			}
		})
	}
}
