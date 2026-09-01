package forms

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestUnlockTokenRoundTrip(t *testing.T) {
	secret := deriveUnlockSecret([]byte("form-token-secret-long-enough-32b"))
	formID := uuid.New()
	sealed := []byte("шифротекст пароля")
	now := time.Now()
	tok := issueUnlockToken(secret, formID, sealed, now.Add(time.Hour))

	if !validUnlockToken(secret, tok, formID, sealed, now) {
		t.Fatal("свежий токен своей формы обязан приниматься")
	}
}

func TestUnlockTokenRejects(t *testing.T) {
	secret := deriveUnlockSecret([]byte("form-token-secret-long-enough-32b"))
	other := deriveUnlockSecret([]byte("совершенно другой секрет приложения"))
	formID := uuid.New()
	sealed := []byte("шифротекст пароля")
	now := time.Now()
	tok := issueUnlockToken(secret, formID, sealed, now.Add(time.Hour))

	tests := []struct {
		name   string
		secret []byte
		tok    string
		formID uuid.UUID
		sealed []byte
		now    time.Time
	}{
		// Главная проверка: токен привязан к ФОРМЕ. Без неё один известный пароль
		// открывал бы все формы сервиса разом.
		{"токен чужой формы", secret, tok, uuid.New(), sealed, now},
		{"срок вышел", secret, tok, formID, sealed, now.Add(2 * time.Hour)},
		{"подписан другим секретом", other, tok, formID, sealed, now},
		{"подпись подделана", secret, tok[:len(tok)-4] + "AAAA", formID, sealed, now},
		// Подмена id в готовом токене: payload переписан, подпись осталась старой.
		{"id формы подменён", secret, uuid.New().String() + tok[strings.Index(tok, "."):], formID, sealed, now},
		{"мусор вместо токена", secret, "не токен", formID, sealed, now},
		{"пусто", secret, "", formID, sealed, now},
		// Ненастроенный секрет не пускает никого: пароль стоит, открыть нечем.
		{"секрета нет", nil, tok, formID, sealed, now},
		// Пароль сменился — подпись пересчитывается по новому шифротексту и не сходится.
		{"пароль сменился", secret, tok, formID, []byte("другой шифротекст"), now},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if validUnlockToken(tt.secret, tt.tok, tt.formID, tt.sealed, tt.now) {
				t.Fatal("токен обязан быть отвергнут")
			}
		})
	}
}

// Секрет разблокировки обязан отличаться от секрета токена формы: утечка одного
// применения не должна бить по второму (тот же довод, что у токена печати).
func TestUnlockSecretIsDerived(t *testing.T) {
	base := []byte("form-token-secret-long-enough-32b")
	derived := deriveUnlockSecret(base)
	if string(derived) == string(base) {
		t.Fatal("секрет разблокировки обязан быть производным, а не тем же самым")
	}
	if deriveUnlockSecret(nil) != nil {
		t.Fatal("без базового секрета производного не бывает")
	}
}

func TestPasswordSealRoundTrip(t *testing.T) {
	key := []byte("form-token-secret-long-enough-32b")
	const plain = "секрет для коллег"

	sealed, err := sealPassword(key, plain)
	if err != nil {
		t.Fatalf("sealPassword: %v", err)
	}
	if strings.Contains(string(sealed), plain) {
		t.Fatal("пароль обязан лежать шифротекстом, а не открытым текстом")
	}
	got, err := openPassword(key, sealed)
	if err != nil {
		t.Fatalf("openPassword: %v", err)
	}
	if got != plain {
		t.Fatalf("пароль не пережил круг: %q != %q", got, plain)
	}
}

func TestPasswordSealRejects(t *testing.T) {
	key := []byte("form-token-secret-long-enough-32b")
	sealed, err := sealPassword(key, "пароль")
	if err != nil {
		t.Fatalf("sealPassword: %v", err)
	}

	// Чужой ключ: ровно то, что случится при ротации FORM_TOKEN_SECRET.
	if _, err := openPassword([]byte("другой секрет приложения, тоже длинный"), sealed); err == nil {
		t.Fatal("чужой ключ не имеет права расшифровать пароль")
	}
	// Порча шифротекста: GCM аутентифицирует, а не только шифрует.
	broken := append([]byte(nil), sealed...)
	broken[len(broken)-1] ^= 0xFF
	if _, err := openPassword(key, broken); err == nil {
		t.Fatal("испорченный шифротекст обязан быть отвергнут")
	}
	// Ненастроенный секрет — отказ, а не запись открытым текстом.
	if _, err := sealPassword(nil, "пароль"); err == nil {
		t.Fatal("без секрета пароль поставить нельзя")
	}
}

// Один и тот же пароль обязан давать разный шифротекст: одинаковый выдавал бы
// совпадение паролей у двух форм тому, кто видит дамп базы.
func TestPasswordSealIsRandomized(t *testing.T) {
	key := []byte("form-token-secret-long-enough-32b")
	a, err := sealPassword(key, "один и тот же")
	if err != nil {
		t.Fatalf("sealPassword: %v", err)
	}
	b, err := sealPassword(key, "один и тот же")
	if err != nil {
		t.Fatalf("sealPassword: %v", err)
	}
	if string(a) == string(b) {
		t.Fatal("шифротекст одного пароля обязан различаться от вызова к вызову")
	}
}
