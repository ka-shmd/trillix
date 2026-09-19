package domain

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Сегмент визитов (спека design/analytics-v2.md §5.4): одно значение одного измерения —
// «только телефоны», «только из vk.com», «только версия 3». Набор измерений закрытый
// (ADR §10: разрезы — фиксированный набор), свободного конструктора нет.
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
