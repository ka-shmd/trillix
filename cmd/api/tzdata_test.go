package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

// База часовых поясов обязана быть ВНУТРИ бинарника (фаза 27, ADR §10).
//
// Тест ЧИТАЕТ ИСХОДНИК, а не проверяет поведение, и это не лень: на машине
// разработчика и в CI зоны читаются из системы, поэтому time.LoadLocation работает
// одинаково и с импортом, и без него. Отсутствие базы видно только в продуктовом
// образе (gcr.io/distroless/static), то есть на проде — там, где узнавать об этом
// поздно. Единственное, что можно проверить заранее, — что строка на месте.
func TestTZDataEmbedded(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("прочитать main.go: %v", err)
	}
	if !strings.Contains(string(src), `_ "time/tzdata"`) {
		t.Error(`в main.go нет импорта _ "time/tzdata": расписания записи (schedules.timezone) ` +
			`перестанут грузить пояс в продуктовом образе, где базы зон нет`)
	}
}

// Зона с живыми переходами на летнее время грузится и переходы знает. Здесь тест
// проверяет ровно то, что может: что зона вообще читается и что смещение в июле и
// в январе разное. В образе без tzdata он бы упал на первой же строке.
func TestScheduleZoneHasDST(t *testing.T) {
	loc, err := time.LoadLocation("Europe/Berlin")
	if err != nil {
		t.Fatalf("зона Europe/Berlin не загрузилась: %v", err)
	}
	_, winter := time.Date(2026, 1, 15, 12, 0, 0, 0, loc).Zone()
	_, summer := time.Date(2026, 7, 15, 12, 0, 0, 0, loc).Zone()
	if winter == summer {
		t.Errorf("смещение зимой и летом совпало (%d): база зон без переходов", winter)
	}
}
