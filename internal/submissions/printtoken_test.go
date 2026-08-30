package submissions

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

var (
	printSecret = derivePrintSecret([]byte("секрет контура"))
	printForm   = uuid.MustParse("018f0000-0000-7000-8000-000000000001")
	printSub    = uuid.MustParse("018f0000-0000-7000-8000-000000000002")
)

func TestPrintTokenRoundTrip(t *testing.T) {
	now := time.Now()
	tok := issuePrintToken(printSecret, printForm, printSub, now.Add(printTokenTTL))

	form, sub, err := parsePrintToken(printSecret, tok, now)
	if err != nil {
		t.Fatalf("свой токен не принят: %v", err)
	}
	if form != printForm || sub != printSub {
		t.Errorf("пара = %s/%s, ждали %s/%s", form, sub, printForm, printSub)
	}
}

func TestPrintTokenRejects(t *testing.T) {
	now := time.Now()
	valid := issuePrintToken(printSecret, printForm, printSub, now.Add(printTokenTTL))

	// Подменённый id ответа — главный сценарий, ради которого токен подписан:
	// без подписи он был бы пропуском к любому ответу любой формы.
	other := uuid.MustParse("018f0000-0000-7000-8000-000000000003")
	forged := strings.Replace(valid, printSub.String(), other.String(), 1)

	cases := []struct {
		name string
		tok  string
		at   time.Time
	}{
		{"подменённый id ответа", forged, now},
		{"чужой секрет", issuePrintToken(derivePrintSecret([]byte("другой контур")), printForm, printSub, now.Add(printTokenTTL)), now},
		{"истёкший", issuePrintToken(printSecret, printForm, printSub, now.Add(-time.Second)), now},
		{"ровно в момент истечения", issuePrintToken(printSecret, printForm, printSub, now), now},
		{"без подписи", printForm.String() + "." + printSub.String() + ".9999999999999", now},
		{"пустой", "", now},
		{"мусор", "не-токен", now},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, _, err := parsePrintToken(printSecret, c.tok, c.at); err == nil {
				t.Error("токен принят, ждали отказ")
			}
		})
	}
}

// Секрет печати обязан отличаться от секрета формы: иначе утечка одного применения
// била бы по обоим (тот же довод, что у ключа посетителя в internal/visits).
func TestPrintSecretIsDerived(t *testing.T) {
	base := []byte("секрет контура")
	derived := derivePrintSecret(base)

	if string(derived) == string(base) {
		t.Error("секрет печати совпал с секретом токена формы")
	}
	if string(derived) != string(derivePrintSecret(base)) {
		t.Error("вывод секрета недетерминирован")
	}
	if string(derived) == string(derivePrintSecret([]byte("другой контур"))) {
		t.Error("секреты разных контуров совпали")
	}
	if derivePrintSecret(nil) != nil {
		t.Error("из пустого секрета выведен непустой")
	}
}
