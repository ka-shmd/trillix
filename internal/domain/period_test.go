package domain

import (
	"errors"
	"testing"
	"time"
)

func TestParsePeriod(t *testing.T) {
	t.Parallel()

	jan := "2026-01-01T00:00:00Z"
	feb := "2026-02-01T00:00:00Z"

	tests := []struct {
		name     string
		from, to string
		wantErr  bool
		want     Period
	}{
		{
			name: "оба пусты — всё время",
			want: Period{},
		},
		{
			name: "только нижняя граница",
			from: jan,
			want: Period{From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		},
		{
			name: "обе границы",
			from: jan, to: feb,
			want: Period{
				From: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
				To:   time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
			},
		},
		{name: "мусор вместо даты", from: "вчера", wantErr: true},
		{name: "дата без зоны", to: "2026-01-01", wantErr: true},
		{name: "границы наоборот", from: feb, to: jan, wantErr: true},
		// Пустой период (from == to) отвергается вместе с перевёрнутым: интервал
		// полуоткрытый, поэтому [t, t) не содержит ничего — экран показал бы нули
		// без единой причины на экране.
		{name: "границы совпадают", from: jan, to: jan, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := ParsePeriod(tt.from, tt.to)
			if tt.wantErr {
				if !errors.Is(err, ErrValidation) {
					t.Fatalf("ошибка = %v, ждали ErrValidation", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("неожиданная ошибка: %v", err)
			}
			if !got.From.Equal(tt.want.From) || !got.To.Equal(tt.want.To) {
				t.Fatalf("период = %+v, ждали %+v", got, tt.want)
			}
		})
	}
}

func TestPreviousPeriod(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	week := Period{From: now.AddDate(0, 0, -7)}
	prev, ok := PreviousPeriod(week, now)
	if !ok || !prev.From.Equal(now.AddDate(0, 0, -14)) || !prev.To.Equal(week.From) {
		t.Errorf("прошлая неделя: %+v, %v", prev, ok)
	}
	closed := Period{From: now.Add(-2 * time.Hour), To: now.Add(-time.Hour)}
	if prev, ok := PreviousPeriod(closed, now); !ok || !prev.From.Equal(now.Add(-3*time.Hour)) || !prev.To.Equal(closed.From) {
		t.Errorf("закрытое окно: %+v", prev)
	}
	if _, ok := PreviousPeriod(Period{}, now); ok {
		t.Error("у всего времени нашлось прошлое окно")
	}
}
