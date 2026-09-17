package domain

import (
	"os"
	"regexp"
	"strconv"
	"testing"
)

// Потолки раздела «Персональные данные» совпадают с кабинетом: разошедшийся потолок —
// это либо поле, в которое кабинет даёт набрать больше, чем примет сервер (422 на
// сохранении), либо обрезанный на клиенте текст, который сервер принял бы целиком.
func TestConsentLimitsParityWithCabinet(t *testing.T) {
	raw, err := os.ReadFile("../../web/app/src/entities/consent.ts")
	if err != nil {
		t.Fatalf("читать consent.ts: %v", err)
	}
	re := regexp.MustCompile(`export const (MAX_CONSENT_[A-Z_]+) = (\d+)`)
	got := map[string]int{}
	for _, m := range re.FindAllStringSubmatch(string(raw), -1) {
		n, _ := strconv.Atoi(m[2])
		got[m[1]] = n
	}
	want := map[string]int{
		"MAX_CONSENT_OPERATOR_NAME_LEN":    MaxConsentOperatorNameLen,
		"MAX_CONSENT_OPERATOR_INN_LEN":     MaxConsentOperatorINNLen,
		"MAX_CONSENT_OPERATOR_ADDRESS_LEN": MaxConsentOperatorAddressLen,
		"MAX_CONSENT_EMAIL_LEN":            MaxConsentEmailLen,
		"MAX_CONSENT_PURPOSE_LEN":          MaxConsentPurposeLen,
		"MAX_CONSENT_RETENTION_LEN":        MaxConsentRetentionLen,
		"MAX_CONSENT_DOC_TEXT_LEN":         MaxConsentDocTextLen,
	}
	if len(got) != len(want) {
		t.Errorf("в consent.ts %d потолков, в Go %d: %v", len(got), len(want), got)
	}
	for name, n := range want {
		if got[name] != n {
			t.Errorf("%s: кабинет %d, Go %d", name, got[name], n)
		}
	}
}
