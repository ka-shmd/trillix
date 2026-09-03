package booking

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

var testSecret = []byte("dev-only-form-token-secret-not-a-real-key")

func TestCancelToken_RoundTrip(t *testing.T) {
	secret := DeriveCancelSecret(testSecret)
	id := uuid.New()
	now := time.Now()

	tok := IssueCancelToken(secret, id, now.Add(CancelTTL))
	got, ok := ParseCancelToken(secret, tok, now)
	if !ok || got != id {
		t.Fatalf("токен не признан своим: id=%s ok=%v", got, ok)
	}
}

func TestCancelToken_Refuses(t *testing.T) {
	secret := DeriveCancelSecret(testSecret)
	id := uuid.New()
	now := time.Now()
	valid := IssueCancelToken(secret, id, now.Add(time.Hour))

	// Чужой id в готовом токене: подпись покрывает и его, поэтому ссылка из одного
	// письма чужую запись не отменяет.
	swapped := uuid.New().String() + valid[strings.Index(valid, "."):]

	tests := []struct {
		name string
		tok  string
		at   time.Time
	}{
		{"протухший", IssueCancelToken(secret, id, now.Add(-time.Minute)), now},
		{"подменённый id", swapped, now},
		{"испорченная подпись", valid[:len(valid)-2] + "xx", now},
		{"мусор", "не-токен", now},
		{"пусто", "", now},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, ok := ParseCancelToken(secret, tt.tok, tt.at); ok {
				t.Fatal("токен признан годным, ожидался отказ")
			}
		})
	}
}

// Ротация секрета гасит выданные ссылки — это записано в раннбуке, и тест не даёт
// свойству потеряться.
func TestCancelToken_RotationInvalidates(t *testing.T) {
	id := uuid.New()
	now := time.Now()
	tok := IssueCancelToken(DeriveCancelSecret(testSecret), id, now.Add(time.Hour))

	if _, ok := ParseCancelToken(DeriveCancelSecret([]byte("другой-секрет")), tok, now); ok {
		t.Fatal("ссылка пережила смену секрета")
	}
}

// Метка назначения разводит применения одного секрета: токен отмены не должен
// годиться там, где ждут другой токен, и наоборот.
func TestCancelToken_SecretIsDerived(t *testing.T) {
	if got := DeriveCancelSecret(testSecret); string(got) == string(testSecret) {
		t.Fatal("секрет отмены совпал с секретом токена формы")
	}
	if DeriveCancelSecret(nil) != nil {
		t.Fatal("пустой секрет контура обязан давать пустой производный")
	}
}
