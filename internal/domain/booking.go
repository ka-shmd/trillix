package domain

import (
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Расписание записи на время (фаза 27, docs/design/booking.md). Здесь живут две
// чистые функции, вокруг которых собрана вся фаза: проверка правила расписания
// (ValidateSchedule) и расчёт свободного времени (FreeSlots).
//
// Несущее свойство модели: в базе лежит ТОЛЬКО ЗАНЯТОЕ — брони и ручные блокировки.
// Свободное считается здесь, на лету, из правила, исключений и занятого (ADR §10).
// Заранее нарезанных слотов не существует, поэтому правка расписания действует
// мгновенно и ничего не перестраивает.

// Потолки правила. Ограничивают документ availability, который приезжает от автора
// и хранится JSONB: структуру базы никто не проверяет, проверяет этот файл
// (инвариант 3 — ввод валидируется на бэке независимо от фронта).
const (
	// MaxScheduleNameLen — имя расписания в рунах. Имя называет ТОГО, КТО ПРИНИМАЕТ
	// («Мария — рисование»), и живёт в списке строкой.
	MaxScheduleNameLen = 100
	// MaxWindowsPerDay — окон приёма в одном дне. Рабочий день с перерывом — два,
	// день с тремя перерывами — четыре; дюжина покрывает любой мыслимый распорядок.
	MaxWindowsPerDay = 12
	// MaxScheduleExceptions — исключений по датам в правиле. Горизонт записи не
	// больше года, и на каждый его день исключения быть не может: документ читается
	// целиком при каждом расчёте свободного времени.
	MaxScheduleExceptions = 200
	// MaxScheduleNoteLen — подпись ручной блокировки («отпуск», «обед позже»).
	MaxScheduleNoteLen = 200
)

// Границы параметров нарезки. Дублируют CHECK'и миграции 0050 намеренно: ошибка
// ловится осмысленным сообщением до похода в базу (приём тот же, что у
// ValidateCloseSettings).
const (
	MinSlotMinutes   = 1
	MaxSlotMinutes   = 1440
	MaxBufferMinutes = 1440
	MinHorizonDays   = 1
	MaxHorizonDays   = 365
	MaxLeadMinutes   = 365 * 24 * 60
)

// Значения bookings.status.
const (
	BookingHeld      = "held"
	BookingConfirmed = "confirmed"
	BookingCanceled  = "canceled"
)

// HoldTTL — сколько живёт придержанное время, пока респондент заполняет анкету.
//
// Срок МЯГКИЙ: истёкший холд на отправке перезанимается тем же счётом под
// блокировкой, а не отказывает (ADR §10). Поэтому пятнадцать минут — это срок,
// после которого место снова предлагают другим, а не обрыв для того, кто его
// держал: длинная анкета и возврат к автосохранённому черновику штатны.
const HoldTTL = 15 * time.Minute

// weekdayKeys — ключи правила по дням недели, в порядке time.Weekday (воскресенье
// нулевое). Ключи короткие и английские: они лежат в JSONB и в коде обеих сторон,
// а не показываются человеку.
var weekdayKeys = [7]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

// Window — окно приёма внутри дня. Время МЕСТНОЕ для расписания («10:00»), а не
// UTC: «понедельник, 10:00» означает 10:00 у автора всегда, и хранение в UTC
// сдвинуло бы всю сетку при переезде автора или переводе часов в его стране.
type Window struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// ScheduleException — день, выпадающий из общего правила.
//
// Исключение ПЕРЕБИВАЕТ день целиком, а не дополняет его. Иначе «в этот день
// принимаю только два часа» невыразимо: сложение окон дало бы рабочий день плюс
// два часа. Пустой список окон = «в этот день не принимаю».
type ScheduleException struct {
	Date    string   `json:"date"` // YYYY-MM-DD в поясе расписания
	Windows []Window `json:"windows"`
}

// Availability — правило и исключения одним документом (колонка schedules.availability).
// JSONB, а не таблица: документ читается всегда целиком, поиска по нему нет, и
// меняться он обязан без миграций.
type Availability struct {
	Weekly     map[string][]Window `json:"weekly"`
	Exceptions []ScheduleException `json:"exceptions"`
}

// Schedule — расписание в том виде, в каком его читают чистые функции этого файла.
// Строка таблицы schedules без служебных полей: id и владелец расчёту не нужны.
type Schedule struct {
	Name         string
	Timezone     string
	Availability Availability
	SlotMinutes  int
	// BufferMinutes — пауза после приёма. Входит в ШАГ сетки, но не в длительность
	// встречи: приём 60 с буфером 10 даёт старты в 10:00, 11:10, 12:20.
	BufferMinutes      int
	HorizonDays        int
	LeadMinutes        int
	Capacity           int
	MaxSeatsPerBooking int
	ShowRemaining      bool
}

// Busy — занятый отрезок: ручная блокировка автора (schedule_blocks). Брони сюда
// НЕ попадают: они считаются местами (Taken), а не отрезками, потому что при
// вместимости больше единицы занятость слота — число, а не факт.
type Busy struct {
	StartsAt time.Time
	EndsAt   time.Time
}

// Taken — сколько мест уже занято в точке старта: ключ — Unix-секунда старта в UTC.
// Считает вызывающий (сумма seats по неистёкшим held и confirmed), домен только
// вычитает. Ключ секундой, а не time.Time: у времени есть монотонная часть и
// локация, и как ключ карты оно ведёт себя не так, как выглядит.
type Taken map[int64]int

// Slot — свободная точка старта, какой её видит респондент.
type Slot struct {
	StartsAt  time.Time // UTC
	Remaining int       // сколько мест ещё можно взять
}

// SlotHold — что подтверждение брони сообщает приёму ответа: время записи и число
// мест. Живёт в domain, а не в модуле записи, по тому же доводу, что и Action: тип
// нужен ДВУМ модулям сразу (booking его заполняет, submissions читает), и объявленный
// у любого из них он завёл бы импорт между ними.
type SlotHold struct {
	// StartsAt — время, которое уедет В ОТВЕТ формы. Из строки брони, а не из
	// присланного клиентом: на проводе приезжает только id.
	StartsAt time.Time
	Seats    int
	// DurationMinutes и Timezone нужны письму о записи: событие календаря требует
	// конца встречи, а время в письме пишется в ОБОИХ поясах — читателя и расписания
	// (§6 спеки). Читать расписание вторым запросом ради двух значений незачем: они
	// приезжают тем же джойном, что и сама бронь.
	DurationMinutes int
	Timezone        string
}

// ValidateSchedule — серверная проверка расписания целиком (инвариант 3). Чистая
// функция без HTTP и SQL; нарушение → ErrValidation (→ 422 в respond.go).
func ValidateSchedule(s Schedule) error {
	if strings.TrimSpace(s.Name) == "" {
		return schemaErr("name: имя расписания обязательно")
	}
	if n := utf8.RuneCountInString(s.Name); n > MaxScheduleNameLen {
		return schemaErr("name длиннее %d символов", MaxScheduleNameLen)
	}
	// Зона проверяется загрузкой, а не списком: список зон живёт в базе tzdata и
	// меняется без нас. Загрузка здесь же и ловит образ без базы зон — см. мину у
	// LoadScheduleLocation.
	if _, err := LoadScheduleLocation(s.Timezone); err != nil {
		return schemaErr("timezone: %v", err)
	}
	if s.SlotMinutes < MinSlotMinutes || s.SlotMinutes > MaxSlotMinutes {
		return schemaErr("slotMinutes: нужно число от %d до %d", MinSlotMinutes, MaxSlotMinutes)
	}
	if s.BufferMinutes < 0 || s.BufferMinutes > MaxBufferMinutes {
		return schemaErr("bufferMinutes: нужно число от 0 до %d", MaxBufferMinutes)
	}
	if s.HorizonDays < MinHorizonDays || s.HorizonDays > MaxHorizonDays {
		return schemaErr("horizonDays: нужно число от %d до %d", MinHorizonDays, MaxHorizonDays)
	}
	if s.LeadMinutes < 0 || s.LeadMinutes > MaxLeadMinutes {
		return schemaErr("leadMinutes: нужно число от 0 до %d", MaxLeadMinutes)
	}
	if s.Capacity < 1 {
		return schemaErr("capacity: нужно положительное число")
	}
	// Взять в одной записи больше, чем всего мест в слоте, нельзя ни при каких
	// настройках: такая запись не поместилась бы даже в пустой слот.
	if s.MaxSeatsPerBooking < 1 || s.MaxSeatsPerBooking > s.Capacity {
		return schemaErr("maxSeatsPerBooking: нужно число от 1 до capacity (%d)", s.Capacity)
	}
	return ValidateAvailability(s.Availability)
}

// ValidateScheduleBlock — проверка ручной блокировки: непустой отрезок и подпись
// в пределах потолка. Чистая функция, как и остальная валидация расписания.
//
// «Не в прошлом» здесь НЕ требуется: закрыть задним числом законно — автор
// отмечает, что во вторник его не было, и это не мешает никому.
func ValidateScheduleBlock(startsAt, endsAt time.Time, note string) error {
	if startsAt.IsZero() || endsAt.IsZero() {
		return schemaErr("блокировка: нужны начало и конец")
	}
	if !endsAt.After(startsAt) {
		return schemaErr("блокировка: конец должен быть позже начала")
	}
	if n := utf8.RuneCountInString(note); n > MaxScheduleNoteLen {
		return schemaErr("note длиннее %d символов", MaxScheduleNoteLen)
	}
	return nil
}

// ValidateAvailability проверяет документ правила: ключи дней, формат времени,
// порядок и непересечение окон, даты исключений.
func ValidateAvailability(a Availability) error {
	for key, windows := range a.Weekly {
		if !knownWeekday(key) {
			return schemaErr("weekly: неизвестный день %q", key)
		}
		if err := validateWindows(windows, "weekly."+key); err != nil {
			return err
		}
	}
	if len(a.Exceptions) > MaxScheduleExceptions {
		return schemaErr("exceptions: не больше %d исключений", MaxScheduleExceptions)
	}
	seen := make(map[string]struct{}, len(a.Exceptions))
	for _, ex := range a.Exceptions {
		if _, err := time.Parse(dateLayout, ex.Date); err != nil {
			return schemaErr("exceptions: дата %q не разбирается (нужен формат ГГГГ-ММ-ДД)", ex.Date)
		}
		if _, dup := seen[ex.Date]; dup {
			// Две записи на одну дату означали бы, что перебивку дня выбирает
			// порядок в массиве, — а он в JSON произволен.
			return schemaErr("exceptions: дата %s указана дважды", ex.Date)
		}
		seen[ex.Date] = struct{}{}
		if err := validateWindows(ex.Windows, "exceptions."+ex.Date); err != nil {
			return err
		}
	}
	return nil
}

const dateLayout = "2006-01-02"

// validateWindows — окна одного дня: разбираются, from < to, упорядочены и не
// пересекаются. Порядок требуется, а не сортируется молча: перепутанные окна почти
// всегда означают ошибку ввода, и починить её должен тот, кто её видит.
func validateWindows(windows []Window, where string) error {
	if len(windows) > MaxWindowsPerDay {
		return schemaErr("%s: не больше %d окон в дне", where, MaxWindowsPerDay)
	}
	prevEnd := -1
	for _, w := range windows {
		from, err := parseClock(w.From)
		if err != nil {
			return schemaErr("%s: время %q не разбирается (нужен формат ЧЧ:ММ)", where, w.From)
		}
		to, err := parseClock(w.To)
		if err != nil {
			return schemaErr("%s: время %q не разбирается (нужен формат ЧЧ:ММ)", where, w.To)
		}
		if from >= to {
			return schemaErr("%s: окно %s–%s пустое или вывернутое", where, w.From, w.To)
		}
		if from < prevEnd {
			return schemaErr("%s: окна пересекаются или идут не по порядку (%s–%s)", where, w.From, w.To)
		}
		prevEnd = to
	}
	return nil
}

// parseClock — «10:00» → минуты от полуночи. Полночь следующего дня («24:00»)
// принимается концом окна: рабочий день до полуночи иначе невыразим, а 23:59
// оставляет минуту, в которую нельзя записаться.
func parseClock(s string) (int, error) {
	var h, m int
	if n, err := fmt.Sscanf(s, "%02d:%02d", &h, &m); n != 2 || err != nil {
		return 0, fmt.Errorf("время %q не разбирается", s)
	}
	if len(s) != 5 || s[2] != ':' {
		return 0, fmt.Errorf("время %q не разбирается", s)
	}
	if h < 0 || m < 0 || m > 59 || h > 24 || (h == 24 && m != 0) {
		return 0, fmt.Errorf("время %q вне суток", s)
	}
	return h*60 + m, nil
}

func knownWeekday(key string) bool {
	for _, k := range weekdayKeys {
		if k == key {
			return true
		}
	}
	return false
}

// LoadScheduleLocation — пояс расписания.
//
// ⚠ МИНА: образ продукта (gcr.io/distroless/static) базы часовых поясов НЕ СОДЕРЖИТ,
// и без `import _ "time/tzdata"` в main эта функция падает ТОЛЬКО НА ПРОДЕ — на
// машине разработчика зоны читаются из системы. Обойти FixedZone, как это сделано
// в internal/entitlements, здесь нельзя: зону выбирает автор, и переходы на летнее
// время у части зон живы (ADR §10).
func LoadScheduleLocation(tz string) (*time.Location, error) {
	if strings.TrimSpace(tz) == "" {
		return nil, fmt.Errorf("часовой пояс не указан")
	}
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, fmt.Errorf("часовой пояс %q неизвестен", tz)
	}
	return loc, nil
}

// FreeSlots — свободные точки старта на горизонте расписания, по возрастанию времени.
//
//	дни горизонта → для каждого дня:
//	    окна = exceptions[дата] ?? weekly[день недели]      (местное время расписания)
//	    окна → точки старта с шагом slot_minutes + buffer_minutes
//	    выкинуть: прошедшее, ближе чем lead_minutes, попавшее в блокировку
//	    свободно, если занятых мест меньше вместимости
//
// blocks — ручные блокировки автора, taken — уже занятые места по точкам старта
// (см. Taken). now задаётся вызывающим, а не берётся из часов: функция чистая и
// проверяется таблицей.
func FreeSlots(s Schedule, blocks []Busy, taken Taken, now time.Time) ([]Slot, error) {
	loc, err := LoadScheduleLocation(s.Timezone)
	if err != nil {
		return nil, err
	}
	step := s.SlotMinutes + s.BufferMinutes
	if step <= 0 {
		return nil, fmt.Errorf("domain: шаг сетки расписания не положителен")
	}

	// Отсечки. Ранняя — упреждение («ближайшие два часа недоступны»), поздняя —
	// горизонт: HorizonDays суток ВКЛЮЧАЯ сегодняшний день, то есть горизонт 1
	// означает «только сегодня».
	earliest := now.Add(time.Duration(s.LeadMinutes) * time.Minute)
	today := now.In(loc)
	year, month, day := today.Date()

	out := []Slot{}
	for i := 0; i < s.HorizonDays; i++ {
		date := time.Date(year, month, day+i, 0, 0, 0, 0, loc)
		for _, w := range windowsForDate(s.Availability, date) {
			from, err := parseClock(w.From)
			if err != nil {
				// Документ провалидирован при сохранении; сюда битое время попасть
				// может только из базы, правленной руками. Молча пропустить окно
				// значило бы показать расписание, которого автор не заводил.
				return nil, fmt.Errorf("domain: расписание %q: %w", s.Name, err)
			}
			to, err := parseClock(w.To)
			if err != nil {
				return nil, fmt.Errorf("domain: расписание %q: %w", s.Name, err)
			}
			for start := from; start+s.SlotMinutes <= to; start += step {
				at, ok := localTime(date, start, loc)
				if !ok {
					// Часа не существует: в этот день в этой зоне стрелки
					// перевели вперёд. Слот не предлагается — записаться на
					// несуществующее время нельзя.
					continue
				}
				if at.Before(earliest) {
					continue
				}
				if coveredByBlock(at, at.Add(time.Duration(s.SlotMinutes)*time.Minute), blocks) {
					continue
				}
				remaining := s.Capacity - taken[at.Unix()]
				if remaining <= 0 {
					continue
				}
				out = append(out, Slot{StartsAt: at.UTC(), Remaining: remaining})
			}
		}
	}
	// Окна внутри дня упорядочены валидацией, но дни горизонта и переводы часов
	// порядок не гарантируют: сортировка здесь дешевле, чем доверие.
	sort.Slice(out, func(i, j int) bool { return out[i].StartsAt.Before(out[j].StartsAt) })
	return out, nil
}

// windowsForDate — окна дня: исключение перебивает недельное правило целиком.
func windowsForDate(a Availability, date time.Time) []Window {
	key := date.Format(dateLayout)
	for _, ex := range a.Exceptions {
		if ex.Date == key {
			return ex.Windows
		}
	}
	return a.Weekly[weekdayKeys[int(date.Weekday())]]
}

// localTime — местное время дня в точку на оси времени. Второе значение — false,
// если такого времени в этот день не существует (перевод стрелок вперёд).
//
// Проверка обязательна: time.Date несуществующее местное время не отвергает, а
// НОРМАЛИЗУЕТ — 02:30 в день перевода превращается в 03:30, и слот молча уехал бы
// на час. Обратный случай (стрелки назад, время случается дважды) берётся первым
// разом — тем, что вернул time.Date.
func localTime(date time.Time, minutes int, loc *time.Location) (time.Time, bool) {
	year, month, day := date.Date()
	at := time.Date(year, month, day, minutes/60, minutes%60, 0, 0, loc)
	back := at.In(loc)
	if back.Hour()*60+back.Minute() != minutes%(24*60) {
		return time.Time{}, false
	}
	// Полночь как конец окна («24:00») в старты не попадает — цикл до неё не
	// доходит, — но день нормализацией перескочить всё равно нельзя.
	if minutes < 24*60 && back.Day() != day {
		return time.Time{}, false
	}
	return at, true
}

// coveredByBlock — пересекается ли встреча с ручной блокировкой. Пересечение, а не
// совпадение начала: блокировка «с 15:00 до 16:00» обязана убрать и слот 14:30–15:30.
func coveredByBlock(start, end time.Time, blocks []Busy) bool {
	for _, b := range blocks {
		if start.Before(b.EndsAt) && b.StartsAt.Before(end) {
			return true
		}
	}
	return false
}

// MoveAligned — годится ли эта точка старта для переноса брони автором.
//
// Защищает счёт занятости: он считается по РАВЕНСТВУ точки старта (queries.sql,
// TakenSeatsAt*), поэтому бронь мимо сетки не встретится в счёте ни с чем, и в
// соседний слот при вместимости 1 сядет второй человек.
//
// Часы приёма, упреждение и горизонт не проверяются: автор вправе поставить человека
// и вне приёма (ADR §10). Точка годится, если верно одно из двух:
//
//   - внутри окна приёма — отстоит от его начала на целое число шагов;
//   - вне всех окон — её минута от полуночи кратна шагу.
func MoveAligned(s Schedule, at time.Time) bool {
	loc, err := LoadScheduleLocation(s.Timezone)
	if err != nil {
		return false
	}
	step := s.SlotMinutes + s.BufferMinutes
	if step <= 0 {
		return false
	}
	local := at.In(loc)
	if local.Second() != 0 || local.Nanosecond() != 0 {
		return false
	}
	minutes := local.Hour()*60 + local.Minute()

	date := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	inWindow := false
	for _, w := range windowsForDate(s.Availability, date) {
		from, err := parseClock(w.From)
		if err != nil {
			continue
		}
		to, err := parseClock(w.To)
		if err != nil {
			continue
		}
		if minutes < from || minutes >= to {
			// Продолжение сетки ЗА конец окна не годится: 13:30 при окне 10:00–13:00
			// и шаге 70 кратно шагу от начала, но накрыло бы слот 14:00.
			continue
		}
		inWindow = true
		if (minutes-from)%step == 0 {
			return true
		}
	}
	// Внутри окна кратность шагу от полуночи не годится: у окна своя сетка. При окне
	// с 10:00 и шаге 70 слоты идут 10:00 и 11:10, а 11:40 кратно 70 — попало бы в час
	// приёма мимо всех слотов.
	if inWindow {
		return false
	}
	return minutes%step == 0
}
