package integrations

import "testing"

func TestCounterNumber(t *testing.T) {
	for number, valid := range map[string]bool{
		"12345678":      true,
		"1":             true,
		"123456789012":  true,
		"":              false,
		"abc":           false,
		"12 34":         false,
		" 12345678":     false,
		"0123":          false,
		"1234567890123": false,
		"-1":            false,
	} {
		if got := counterNumberRe.MatchString(number); got != valid {
			t.Errorf("номер %q: принят = %v, ожидалось %v", number, got, valid)
		}
	}
}
