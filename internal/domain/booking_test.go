package domain

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// Расписание-образец: пн–пт 10:00–18:00 с перерывом 13:00–14:00, приём час,
// горизонт 30 дней. Ровно то, что заводит автор в критерии приёмки (спека §1).
func sampleSchedule() Schedule {
	day := []Window{{From: "10:00", To: "13:00"}, {From: "14:00", To: "18:00"}}
	return Schedule{
		Name:     "Мария — рисование",
		Timezone: "Europe/Moscow",
		Availability: Availability{Weekly: map[string][]Window{
			"mon": day, "tue": day, "wed": day, "thu": day, "fri": day,
		}},
		SlotMinutes:        60,
		BufferMinutes:      0,
		HorizonDays:        30,
		LeadMinutes:        0,
		Capacity:           1,
		MaxSeatsPerBooking: 1,
	}
}

func TestValidateSchedule(t *testing.T) {
	bad := func(mutate func(*Schedule)) Schedule {
		s := sampleSchedule()
		mutate(&s)
		return s
	}
	tests := []struct {
		name string
		in   Schedule
		ok   bool
	}{
		{"образец", sampleSchedule(), true},
		{"имя пустое", bad(func(s *Schedule) { s.Name = "   " }), false},
		{"имя длинное", bad(func(s *Schedule) { s.Name = string(make([]rune, MaxScheduleNameLen+1)) }), false},
		{"пояс неизвестен", bad(func(s *Schedule) { s.Timezone = "Europe/Атлантида" }), false},
		{"пояс пуст", bad(func(s *Schedule) { s.Timezone = "" }), false},
		{"приём ноль минут", bad(func(s *Schedule) { s.SlotMinutes = 0 }), false},
		{"приём больше суток", bad(func(s *Schedule) { s.SlotMinutes = MaxSlotMinutes + 1 }), false},
		{"буфер отрицательный", bad(func(s *Schedule) { s.BufferMinutes = -1 }), false},
		{"горизонт ноль", bad(func(s *Schedule) { s.HorizonDays = 0 }), false},
		{"горизонт больше года", bad(func(s *Schedule) { s.HorizonDays = MaxHorizonDays + 1 }), false},
		{"упреждение отрицательное", bad(func(s *Schedule) { s.LeadMinutes = -1 }), false},
		{"вместимость ноль", bad(func(s *Schedule) { s.Capacity = 0 }), false},
		{"мест в записи больше вместимости", bad(func(s *Schedule) {
			s.Capacity, s.MaxSeatsPerBooking = 4, 5
		}), false},
		{"группа: 8 мест, до 3 в записи", bad(func(s *Schedule) {
			s.Capacity, s.MaxSeatsPerBooking = 8, 3
		}), true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateSchedule(tt.in)
			if tt.ok && err != nil {
				t.Fatalf("ожидалось «годно», получено: %v", err)
			}
			if !tt.ok {
				if err == nil {
					t.Fatal("ожидался отказ, получено «годно»")
				}
				// Отказ обязан быть ErrValidation: respond.go маппит его в 422.
				if !errors.Is(err, ErrValidation) {
					t.Fatalf("ошибка не ErrValidation: %v", err)
				}
			}
		})
	}
}

func TestValidateAvailability(t *testing.T) {
	win := func(ws ...Window) []Window { return ws }
	tests := []struct {
		name string
		in   Availability
		ok   bool
	}{
		{"пустое правило — законно (приём не ведётся)", Availability{}, true},
		{"день с перерывом", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"10:00", "13:00"}, Window{"14:00", "18:00"}),
		}}, true},
		{"выходной пустым списком", Availability{Weekly: map[string][]Window{"sat": {}}}, true},
		{"неизвестный день", Availability{Weekly: map[string][]Window{
			"понедельник": win(Window{"10:00", "18:00"}),
		}}, false},
		{"время без ведущего нуля", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"9:00", "18:00"}),
		}}, false},
		{"время не время", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"утро", "18:00"}),
		}}, false},
		{"час за сутками", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"10:00", "25:00"}),
		}}, false},
		{"полночь концом окна", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"22:00", "24:00"}),
		}}, true},
		{"минуты за границей", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"10:60", "18:00"}),
		}}, false},
		{"вывернутое окно", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"18:00", "10:00"}),
		}}, false},
		{"пустое окно", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"10:00", "10:00"}),
		}}, false},
		{"окна пересекаются", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"10:00", "14:00"}, Window{"13:00", "18:00"}),
		}}, false},
		{"окна не по порядку", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"14:00", "18:00"}, Window{"10:00", "13:00"}),
		}}, false},
		{"окна впритык — законно", Availability{Weekly: map[string][]Window{
			"mon": win(Window{"10:00", "13:00"}, Window{"13:00", "18:00"}),
		}}, true},
		{"исключение: не принимаю", Availability{
			Exceptions: []ScheduleException{{Date: "2026-09-14", Windows: []Window{}}},
		}, true},
		{"исключение: дата не дата", Availability{
			Exceptions: []ScheduleException{{Date: "14.09.2026"}},
		}, false},
		{"исключение: дата дважды", Availability{Exceptions: []ScheduleException{
			{Date: "2026-09-14"}, {Date: "2026-09-14", Windows: win(Window{"10:00", "12:00"})},
		}}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateAvailability(tt.in)
			if tt.ok != (err == nil) {
				t.Fatalf("ожидалось ok=%v, получено err=%v", tt.ok, err)
			}
		})
	}
}

func TestValidateAvailability_Потолки(t *testing.T) {
	many := make([]Window, MaxWindowsPerDay+1)
	for i := range many {
		// Окна сами по себе безупречны: по получасу подряд, без пересечений.
		// Отказать обязан именно потолок.
		many[i] = Window{From: fmt.Sprintf("%02d:00", i), To: fmt.Sprintf("%02d:30", i)}
	}
	if err := ValidateAvailability(Availability{Weekly: map[string][]Window{"mon": many}}); err == nil {
		t.Error("потолок окон в дне не сработал")
	}
	exs := make([]ScheduleException, MaxScheduleExceptions+1)
	for i := range exs {
		exs[i] = ScheduleException{Date: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, i).Format(dateLayout)}
	}
	if err := ValidateAvailability(Availability{Exceptions: exs}); err == nil {
		t.Error("потолок исключений не сработал")
	}
}

// msk — время в поясе расписания-образца, чтобы тесты читались календарём автора.
func msk(t *testing.T, s string) time.Time {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Moscow")
	if err != nil {
		t.Fatalf("зона Europe/Moscow: %v", err)
	}
	at, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
	if err != nil {
		t.Fatalf("разобрать %q: %v", s, err)
	}
	return at
}

// local — часы и минуты слота в поясе расписания: сравнивать UTC-инстанты глазами
// в тестах расписания невозможно.
func local(t *testing.T, at time.Time, tz string) string {
	t.Helper()
	loc, err := time.LoadLocation(tz)
	if err != nil {
		t.Fatalf("зона %s: %v", tz, err)
	}
	return at.In(loc).Format("2006-01-02 15:04")
}

func TestFreeSlots(t *testing.T) {
	// 2026-09-07 — понедельник, 2026-09-12 — суббота.
	now := msk(t, "2026-09-07 08:00")

	t.Run("рабочий день с перерывом", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 1
		got, err := FreeSlots(s, nil, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{
			"2026-09-07 10:00", "2026-09-07 11:00", "2026-09-07 12:00",
			"2026-09-07 14:00", "2026-09-07 15:00", "2026-09-07 16:00", "2026-09-07 17:00",
		}
		assertSlots(t, got, want, s.Timezone)
	})

	t.Run("буфер входит в шаг, но не в приём", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays, s.BufferMinutes = 1, 10
		s.Availability.Weekly["mon"] = []Window{{From: "10:00", To: "13:00"}}
		got, err := FreeSlots(s, nil, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		// Шаг 70 минут: 10:00, 11:10. Третий старт (12:20) в окно не помещается —
		// встреча кончилась бы в 13:20, за его границей. Буфер после последней
		// встречи дня, таким образом, не требуется: окно кончается приёмом.
		assertSlots(t, got, []string{"2026-09-07 10:00", "2026-09-07 11:10"}, s.Timezone)
	})

	t.Run("выходного в правиле нет", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 1
		got, err := FreeSlots(s, nil, nil, msk(t, "2026-09-12 08:00"))
		if err != nil {
			t.Fatal(err)
		}
		assertSlots(t, got, nil, s.Timezone)
	})

	t.Run("исключение перебивает день целиком", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 1
		s.Availability.Exceptions = []ScheduleException{
			{Date: "2026-09-07", Windows: []Window{{From: "10:00", To: "12:00"}}},
		}
		got, err := FreeSlots(s, nil, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		// Не «рабочий день ПЛЮС два часа», а ровно два часа.
		assertSlots(t, got, []string{"2026-09-07 10:00", "2026-09-07 11:00"}, s.Timezone)
	})

	t.Run("исключение без окон закрывает день", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 1
		s.Availability.Exceptions = []ScheduleException{{Date: "2026-09-07", Windows: []Window{}}}
		got, err := FreeSlots(s, nil, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		assertSlots(t, got, nil, s.Timezone)
	})

	t.Run("упреждение съедает ближайшие часы", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays, s.LeadMinutes = 1, 120
		got, err := FreeSlots(s, nil, nil, msk(t, "2026-09-07 09:30"))
		if err != nil {
			t.Fatal(err)
		}
		// Ближе 11:30 записаться нельзя, поэтому 10:00 и 11:00 отпадают.
		assertSlots(t, got, []string{
			"2026-09-07 12:00",
			"2026-09-07 14:00", "2026-09-07 15:00", "2026-09-07 16:00", "2026-09-07 17:00",
		}, s.Timezone)
	})

	t.Run("прошедшее сегодня не предлагается", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 1
		got, err := FreeSlots(s, nil, nil, msk(t, "2026-09-07 15:30"))
		if err != nil {
			t.Fatal(err)
		}
		assertSlots(t, got, []string{"2026-09-07 16:00", "2026-09-07 17:00"}, s.Timezone)
	})

	t.Run("горизонт: сегодня и завтра", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 2
		s.Availability.Weekly = map[string][]Window{
			"mon": {{From: "10:00", To: "11:00"}},
			"tue": {{From: "10:00", To: "11:00"}},
			"wed": {{From: "10:00", To: "11:00"}},
		}
		got, err := FreeSlots(s, nil, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		// Среда за горизонтом.
		assertSlots(t, got, []string{"2026-09-07 10:00", "2026-09-08 10:00"}, s.Timezone)
	})

	t.Run("ручная блокировка убирает пересечённое", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 1
		// Блокировка 14:30–15:30 задевает встречи 14:00–15:00 и 15:00–16:00.
		blocks := []Busy{{StartsAt: msk(t, "2026-09-07 14:30"), EndsAt: msk(t, "2026-09-07 15:30")}}
		got, err := FreeSlots(s, blocks, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		assertSlots(t, got, []string{
			"2026-09-07 10:00", "2026-09-07 11:00", "2026-09-07 12:00",
			"2026-09-07 16:00", "2026-09-07 17:00",
		}, s.Timezone)
	})

	t.Run("блокировка впритык ничего не убирает", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 1
		s.Availability.Weekly["mon"] = []Window{{From: "10:00", To: "12:00"}}
		blocks := []Busy{{StartsAt: msk(t, "2026-09-07 11:00"), EndsAt: msk(t, "2026-09-07 12:00")}}
		got, err := FreeSlots(s, blocks, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		// Встреча 10:00–11:00 кончается ровно там, где блокировка начинается.
		assertSlots(t, got, []string{"2026-09-07 10:00"}, s.Timezone)
	})

	t.Run("группа: остаток мест и полный слот", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays, s.Capacity, s.MaxSeatsPerBooking = 1, 8, 3
		s.Availability.Weekly["mon"] = []Window{{From: "10:00", To: "12:00"}}
		taken := Taken{
			msk(t, "2026-09-07 10:00").Unix(): 6,
			msk(t, "2026-09-07 11:00").Unix(): 8,
		}
		got, err := FreeSlots(s, nil, taken, now)
		if err != nil {
			t.Fatal(err)
		}
		assertSlots(t, got, []string{"2026-09-07 10:00"}, s.Timezone)
		if got[0].Remaining != 2 {
			t.Fatalf("остаток мест %d, ожидалось 2", got[0].Remaining)
		}
	})

	t.Run("окно до полуночи", func(t *testing.T) {
		s := sampleSchedule()
		s.HorizonDays = 1
		s.Availability.Weekly["mon"] = []Window{{From: "22:00", To: "24:00"}}
		got, err := FreeSlots(s, nil, nil, now)
		if err != nil {
			t.Fatal(err)
		}
		assertSlots(t, got, []string{"2026-09-07 22:00", "2026-09-07 23:00"}, s.Timezone)
	})
}

// Переводы часов — единственное место, где расчёт может испортить данные незаметно.
// Зона взята с живыми переходами (Europe/Berlin): в Москве их нет с 2014 года, и
// расписание на ней эту ветку не проверяет вовсе.
func TestFreeSlots_ПереводЧасов(t *testing.T) {
	berlin := func(s string) time.Time {
		loc, err := time.LoadLocation("Europe/Berlin")
		if err != nil {
			t.Fatalf("зона Europe/Berlin: %v", err)
		}
		at, err := time.ParseInLocation("2006-01-02 15:04", s, loc)
		if err != nil {
			t.Fatalf("разобрать %q: %v", s, err)
		}
		return at
	}
	base := func(day string) Schedule {
		s := sampleSchedule()
		s.Timezone = "Europe/Berlin"
		s.HorizonDays = 1
		s.Availability = Availability{Exceptions: []ScheduleException{
			{Date: day, Windows: []Window{{From: "00:00", To: "05:00"}}},
		}}
		return s
	}

	t.Run("стрелки вперёд: несуществующего часа нет в выдаче", func(t *testing.T) {
		// 2026-03-29, 02:00 → 03:00: местного 02:00 в этот день не существует.
		s := base("2026-03-29")
		got, err := FreeSlots(s, nil, nil, berlin("2026-03-29 00:00"))
		if err != nil {
			t.Fatal(err)
		}
		assertSlots(t, got, []string{
			"2026-03-29 00:00", "2026-03-29 01:00", "2026-03-29 03:00", "2026-03-29 04:00",
		}, s.Timezone)
		// И главное — точки на оси времени идут подряд, без дыры и без наложения:
		// 01:00 CET и 03:00 CEST — это соседние часы.
		if d := got[2].StartsAt.Sub(got[1].StartsAt); d != time.Hour {
			t.Fatalf("между слотами %v, ожидался ровно час", d)
		}
	})

	t.Run("стрелки назад: двойной час предлагается один раз", func(t *testing.T) {
		// 2026-10-25, 03:00 → 02:00: местное 02:00 случается дважды. Слот берётся
		// первым разом (тем, что вернул time.Date); какой именно инстант это будет,
		// Go не гарантирует, поэтому проверяется число слотов и их календарь, а не
		// смещение.
		s := base("2026-10-25")
		got, err := FreeSlots(s, nil, nil, berlin("2026-10-25 00:00"))
		if err != nil {
			t.Fatal(err)
		}
		assertSlots(t, got, []string{
			"2026-10-25 00:00", "2026-10-25 01:00", "2026-10-25 02:00",
			"2026-10-25 03:00", "2026-10-25 04:00",
		}, s.Timezone)
	})
}

func TestFreeSlots_НеизвестныйПояс(t *testing.T) {
	s := sampleSchedule()
	s.Timezone = "Europe/Атлантида"
	if _, err := FreeSlots(s, nil, nil, time.Now()); err == nil {
		t.Fatal("ожидался отказ на неизвестном поясе")
	}
}

func assertSlots(t *testing.T, got []Slot, want []string, tz string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("слотов %d, ожидалось %d:\nполучено %v\nожидалось %v",
			len(got), len(want), slotsLocal(t, got, tz), want)
	}
	for i, w := range want {
		if g := local(t, got[i].StartsAt, tz); g != w {
			t.Errorf("слот %d: %s, ожидался %s", i, g, w)
		}
	}
}

func slotsLocal(t *testing.T, slots []Slot, tz string) []string {
	t.Helper()
	out := make([]string, len(slots))
	for i, s := range slots {
		out[i] = local(t, s.StartsAt, tz)
	}
	return out
}

// MoveAligned — единственное, что удерживает перенос внутри модели: занятость слота
// считается по РАВЕНСТВУ точки старта, и бронь, съехавшая на семь минут, не
// встретилась бы в счёте ни с чем.
func TestMoveAligned(t *testing.T) {
	msk := time.FixedZone("MSK", 3*60*60)
	at := func(day, hour, minute int) time.Time {
		return time.Date(2026, 9, day, hour, minute, 0, 0, msk)
	}

	t.Run("шаг без буфера", func(t *testing.T) {
		s := sampleSchedule()
		tests := []struct {
			name string
			at   time.Time
			want bool
		}{
			{"начало окна приёма", at(15, 10, 0), true},
			{"через шаг от начала окна", at(15, 11, 0), true},
			{"вне окон приёма, но по шагу от полуночи", at(15, 7, 0), true},
			// ВНУТРИ окна кратность полуночи не спасает: у окна своя сетка, и точка
			// мимо неё не встретится в счёте занятости ни с чем.
			{"внутри окна, но мимо его сетки", at(15, 13, 30), false},
			{"ночь по шагу", at(15, 2, 0), true},
			{"семь минут мимо", at(15, 11, 7), false},
			{"полчаса мимо при часовом шаге", at(15, 11, 30), false},
			{
				"выходной по шагу — годится: часы приёма здесь не спрашиваются",
				at(19, 12, 0), true,
			},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				if got := MoveAligned(s, tt.at); got != tt.want {
					t.Fatalf("MoveAligned(%s) = %v, ожидалось %v", tt.at.Format(time.RFC3339), got, tt.want)
				}
			})
		}
	})

	// Окно, начинающееся не на круглом часе, — ровно тот случай, ради которого
	// правило двухступенчатое: своей сетке от полуночи не кратно ничего.
	t.Run("окно с получаса", func(t *testing.T) {
		s := sampleSchedule()
		s.Availability.Weekly["tue"] = []Window{{From: "10:30", To: "18:00"}}
		if !MoveAligned(s, at(15, 10, 30)) {
			t.Fatal("начало окна 10:30 обязано годиться")
		}
		if !MoveAligned(s, at(15, 11, 30)) {
			t.Fatal("11:30 — второй слот того же окна")
		}
		if MoveAligned(s, at(15, 11, 15)) {
			t.Fatal("11:15 не лежит ни на сетке окна, ни на шаге от полуночи")
		}
	})

	// Ровно та дыра, ради которой ступени разведены: шаг 70 кратен 700 минутам
	// (11:40), а окно с 10:00 нарезает 10:00 и 11:10 — 11:40 попадает в приёмный час
	// мимо всех его слотов, и в 11:10 при вместимости 1 сядет второй человек.
	t.Run("кратность полуночи не открывает дыру внутри окна", func(t *testing.T) {
		s := sampleSchedule()
		s.Availability.Weekly = map[string][]Window{
			"tue": {{From: "10:00", To: "13:00"}, {From: "14:00", To: "18:00"}},
		}
		s.SlotMinutes, s.BufferMinutes = 60, 10
		if MoveAligned(s, at(15, 11, 40)) {
			t.Fatal("11:40 внутри окна 10:00–13:00 и мимо его сетки — годной быть не может")
		}
		for _, ok := range []time.Time{at(15, 10, 0), at(15, 11, 10), at(15, 14, 0)} {
			if !MoveAligned(s, ok) {
				t.Fatalf("%s — настоящий слот сетки, он обязан годиться", ok.Format("15:04"))
			}
		}
		// Продолжение сетки окна ЗА его конец тоже не годится: 13:30 отстоит от
		// начала окна на целое число шагов, но приёма там уже нет, а встреча накрыла
		// бы слот 14:00. Кратности полуночи у неё тоже нет.
		if MoveAligned(s, at(15, 13, 30)) {
			t.Fatal("13:30 — продолжение сетки за конец окна, годной быть не может")
		}
	})

	t.Run("буфер входит в шаг", func(t *testing.T) {
		s := sampleSchedule()
		s.SlotMinutes = 50
		s.BufferMinutes = 10
		if !MoveAligned(s, at(15, 11, 0)) {
			t.Fatal("шаг 60: 11:00 — второй слот")
		}
		if MoveAligned(s, at(15, 10, 50)) {
			t.Fatal("10:50 — конец первого приёма, а не начало второго")
		}
	})

	t.Run("секунды и неизвестный пояс не годятся", func(t *testing.T) {
		s := sampleSchedule()
		if MoveAligned(s, time.Date(2026, 9, 15, 11, 0, 30, 0, msk)) {
			t.Fatal("точка старта с секундами в сетке не лежит")
		}
		s.Timezone = "Europe/Атлантида"
		if MoveAligned(s, at(15, 11, 0)) {
			t.Fatal("пояс не загрузился — годной точку называть нельзя")
		}
	})
}
