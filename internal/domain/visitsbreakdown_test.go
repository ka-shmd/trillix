package domain

import (
	"reflect"
	"testing"
	"time"
)

func TestFoldSources(t *testing.T) {
	t.Parallel()

	rows := []SourceRow{
		{Referer: "https://vk.com/wall-123", Visits: 5},
		{Referer: "https://www.vk.com/feed", Visits: 3}, // тот же источник: www режется
		{UTMSource: "newsletter", UTMMedium: "email", Visits: 7},
		// utm перебивает referer: канал назвал автор рассылки, а не браузер.
		{Referer: "https://t.me/channel", UTMSource: "newsletter", UTMMedium: "email", Visits: 2},
		{Visits: 4}, // ни того ни другого — прямой заход
		{Referer: "не адрес вовсе", Visits: 1}, // мусор туда же, а не в источник с именем-мусором
	}

	got := FoldSources(rows)

	want := []SourceCount{
		{Source: "newsletter", Medium: "email", Visits: 9},
		{Source: "vk.com", Medium: "Нет", Visits: 8},
		{Source: "Прямые заходы", Medium: "Нет", Visits: 5},
	}
	if len(got) != len(want) {
		t.Fatalf("строк = %d (%+v), ждали %d", len(got), got, len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("строка %d = %+v, ждали %+v", i, got[i], want[i])
		}
	}
}

func TestCountKnownSources(t *testing.T) {
	t.Parallel()

	rows := []SourceRow{
		{UTMSource: "newsletter", Visits: 7},
		{Referer: "https://vk.com/x", Visits: 5},
		{Visits: 4},
	}
	// Число показывается и тем, у кого разбивка закрыта тарифом, — плашка обязана
	// говорить правду, а не рекламировать пустоту.
	if got := CountKnownSources(rows); got != 12 {
		t.Errorf("визитов с источником = %d, ждали 12", got)
	}
}

func TestFoldUserAgents(t *testing.T) {
	t.Parallel()

	chromeWin := "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36"
	safariPhone := "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"

	devices, browsers, systems := FoldUserAgents([]UserAgentRow{
		{UserAgent: chromeWin, Visits: 10},
		{UserAgent: chromeWin + " " /* другая строка, тот же браузер */, Visits: 2},
		{UserAgent: safariPhone, Visits: 5},
		{UserAgent: "", Visits: 1},
	})

	if devices[0] != (LabelCount{Label: "Компьютер", Visits: 12}) {
		t.Errorf("устройства[0] = %+v, ждали 12 компьютеров", devices[0])
	}
	if browsers[0] != (LabelCount{Label: "Chrome", Visits: 12}) {
		t.Errorf("браузеры[0] = %+v, ждали 12 Chrome", browsers[0])
	}
	if systems[0] != (LabelCount{Label: "Windows", Visits: 12}) {
		t.Errorf("ОС[0] = %+v, ждали 12 Windows", systems[0])
	}
	// Пустой user-agent не приписывается к соседнему значению: строка с честным
	// именем лучше, чем завышенный Chrome.
	if !hasLabel(devices, "Не определено", 1) {
		t.Errorf("устройства = %+v, ждали строку «Не определено» на 1 визит", devices)
	}
}

func hasLabel(rows []LabelCount, label string, visits int) bool {
	for _, r := range rows {
		if r.Label == label && r.Visits == visits {
			return true
		}
	}
	return false
}

func TestFillBuckets(t *testing.T) {
	t.Parallel()

	day := func(d int) time.Time { return time.Date(2026, 8, d, 0, 0, 0, 0, time.UTC) }

	t.Run("дыра в ряду становится нулём", func(t *testing.T) {
		t.Parallel()
		// Дыра читается как «данных нет», хотя означает «ноль визитов» — разница
		// видна на графике сразу и означает разное.
		got := FillBuckets([]TimeBucket{
			{At: day(1), Visits: 3, Submitted: 1},
			{At: day(4), Visits: 2},
		}, StepDay, time.Time{}, time.Time{})

		if len(got) != 4 {
			t.Fatalf("корзин = %d (%+v), ждали 4", len(got), got)
		}
		if got[1].Visits != 0 || !got[1].At.Equal(day(2)) {
			t.Errorf("вторая корзина = %+v, ждали пустую за 2 августа", got[1])
		}
	})

	t.Run("окно шире данных — ряд начинается пустыми корзинами", func(t *testing.T) {
		t.Parallel()
		got := FillBuckets([]TimeBucket{{At: day(3), Visits: 1}}, StepDay, day(1), day(3))
		if len(got) != 3 || !got[0].At.Equal(day(1)) || got[0].Visits != 0 {
			t.Fatalf("ряд = %+v, ждали три корзины с первой пустой", got)
		}
	})

	t.Run("пусто остаётся пустым", func(t *testing.T) {
		t.Parallel()
		// Не одна нулевая корзина: «визитов не было» рисуется пустым состоянием
		// экрана, а не графиком из одного нуля.
		if got := FillBuckets(nil, StepDay, day(1), day(5)); len(got) != 0 {
			t.Fatalf("ряд = %+v, ждали пустой", got)
		}
	})
}

func TestStepFor(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		p    Period
		want BucketStep
	}{
		{"всё время — сутками", Period{}, StepDay},
		{"сутки — часами", Period{From: now.Add(-24 * time.Hour), To: now}, StepHour},
		{"ровно двое суток — ещё часами", Period{From: now.Add(-48 * time.Hour), To: now}, StepHour},
		{"неделя — сутками", Period{From: now.Add(-7 * 24 * time.Hour), To: now}, StepDay},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := StepFor(tt.p); got != tt.want {
				t.Errorf("шаг = %q, ждали %q", got, tt.want)
			}
		})
	}
}

// Конверсия строки разбивки: отправившие складываются тем же ключом, что визиты,
// — «vk.com» из двух разных referer'ов даёт одну строку с общей долей отправивших.
func TestFoldSources_SumsSubmitted(t *testing.T) {
	got := FoldSources([]SourceRow{
		{Referer: "https://vk.com/feed", Visits: 10, Submitted: 3},
		{Referer: "https://www.vk.com/wall", Visits: 5, Submitted: 2},
		{UTMSource: "newsletter", UTMMedium: "email", Visits: 4, Submitted: 4},
	})
	want := []SourceCount{
		{Source: "vk.com", Medium: "Нет", Visits: 15, Submitted: 5},
		{Source: "newsletter", Medium: "email", Visits: 4, Submitted: 4},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("FoldSources:\n got %+v\nwant %+v", got, want)
	}
}

func TestFoldUserAgents_SumsSubmitted(t *testing.T) {
	const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
	devices, _, _ := FoldUserAgents([]UserAgentRow{
		{UserAgent: iphone, Visits: 6, Submitted: 1},
		{UserAgent: android, Visits: 4, Submitted: 3},
	})
	if len(devices) != 1 || devices[0].Visits != 10 || devices[0].Submitted != 4 {
		t.Fatalf("устройства: %+v", devices)
	}
}

func TestCoarsenBuckets(t *testing.T) {
	day := func(n int) time.Time {
		return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, n)
	}
	series := func(n int) []TimeBucket {
		out := make([]TimeBucket, 0, n)
		for i := range n {
			out = append(out, TimeBucket{At: day(i), Visits: 1, Submitted: 1})
		}
		return out
	}

	t.Run("короткий ряд не трогает", func(t *testing.T) {
		in := series(MaxBuckets)
		got, step := CoarsenBuckets(in, StepDay)
		if step != StepDay || len(got) != MaxBuckets {
			t.Fatalf("шаг %q, точек %d; хочу day и %d", step, len(got), MaxBuckets)
		}
	})

	// 130 суток — ровно тот случай, из-за которого график превращался в частокол.
	t.Run("сутки длиннее порога складывает в недели", func(t *testing.T) {
		got, step := CoarsenBuckets(series(130), StepDay)
		if step != StepWeek {
			t.Fatalf("шаг %q, хочу week", step)
		}
		if len(got) > MaxBuckets {
			t.Fatalf("точек %d, хочу не больше %d", len(got), MaxBuckets)
		}
		// Ничего не потеряно: сумма корзин равна сумме исходного ряда.
		total := 0
		for _, b := range got {
			total += b.Visits
		}
		if total != 130 {
			t.Fatalf("визитов после свёртки %d, хочу 130", total)
		}
		// 1 января 2026 — четверг; неделя начинается с понедельника 29 декабря.
		if want := time.Date(2025, 12, 29, 0, 0, 0, 0, time.UTC); !got[0].At.Equal(want) {
			t.Fatalf("первая корзина %v, хочу %v", got[0].At, want)
		}
	})

	t.Run("длинный ряд доходит до месяцев", func(t *testing.T) {
		got, step := CoarsenBuckets(series(365*3), StepDay)
		if step != StepMonth {
			t.Fatalf("шаг %q, хочу month", step)
		}
		if len(got) > MaxBuckets {
			t.Fatalf("точек %d, хочу не больше %d", len(got), MaxBuckets)
		}
	})

	// Часовой ряд не бывает длиннее двух суток, но правило не должно зависеть от
	// этого совпадения: укрупнять часы нам нечем, и функция обязана вернуть их как
	// есть, а не зациклиться.
	t.Run("часы возвращает как есть", func(t *testing.T) {
		in := make([]TimeBucket, 0, MaxBuckets+5)
		for i := range MaxBuckets + 5 {
			in = append(in, TimeBucket{At: day(0).Add(time.Duration(i) * time.Hour), Visits: 1})
		}
		got, step := CoarsenBuckets(in, StepHour)
		if step != StepHour || len(got) != MaxBuckets+5 {
			t.Fatalf("шаг %q, точек %d", step, len(got))
		}
	})
}
