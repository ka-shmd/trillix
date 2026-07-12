package token

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestIssueRoundTrip(t *testing.T) {
	secret := []byte("dev-only-form-token-secret-not-a-real-key")
	now := time.Now().UTC().Truncate(time.Millisecond)

	tok := Issue(secret, now)
	got, err := IssuedAt(secret, tok)
	if err != nil {
		t.Fatalf("IssuedAt: %v", err)
	}
	if !got.Equal(now) {
		t.Fatalf("issuedAt = %s, ожидалось %s", got, now)
	}
}

func TestIssuedAt_TamperedTime_Rejected(t *testing.T) {
	secret := []byte("dev-only-form-token-secret-not-a-real-key")
	tok := Issue(secret, time.Now())

	// Подменяем время (подписанную часть), оставляя подпись — MAC не сойдётся.
	ms, sig, _ := strings.Cut(tok, ".")
	tampered := ms + "1." + sig // другое время, старая подпись
	if _, err := IssuedAt(secret, tampered); !errors.Is(err, ErrInvalid) {
		t.Fatalf("подделанное время принято: err = %v", err)
	}
}

func TestIssuedAt_WrongSecret_Rejected(t *testing.T) {
	tok := Issue([]byte("dev-only-form-token-secret-not-a-real-key"), time.Now())
	if _, err := IssuedAt([]byte("another-sixteen-plus-secret-key!!"), tok); !errors.Is(err, ErrInvalid) {
		t.Fatalf("токен принят с чужим ключом: err = %v", err)
	}
}

func TestIssuedAt_Garbage_Rejected(t *testing.T) {
	secret := []byte("dev-only-form-token-secret-not-a-real-key")
	for _, bad := range []string{"", "no-dot", "notnum.YWJj", "123.not-base64!!"} {
		if _, err := IssuedAt(secret, bad); !errors.Is(err, ErrInvalid) {
			t.Fatalf("мусорный токен %q принят: err = %v", bad, err)
		}
	}
}
