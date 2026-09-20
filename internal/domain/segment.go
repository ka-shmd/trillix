package domain

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Сегмент визитов (спека design/analytics-v2.md §5.4, analytics-v3.md §11.6): одно
// значение одного измерения — «только телефоны», «только из vk.com», «только версия 3».
// Набор измерений закрытый (ADR §10: разрезы — фиксированный набор), свободного
// конструктора нет.
//
// Условий бывает НЕСКОЛЬКО, и они складываются через «И» (Segments): «телефоны из
// vk.com». Это не конструктор «любое × любое» — измерения остаются теми же семью, а
// куба по ним не строится: каждое условие сводится к своему списку сырых значений, и
// SQL проверяет их все одним проходом по тем же визитам.
//
// Устройство, браузер, систему и источник база не хранит: их выводит Go из сырых
// user_agent и меток на чтении, чтобы улучшенное правило разбора чинило прошлое.
// Поэтому сегмент сводится к ФИЛЬТРУ ПО СЫРЫМ ЗНАЧЕНИЯМ (VisitFilter): Go перебирает
// сырые значения периода, отбирает подходящие, и SQL режет визиты по их списку.

// SegmentDim — измерение сегмента. Значение уезжает в адрес экрана.
type SegmentDim string

const (
	SegDevice  SegmentDim = "device"
	SegBrowser SegmentDim = "browser"
	SegOS      SegmentDim = "os"
	SegSource  SegmentDim = "source"
	SegCountry SegmentDim = "country"
	// SegCity — значение «RU:Москва»: одноимённые города разных стран — разные места.
	SegCity SegmentDim = "city"
	// SegVersion — значение — номер версии формы.
	SegVersion SegmentDim = "version"
)

var segmentDims = []SegmentDim{SegDevice, SegBrowser, SegOS, SegSource, SegCountry, SegCity, SegVersion}

// Segment — выбранный сегмент; нулевое значение — «все визиты».
type Segment struct {
	Dim   SegmentDim
	Value string
}

func (s Segment) IsZero() bool { return s.Dim == "" }

// Segments — условия разреза, соединённые «И». Пустой срез — все визиты.
type Segments []Segment

func (ss Segments) IsZero() bool { return len(ss) == 0 }

// MaxSegments — потолок условий в запросе. Измерений семь, и больше семи условий
// не бывает осмысленных; потолок стоит не ради смысла, а ради размера запроса:
// каждое условие — свой список сырых значений в массиве параметра.
const MaxSegments = 7

// ParseSegments разбирает повторяющийся параметр `segment`. Пустые значения
// пропускаются: ссылка с «?segment=» — это отсутствие разреза, а не ошибка.
//
// Повторы измерения не отвергаются: «устройство=Телефон И устройство=Планшет» даёт
// пустую выборку, но это правдивый ответ, а не повод показать экран ошибки на
// присланную ссылку. Экран такую пару не строит (одно условие на измерение).
func ParseSegments(raw []string) (Segments, error) {
	out := make(Segments, 0, len(raw))
	for _, r := range raw {
		seg, err := ParseSegment(r)
		if err != nil {
			return nil, err
		}
		if seg.IsZero() {
			continue
		}
		out = append(out, seg)
	}
	if len(out) > MaxSegments {
		return nil, fmt.Errorf("%w: слишком много условий разреза", ErrValidation)
	}
	return out, nil
}

// maxSegmentValueLen — потолок значения: подпись источника приходит из меток визита,
// а те обрезаются до 512 символов на приёме.
const maxSegmentValueLen = 512

// ParseSegment разбирает «измерение:значение». Пустая строка — сегмента нет.
func ParseSegment(raw string) (Segment, error) {
	if raw == "" {
		return Segment{}, nil
	}
	dim, value, ok := strings.Cut(raw, ":")
	if !ok || value == "" || utf8.RuneCountInString(value) > maxSegmentValueLen || !utf8.ValidString(value) {
		return Segment{}, fmt.Errorf("%w: неверный сегмент", ErrValidation)
	}
	d := SegmentDim(dim)
	valid := false
	for _, known := range segmentDims {
		if d == known {
			valid = true
			break
		}
	}
	if !valid {
		return Segment{}, fmt.Errorf("%w: неизвестное измерение сегмента", ErrValidation)
	}
	switch d {
	case SegVersion:
		if n, err := strconv.Atoi(value); err != nil || n < 1 {
			return Segment{}, fmt.Errorf("%w: неверный номер версии", ErrValidation)
		}
	case SegCity:
		if code, name, ok := strings.Cut(value, ":"); !ok || code == "" || name == "" {
			return Segment{}, fmt.Errorf("%w: неверный город", ErrValidation)
		}
	}
	return Segment{Dim: d, Value: value}, nil
}

// FilterKind — какое сырое значение визита сравнивается со списком. Зеркалит CASE по
// seg_dim в internal/visits/queries.sql: разъедься ключ здесь и там — сегмент молча
// перестанет совпадать с визитами.
type FilterKind string

const (
	FilterUserAgent FilterKind = "ua"
	FilterSource    FilterKind = "source"
	FilterCountry   FilterKind = "country"
	FilterCity      FilterKind = "city"
	FilterVersion   FilterKind = "version"
)

// VisitFilter — сегмент, сведённый к сырым значениям. Нулевой — фильтра нет; Kind с
// пустым Keys — сегмент, которому в периоде не подошёл ни один визит (ноль, а не «все»).
type VisitFilter struct {
	Kind FilterKind
	Keys []string
}

func (f VisitFilter) IsZero() bool { return f.Kind == "" }

// keySep — разделитель частей составного ключа (тройка меток, город со страной).
// Управляющий символ: в метках и названиях его не бывает.
const keySep = "\x1f"

// slotSep — разделитель «номер условия — ключ» в массиве seg_keys. Зеркалит chr(30)
// в internal/visits/queries.sql; отличен от keySep, потому что сам ключ бывает
// составным и keySep внутри себя уже содержит.
const slotSep = "\x1e"

// SourceKey — ключ тройки меток источника, как его собирает SQL.
func SourceKey(r SourceRow) string {
	return r.Referer + keySep + r.UTMSource + keySep + r.UTMMedium
}

// CityKey — ключ города, как его собирает SQL.
func CityKey(city, countryCode string) string { return city + keySep + countryCode }

// UserAgentFilter — строки user-agent периода, чьё устройство, браузер или система
// совпадают со значением сегмента (той же подписью, что в разбивке «Визитов»).
func UserAgentFilter(seg Segment, rows []UserAgentRow) VisitFilter {
	f := VisitFilter{Kind: FilterUserAgent, Keys: []string{}}
	for _, r := range rows {
		ua := ParseUserAgent(r.UserAgent)
		var label string
		switch seg.Dim {
		case SegDevice:
			label = DeviceLabel(ua.Device)
		case SegBrowser:
			label = orUnknown(ua.Browser)
		case SegOS:
			label = orUnknown(ua.OS)
		}
		if label == seg.Value {
			f.Keys = append(f.Keys, r.UserAgent)
		}
	}
	return f
}

// SourceFilter — тройки меток периода, которые складываются в этот источник (той же
// подписью, что в разбивке, без канала: «vk.com» — все каналы vk.com).
func SourceFilter(seg Segment, rows []SourceRow) VisitFilter {
	f := VisitFilter{Kind: FilterSource, Keys: []string{}}
	for _, r := range rows {
		if sourceName(r) == seg.Value {
			f.Keys = append(f.Keys, SourceKey(r))
		}
	}
	return f
}

// PackFilters — условия разреза в два параметра запроса: вид сырого значения у
// каждого условия (seg_kinds) и подходящие значения ВСЕХ условий одним массивом
// (seg_keys), где у каждого ключа спереди номер своего условия.
//
// НОМЕР, А НЕ ВИД: «устройство» и «браузер» оба читают user-agent, и по общему виду
// их списки слились бы в один — «И» между условиями стало бы «ИЛИ».
//
// Условие, которому в периоде не подошло ни одного значения, не даёт в массив ни
// одного ключа: его номер не встретится, и подходящих визитов не будет. Сам массив
// при этом НЕ nil — nil уезжает в SQL как NULL, сравнение с NULL даёт NULL, и
// «ноль визитов» превратилось бы в «фильтра нет».
func PackFilters(fs []VisitFilter) (kinds, keys []string) {
	if len(fs) == 0 {
		return nil, nil
	}
	kinds = make([]string, 0, len(fs))
	keys = []string{}
	for i, f := range fs {
		kinds = append(kinds, string(f.Kind))
		prefix := strconv.Itoa(i+1) + slotSep
		for _, k := range f.Keys {
			keys = append(keys, prefix+k)
		}
	}
	return kinds, keys
}

// PlaceFilter — сегмент по стране или городу: ключ строится из самого значения.
func PlaceFilter(seg Segment) VisitFilter {
	if seg.Dim == SegCity {
		code, name, _ := strings.Cut(seg.Value, ":")
		return VisitFilter{Kind: FilterCity, Keys: []string{CityKey(name, code)}}
	}
	return VisitFilter{Kind: FilterCountry, Keys: []string{seg.Value}}
}

// VisitMeta — сырые метки визита, из которого пришёл ответ (спека
// design/analytics-v2.md §6.4). Разбираются теми же правилами, что разбивки визитов.
type VisitMeta struct {
	UserAgent   string
	Referer     string
	UTMSource   string
	UTMMedium   string
	CountryCode string
	City        string
}

// Source — источник визита подписью разбивки («vk.com», «Прямые заходы»).
func (m VisitMeta) Source() string {
	return sourceName(SourceRow{Referer: m.Referer, UTMSource: m.UTMSource, UTMMedium: m.UTMMedium})
}

// Device — класс устройства подписью разбивки («Компьютер», «Телефон»).
func (m VisitMeta) Device() string { return DeviceLabel(ParseUserAgent(m.UserAgent).Device) }

// Matches — подходит ли ответ ВСЕМ условиям разреза.
func (ss Segments) Matches(visit *VisitMeta, version int) bool {
	for _, seg := range ss {
		if !MatchesSegment(seg, visit, version) {
			return false
		}
	}
	return true
}

// MatchesSegment — подходит ли ответ сегменту. visit nil — ответ без визита: в
// визитный сегмент он не попадает. Версия — своя у ответа (номер версии, по которой он
// отправлен), визит для неё не нужен.
func MatchesSegment(seg Segment, visit *VisitMeta, version int) bool {
	if seg.IsZero() {
		return true
	}
	if seg.Dim == SegVersion {
		return strconv.Itoa(version) == seg.Value
	}
	if visit == nil {
		return false
	}
	ua := ParseUserAgent(visit.UserAgent)
	switch seg.Dim {
	case SegDevice:
		return DeviceLabel(ua.Device) == seg.Value
	case SegBrowser:
		return orUnknown(ua.Browser) == seg.Value
	case SegOS:
		return orUnknown(ua.OS) == seg.Value
	case SegSource:
		return visit.Source() == seg.Value
	case SegCountry:
		return visit.CountryCode == seg.Value
	case SegCity:
		code, name, _ := strings.Cut(seg.Value, ":")
		return visit.CountryCode == code && visit.City == name
	default:
		return false
	}
}

// SegmentK — меньше скольких ответов визитный сегмент не раскрывается (ADR §10, спека
// §7): узкий разрез ответов по месту и устройству указывает на человека. Сегмент по
// версии визитным не считается — версия своя у ответа.
const SegmentK = 5

// VisitSegment — сегмент, раскрытие которого ограничено SegmentK.
func (s Segment) VisitSegment() bool { return !s.IsZero() && s.Dim != SegVersion }

// VisitSegment — хотя бы одно условие визитное: порог SegmentK ставит любое из них,
// а не только одиночное.
func (ss Segments) VisitSegment() bool {
	for _, seg := range ss {
		if seg.VisitSegment() {
			return true
		}
	}
	return false
}
