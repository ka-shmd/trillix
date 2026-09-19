package domain

import "testing"

func TestConversionWindow_Dropped(t *testing.T) {
	cases := map[string]struct {
		w    ConversionWindow
		want bool
	}{
		// 12 % против 31 % на хороших объёмах — падение.
		"заметное и значимое": {ConversionWindow{150, 18, 600, 186}, true},
		// Мало визитов в неделе — молчим, какой бы ни была разница.
		"мало визитов": {ConversionWindow{60, 2, 600, 186}, false},
		"мало базы":    {ConversionWindow{150, 18, 150, 60}, false},
		// Падение меньше 30 % относительно базы — не повод.
		"небольшое": {ConversionWindow{400, 100, 1600, 480}, false},
		// Разница в 30 %+, но на границе объёма и не значима.
		"незначимое":   {ConversionWindow{100, 7, 200, 21}, false},
		"рост":         {ConversionWindow{150, 60, 600, 186}, false},
		"нулевая база": {ConversionWindow{150, 0, 600, 0}, false},
	}
	for name, c := range cases {
		if got := c.w.Dropped(); got != c.want {
			t.Errorf("%s: %v, ждали %v", name, got, c.want)
		}
	}
	if r, b := (ConversionWindow{150, 18, 600, 186}).Rates(); r != 12 || b != 31 {
		t.Errorf("проценты: %d/%d", r, b)
	}
}
