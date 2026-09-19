package domain

import (
	"fmt"
	"time"
)

// Period — окно наблюдения аналитического экрана (спека design/analytics-tally.md
// §4). Нулевое значение поля означает «границы нет»: пустой Period — «всё время».
//
// Границы — половина интервала [From, To): визит, пришедший ровно в полночь конца
// периода, принадлежит следующему периоду, а не обоим сразу.
type Period struct {
	From time.Time
	To   time.Time
}

// ParsePeriod разбирает пару значений из query-строки (RFC 3339). Пустая строка —
// «границы нет», поэтому «всё время» это ParsePeriod("", "").
//
// Проверяется ровно одно отношение — From < To. Всё остальное (насколько давно,
// не в будущем ли) законно: владелец имеет право спросить про завтра и получить
// пустой экран, а не 400.
func ParsePeriod(from, to string) (Period, error) {
	var p Period
	if from != "" {
		t, err := time.Parse(time.RFC3339, from)
		if err != nil {
			return Period{}, fmt.Errorf("%w: неверный from", ErrValidation)
		}
		p.From = t
	}
	if to != "" {
		t, err := time.Parse(time.RFC3339, to)
		if err != nil {
			return Period{}, fmt.Errorf("%w: неверный to", ErrValidation)
		}
		p.To = t
	}
	if !p.From.IsZero() && !p.To.IsZero() && !p.From.Before(p.To) {
		return Period{}, fmt.Errorf("%w: from не раньше to", ErrValidation)
	}
	return p, nil
}

// PreviousPeriod — окно той же длины сразу перед p (спека design/analytics-v2.md §8):
// с ним карточки сравнивают «эту неделю» с прошлой. У «всего времени» прошлого окна
// нет — ok = false. Открытая верхняя граница означает «сейчас».
func PreviousPeriod(p Period, now time.Time) (Period, bool) {
	if p.From.IsZero() {
		return Period{}, false
	}
	to := p.To
	if to.IsZero() {
		to = now
	}
	width := to.Sub(p.From)
	if width <= 0 {
		return Period{}, false
	}
	return Period{From: p.From.Add(-width), To: p.From}, true
}
