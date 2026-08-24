package domain

import (
	"net/url"
	"sort"
	"strings"
	"time"
)

// Разбивки экрана «Визиты» (спека design/analytics-tally.md §8): ряд по времени,
// источники, устройства/браузеры/ОС.
//
// Всё здесь — чистые свёртки над сырьём, которое посчитал SQL. Правило то же, что у
// сводки и воронки (ANALYTICS.md §5): на SQL уходит подсчёт строк, семантику
// («что значит эта строка user-agent», «что считать источником») знает Go.

// BucketStep — шаг ряда по времени. Строка, потому что уезжает прямо в date_trunc.
type BucketStep string

const (
	StepHour BucketStep = "hour"
	StepDay  BucketStep = "day"
)

// StepFor выбирает шаг по окну наблюдения: до двух суток — часы, дальше — сутки.
// Правило живёт на сервере, а не на экране: шаг определяет и запрос, и подписи оси,
// а две копии этого выбора разъезжаются молча.
func StepFor(p Period) BucketStep {
	if p.From.IsZero() {
		return StepDay // «всё время»: часами это тысячи точек
	}
	to := p.To
	if to.IsZero() {
		to = time.Now()
	}
	if to.Sub(p.From) <= 48*time.Hour {
		return StepHour
	}
	return StepDay
}

// TimeBucket — точка ряда: сколько визитов и сколько из них закончились ответом.
type TimeBucket struct {
	At        time.Time
	Visits    int
	Submitted int
}

// LabelCount — строка списка (устройство, браузер, ОС): подпись и число визитов.
type LabelCount struct {
	Label  string
	Visits int
}

// SourceRow — сырьё источников из SQL: тройка меток и счётчик.
type SourceRow struct {
	Referer   string
	UTMSource string
	UTMMedium string
	Visits    int
}

// SourceCount — строка списка источников: откуда пришли и каким каналом.
type SourceCount struct {
	Source string
	Medium string
	Visits int
}

// PlaceCount — строка списка стран или городов: название, код страны (для флага) и
// число визитов. У страны код — её собственный, у города — код его страны.
type PlaceCount struct {
	Name        string
	CountryCode string
	Visits      int
}

// UserAgentRow — сырьё разбора: строка user-agent и сколько визитов с ней пришло.
// Строк здесь сотни (различных агентов), а не по одной на визит, — поэтому разбор
// на чтении дёшев.
type UserAgentRow struct {
	UserAgent string
	Visits    int
}

const (
	// directSource — визит без всякой метки происхождения: человек набрал адрес,
	// перешёл из мессенджера или закладки. Это отдельная строка, а не «неизвестно»:
	// у формы, которую рассылают ссылкой, она главная.
	directSource = "Прямые заходы"
	noMedium     = "Нет"
	unknownLabel = "Не определено"
)

// FoldSources сводит сырьё в строки экрана: utm_source побеждает хост referer'а,
// отсутствие обоих даёт «Прямые заходы».
//
// Приоритет именно такой, потому что utm_source ставит автор рассылки, а referer —
// браузер: когда автор разметил ссылку, он и знает, как называется его канал.
func FoldSources(rows []SourceRow) []SourceCount {
	byKey := map[SourceCount]int{}
	for _, r := range rows {
		key := SourceCount{Source: sourceName(r), Medium: mediumName(r)}
		byKey[key] += r.Visits
	}
	out := make([]SourceCount, 0, len(byKey))
	for key, visits := range byKey {
		key.Visits = visits
		out = append(out, key)
	}
	sortByVisits(out, func(i int) (int, string) { return out[i].Visits, out[i].Source + out[i].Medium })
	return out
}

func sourceName(r SourceRow) string {
	if s := strings.TrimSpace(r.UTMSource); s != "" {
		return s
	}
	if host := refererHost(r.Referer); host != "" {
		return host
	}
	return directSource
}

func mediumName(r SourceRow) string {
	if m := strings.TrimSpace(r.UTMMedium); m != "" {
		return m
	}
	return noMedium
}

// refererHost достаёт хост без www. Неразбираемый referer (а он приходит из
// браузера и может быть каким угодно) даёт пустую строку — визит уйдёт в прямые
// заходы, а не в источник с именем-мусором.
func refererHost(referer string) string {
	raw := strings.TrimSpace(referer)
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
}

// FoldUserAgents разбирает сгруппированные строки user-agent в три списка.
// Неопознанное не приписывается к соседнему значению, а собирается в «Не
// определено»: строка с честным именем лучше, чем завышенный Chrome.
func FoldUserAgents(rows []UserAgentRow) (devices, browsers, systems []LabelCount) {
	dev, br, os := map[string]int{}, map[string]int{}, map[string]int{}
	for _, r := range rows {
		ua := ParseUserAgent(r.UserAgent)
		dev[DeviceLabel(ua.Device)] += r.Visits
		br[orUnknown(ua.Browser)] += r.Visits
		os[orUnknown(ua.OS)] += r.Visits
	}
	return toLabelCounts(dev), toLabelCounts(br), toLabelCounts(os)
}

func orUnknown(s string) string {
	if s == "" {
		return unknownLabel
	}
	return s
}

func toLabelCounts(m map[string]int) []LabelCount {
	out := make([]LabelCount, 0, len(m))
	for label, visits := range m {
		out = append(out, LabelCount{Label: label, Visits: visits})
	}
	sortByVisits(out, func(i int) (int, string) { return out[i].Visits, out[i].Label })
	return out
}

// sortByVisits — убывание по числу визитов, при равенстве — по подписи. Второй
// ключ не косметика: без него соседние обновления экрана переставляют строки
// местами, и владелец видит «шевеление» там, где данные не менялись.
func sortByVisits[T any](s []T, key func(i int) (int, string)) {
	sort.SliceStable(s, func(i, j int) bool {
		vi, li := key(i)
		vj, lj := key(j)
		if vi != vj {
			return vi > vj
		}
		return li < lj
	})
}

// FillBuckets достраивает пустые корзины ряда: SQL отдаёт только те, где что-то
// было, а дыра в ряду читается как «данных нет», хотя означает «ноль визитов».
//
// Границы: from/to — окно наблюдения; нулевые значения означают «взять из данных»
// («всё время» не имеет начала, кроме первого визита).
func FillBuckets(rows []TimeBucket, step BucketStep, from, to time.Time) []TimeBucket {
	if len(rows) == 0 {
		return []TimeBucket{}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].At.Before(rows[j].At) })

	start, end := truncateTo(rows[0].At, step), truncateTo(rows[len(rows)-1].At, step)
	if !from.IsZero() {
		start = truncateTo(from.UTC(), step)
	}
	if !to.IsZero() {
		end = truncateTo(to.UTC(), step)
	}
	// Данные вне запрошенного окна невозможны (их отрезал SQL), но окно может быть
	// шире данных — тогда ряд начинается пустыми корзинами, и это правда.
	if end.Before(start) {
		end = start
	}

	filled := map[time.Time]TimeBucket{}
	for _, r := range rows {
		filled[truncateTo(r.At, step)] = r
	}

	out := make([]TimeBucket, 0, len(filled))
	for at := start; !at.After(end); at = nextBucket(at, step) {
		if b, ok := filled[at]; ok {
			b.At = at
			out = append(out, b)
			continue
		}
		out = append(out, TimeBucket{At: at})
	}
	return out
}

func truncateTo(t time.Time, step BucketStep) time.Time {
	t = t.UTC()
	if step == StepHour {
		return t.Truncate(time.Hour)
	}
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// nextBucket шагает по календарю, а не прибавлением 24 часов: сутки бывают длиннее
// и короче суток (переход времени), и арифметика на длительностях однажды даёт
// сдвинутую или задвоенную корзину.
func nextBucket(t time.Time, step BucketStep) time.Time {
	if step == StepHour {
		return t.Add(time.Hour)
	}
	return t.AddDate(0, 0, 1)
}

// VisitsBreakdown — весь экран «Визиты» одним ответом.
type VisitsBreakdown struct {
	Step       BucketStep
	Timeseries []TimeBucket
	// Sources пуст, если показ источников закрыт тарифом. Чтобы плашка не
	// рекламировала пустоту, рядом едет KnownSources — сколько визитов пришло с
	// опознанным источником (данные собираются у всех планов, ADR §10).
	Sources       []SourceCount
	SourcesLocked bool
	KnownSources  int
	Devices       []LabelCount
	Browsers      []LabelCount
	Systems       []LabelCount
	// Countries и Cities пусты, когда справочника гео на контуре нет, — блок просто
	// не рисуется. UnknownPlace — сколько визитов осталось без страны: справочника
	// нет, адрес приватный или это IPv6 (формат справочника его не понимает).
	// Число показывается на экране: граница метрики обязана быть видимой (§8.8).
	Countries    []PlaceCount
	Cities       []PlaceCount
	UnknownPlace int
}

// CountKnownSources — сколько визитов пришло не «прямым заходом». Считается до
// гейта: число показывается и тем, у кого разбивка закрыта.
func CountKnownSources(rows []SourceRow) int {
	n := 0
	for _, r := range rows {
		if sourceName(r) != directSource {
			n += r.Visits
		}
	}
	return n
}
