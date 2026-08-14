package auth

import (
	"encoding/base32"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Вектор RFC 6238 (приложение B): секрет "12345678901234567890" в ASCII,
// SHA-1. Сверка с внешним источником, а не с собственной реализацией: тест,
// написанный по своему же коду, подтверждает только то, что код не изменился.
func TestTOTPCode_RFC6238Vectors(t *testing.T) {
	secret := []byte("12345678901234567890")
	cases := map[int64]string{
		1:         "287082", // T = 59
		37037036:  "081804", // T = 1111111109
		37037037:  "050471", // T = 1111111111
		41152263:  "005924", // T = 1234567890
		66666666:  "279037", // T = 2000000000
		666666666: "353130", // T = 20000000000
	}
	for step, want := range cases {
		if got := totpCode(secret, step); got != want {
			t.Errorf("шаг %d: код = %s, ожидался %s", step, got, want)
		}
	}
}

func TestVerifyTOTP_Window(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Unix(1_700_000_000, 0)
	current := now.Unix() / 30

	cases := []struct {
		name string
		step int64
		want bool
	}{
		{"текущий шаг", current, true},
		{"предыдущий (часы телефона отстают)", current - 1, true},
		{"следующий (часы спешат)", current + 1, true},
		{"два шага назад", current - 2, false},
		{"два шага вперёд", current + 2, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, ok := verifyTOTP(secret, totpCode(secret, c.step), now)
			if ok != c.want {
				t.Fatalf("принят = %v, ожидалось %v", ok, c.want)
			}
		})
	}
}

func TestVerifyTOTP_ReturnsMatchedStep(t *testing.T) {
	// Номер шага — не деталь: по нему вызывающий помечает код израсходованным,
	// и без верного номера защита от повтора отмечала бы не тот шаг.
	secret := []byte("12345678901234567890")
	now := time.Unix(1_700_000_000, 0)
	want := now.Unix()/30 - 1

	got, ok := verifyTOTP(secret, totpCode(secret, want), now)
	if !ok || got != want {
		t.Fatalf("шаг = %d (ok=%v), ожидался %d", got, ok, want)
	}
}

func TestVerifyTOTP_RejectsGarbage(t *testing.T) {
	secret := []byte("12345678901234567890")
	now := time.Now()
	for _, code := range []string{"", "12345", "1234567", "abcdef", "  "} {
		if _, ok := verifyTOTP(secret, code, now); ok {
			t.Errorf("код %q принят", code)
		}
	}
}

func TestVerifyTOTP_AcceptsCodeWithSpaces(t *testing.T) {
	// Код переписывают с экрана телефона — окружающие пробелы прощаем.
	secret := []byte("12345678901234567890")
	now := time.Now()
	code := totpCode(secret, now.Unix()/30)
	if _, ok := verifyTOTP(secret, " "+code+" ", now); !ok {
		t.Fatal("код с пробелами отвергнут")
	}
}

func TestEncodeSecretAndOtpauthURL(t *testing.T) {
	secret, err := newTOTPSecret()
	if err != nil {
		t.Fatalf("newTOTPSecret: %v", err)
	}
	if len(secret) != totpSecretBytes {
		t.Fatalf("длина секрета = %d байт, ожидалось %d", len(secret), totpSecretBytes)
	}

	shown := encodeSecret(secret)
	// Человек вводит секрет руками: пробелы для читаемости, но декодируется он
	// после их снятия — иначе приложение не примет.
	raw := strings.ReplaceAll(shown, " ", "")
	decoded, err := base32NoPad.DecodeString(raw)
	if err != nil {
		t.Fatalf("показанный секрет не декодируется: %v", err)
	}
	if string(decoded) != string(secret) {
		t.Fatal("показанный секрет не совпадает с исходным")
	}
	if strings.Contains(raw, "=") {
		t.Error("в секрете остался padding — часть аутентификаторов его не принимает")
	}

	u, err := url.Parse(otpauthURL("ivan@example.com", secret))
	if err != nil {
		t.Fatalf("ссылка не разбирается: %v", err)
	}
	if u.Scheme != "otpauth" || u.Host != "totp" {
		t.Fatalf("схема ссылки = %s://%s", u.Scheme, u.Host)
	}
	q := u.Query()
	if q.Get("secret") != base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret) {
		t.Error("в ссылке не тот секрет")
	}
	if q.Get("algorithm") != "SHA1" || q.Get("digits") != "6" || q.Get("period") != "30" {
		t.Errorf("параметры ссылки разошлись с реализацией: %v", q)
	}
}

func TestSealOpenSecret_RoundTrip(t *testing.T) {
	key := []byte("form-token-secret-not-a-real-key")
	secret, err := newTOTPSecret()
	if err != nil {
		t.Fatalf("newTOTPSecret: %v", err)
	}

	sealed, err := sealSecret(key, secret)
	if err != nil {
		t.Fatalf("sealSecret: %v", err)
	}
	// Дамп базы не должен давать секрет: в колонке лежит шифротекст.
	if strings.Contains(string(sealed), string(secret)) {
		t.Fatal("секрет лежит в колонке открытым текстом")
	}

	opened, err := openSecret(key, sealed)
	if err != nil {
		t.Fatalf("openSecret: %v", err)
	}
	if string(opened) != string(secret) {
		t.Fatal("расшифрованный секрет не совпадает с исходным")
	}

	// Чужой ключ не открывает: GCM аутентифицирует, а не просто расшифровывает.
	if _, err := openSecret([]byte("another-secret-entirely-x"), sealed); err == nil {
		t.Fatal("секрет открылся чужим ключом")
	}
	// Порча шифротекста тоже ловится.
	sealed[len(sealed)-1] ^= 0xff
	if _, err := openSecret(key, sealed); err == nil {
		t.Fatal("испорченный шифротекст открылся")
	}
}

func TestNewRecoveryCodes_CountAndUniqueness(t *testing.T) {
	plain, hashes, err := newRecoveryCodes()
	if err != nil {
		t.Fatalf("newRecoveryCodes: %v", err)
	}
	if len(plain) != recoveryCodeCount || len(hashes) != recoveryCodeCount {
		t.Fatalf("кодов %d, хешей %d, ожидалось по %d", len(plain), len(hashes), recoveryCodeCount)
	}
	seen := map[string]bool{}
	for i, code := range plain {
		if seen[code] {
			t.Fatalf("код %q выдан дважды", code)
		}
		seen[code] = true
		// Хеш обязан сходиться с тем, что посчитается при вводе кода руками.
		if string(hashes[i]) != string(hashRecoveryCode(code)) {
			t.Fatalf("хеш кода %d не сходится с hashRecoveryCode", i)
		}
	}
}

func TestHashRecoveryCode_NormalizesInput(t *testing.T) {
	// Код переписывают с экрана: регистр и пробелы человеку прощаются, иначе
	// «резервный код» перестаёт быть резервным ровно в тот момент, когда нужен.
	want := hashRecoveryCode("ABCDEFGHIJ")
	for _, variant := range []string{"abcdefghij", " ABCDEFGHIJ ", "ABCDE FGHIJ"} {
		if string(hashRecoveryCode(variant)) != string(want) {
			t.Errorf("вариант %q дал другой хеш", variant)
		}
	}
}
