package domain

import "fmt"

// Plural — «1 форма», «2 формы», «5 форм»: число вместе с согласованным словом.
// Отказ читает живой человек, и число без согласования выглядит машинным сбоем.
//
// В домене, а не в модуле-потребителе: тексты отказов пишут и booking (сколько
// записей и форм держат расписание), и forms (сколько записей держат форму), и
// вторая копия правила уже была написана в забывчивости о первой.
func Plural(n int64, one, few, many string) string {
	word := many
	switch mod100 := n % 100; {
	case mod100 >= 11 && mod100 <= 14:
	default:
		switch n % 10 {
		case 1:
			word = one
		case 2, 3, 4:
			word = few
		}
	}
	return fmt.Sprintf("%d %s", n, word)
}
