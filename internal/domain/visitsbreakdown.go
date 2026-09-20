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
	StepHour  BucketStep = "hour"
	StepDay   BucketStep = "day"
	StepWeek  BucketStep = "week"
	StepMonth BucketStep = "month"
)

// StepFor выбирает шаг ЗАПРОСА по окну наблюдения: до двух суток — часы, дальше —
// сутки. Правило живёт на сервере, а не на экране: шаг определяет и запрос, и
// подписи оси, а две копии этого выбора разъезжаются молча.
//
// Недели и месяцы сюда не попадают намеренно: по окну их не выбрать. «Всё время» —
// это и три дня у новой формы, и три года у старой, а сколько данных на самом деле,
// до запроса не знает никто. Укрупняет ряд CoarsenBuckets — уже по факту.
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

// MaxBuckets — сколько точек ряда имеет смысл рисовать. Дальше столбик уже уже
// промежутка между столбиками, и график перестаёт быть графиком: за «всё время»
// у формы с четырьмя месяцами жизни он превращался в частокол из 130 полосок
// шириной в пиксель, где доля отправивших не различима вовсе.
//
// Число — не вкус: при ширине колонки кабинета около 900 px на точку остаётся
// порядка 10 px, то есть столбик в 6 px с зазором. Меньше — сливается.
const MaxBuckets = 92

// CoarsenBuckets укрупняет ряд, пока точек больше MaxBuckets: сутки → недели →
// месяцы. Возвращает ряд и ФАКТИЧЕСКИЙ шаг — по нему экран подписывает ось.
//
// Укрупняется уже заполненный ряд (после FillBuckets), поэтому пустые промежутки
// внутри окна не теряются: неделя без визитов остаётся нулевой точкой, а не
// пропадает, склеив соседние.
//
// Часы не укрупняются: окно с часовым шагом не бывает длиннее двух суток, то есть
// 48 точек, и порога не достигает никогда.
func CoarsenBuckets(rows []TimeBucket, step BucketStep) ([]TimeBucket, BucketStep) {
	for len(rows) > MaxBuckets {
		next, ok := coarser(step)
		if !ok {
			return rows, step
		}
		rows, step = foldBuckets(rows, next), next
	}
	return rows, step
}

func coarser(step BucketStep) (BucketStep, bool) {
	switch step {
	case StepDay:
		return StepWeek, true
	case StepWeek:
		return StepMonth, true
	default:
		return step, false
	}
}

// foldBuckets складывает точки в корзины более крупного шага. Счётчики
// СКЛАДЫВАЮТСЯ — это количества, а не уровни: у средней шкалы такое сложение было
// бы неверно, и у неё свой путь (summary.go).
func foldBuckets(rows []TimeBucket, step BucketStep) []TimeBucket {
	out := make([]TimeBucket, 0, len(rows))
	for _, r := range rows {
		at := truncateTo(r.At, step)
		if n := len(out); n > 0 && out[n-1].At.Equal(at) {
			out[n-1].Visits += r.Visits
			out[n-1].Submitted += r.Submitted
			continue
		}
		out = append(out, TimeBucket{At: at, Visits: r.Visits, Submitted: r.Submitted})
	}
	return out
}

// TimeBucket — точка ряда: сколько визитов и сколько из них закончились ответом.
type TimeBucket struct {
	At        time.Time
	Visits    int
	Submitted int
}

// LabelCount — строка списка (устройство, браузер, ОС): подпись, число визитов и
// сколько из них закончились ответом.
type LabelCount struct {
	Label     string
	Visits    int
	Submitted int
}

// SourceRow — сырьё источников из SQL: тройка меток и счётчик.
type SourceRow struct {
	Referer   string
	UTMSource string
	UTMMedium string
	Visits    int
	Submitted int
}

// SourceCount — строка списка источников: откуда пришли и каким каналом.
type SourceCount struct {
	Source    string
	Medium    string
	Visits    int
	Submitted int
}

// PlaceCount — строка списка стран или городов: название, код страны (для флага) и
// число визитов. У страны код — её собственный, у города — код его страны.
type PlaceCount struct {
	Name        string
	CountryCode string
	Visits      int
	Submitted   int
}

// UserAgentRow — сырьё разбора: строка user-agent и сколько визитов с ней пришло.
// Строк здесь сотни (различных агентов), а не по одной на визит, — поэтому разбор
// на чтении дёшев.
type UserAgentRow struct {
	UserAgent string
	Visits    int
	Submitted int
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
	type channel struct{ source, medium string }
	byKey := map[channel]*SourceCount{}
	for _, r := range rows {
		key := channel{sourceName(r), mediumName(r)}
		c := byKey[key]
		if c == nil {
			c = &SourceCount{Source: key.source, Medium: key.medium}
			byKey[key] = c
		}
		c.Visits += r.Visits
		c.Submitted += r.Submitted
	}
	out := make([]SourceCount, 0, len(byKey))
	for _, c := range byKey {
		out = append(out, *c)
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
	dev, br, os := map[string]*LabelCount{}, map[string]*LabelCount{}, map[string]*LabelCount{}
	for _, r := range rows {
		ua := ParseUserAgent(r.UserAgent)
		addLabel(dev, DeviceLabel(ua.Device), r)
		addLabel(br, orUnknown(ua.Browser), r)
		addLabel(os, orUnknown(ua.OS), r)
	}
	return toLabelCounts(dev), toLabelCounts(br), toLabelCounts(os)
}

func addLabel(m map[string]*LabelCount, label string, r UserAgentRow) {
	c := m[label]
	if c == nil {
		c = &LabelCount{Label: label}
		m[label] = c
	}
	c.Visits += r.Visits
	c.Submitted += r.Submitted
}

func orUnknown(s string) string {
	if s == "" {
		return unknownLabel
	}
	return s
}

func toLabelCounts(m map[string]*LabelCount) []LabelCount {
	out := make([]LabelCount, 0, len(m))
	for _, c := range m {
		out = append(out, *c)
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
	day := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	switch step {
	case StepHour:
		return t.Truncate(time.Hour)
	case StepWeek:
		// Неделя с понедельника — как в календаре кабинета. У Go воскресенье это
		// ноль, отсюда +6 перед остатком.
		return day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
	case StepMonth:
		return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	default:
		return day
	}
}

// nextBucket шагает по календарю, а не прибавлением 24 часов: сутки бывают длиннее
// и короче суток (переход времени), и арифметика на длительностях однажды даёт
// сдвинутую или задвоенную корзину.
func nextBucket(t time.Time, step BucketStep) time.Time {
	switch step {
	case StepHour:
		return t.Add(time.Hour)
	case StepWeek:
		return t.AddDate(0, 0, 7)
	case StepMonth:
		return t.AddDate(0, 1, 0)
	default:
		return t.AddDate(0, 0, 1)
	}
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
	// GeoConfigured — открыт ли справочник на контуре. Без него блок стран не
	// рисуется вовсе; с ним, но без единого определённого места, рисуется с
	// объяснением. Иначе выключенное гео и гео без данных выглядят одинаково —
	// как отсутствующая функция.
	GeoConfigured bool
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

// CoarsenScalePoints — то же укрупнение, что у ряда визитов, но для УРОВНЯ, а не
// количества: средние по корзинам складывать нельзя, их надо взвешивать числом
// ответов. Пустая корзина остаётся пустой — это разрыв линии, а не ноль.
//
// Нужно ровно по той же причине: ряд средней шкалы за «всё время» превращался в
// частокол из сотни дневных точек, скачущих вокруг одного уровня, — кардиограмму,
// из которой не следует ничего.
func CoarsenScalePoints(points []ScalePoint, step BucketStep) ([]ScalePoint, BucketStep) {
	for len(points) > MaxBuckets {
		next, ok := coarser(step)
		if !ok {
			return points, step
		}
		points, step = foldScalePoints(points, next), next
	}
	return points, step
}

func foldScalePoints(points []ScalePoint, step BucketStep) []ScalePoint {
	out := make([]ScalePoint, 0, len(points))
	// sums идёт рядом с out: в самой точке лежит уже средняя, а для взвешивания
	// нужна сумма. Держать её в ScalePoint значило бы вынести наружу черновик.
	sums := make([]float64, 0, len(points))
	for _, p := range points {
		at := truncateTo(p.At, step)
		if n := len(out); n > 0 && out[n-1].At.Equal(at) {
			sums[n-1] += p.Avg * float64(p.N)
			out[n-1].N += p.N
			continue
		}
		out = append(out, ScalePoint{At: at, N: p.N})
		sums = append(sums, p.Avg*float64(p.N))
	}
	for i := range out {
		if out[i].N > 0 {
			out[i].Avg = sums[i] / float64(out[i].N)
		}
	}
	return out
}
