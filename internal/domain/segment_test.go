package domain

import (
	"errors"
	"reflect"
	"testing"
)

func TestParseSegment(t *testing.T) {
	good := map[string]Segment{
		"":                      {},
		"device:Телефон":        {Dim: SegDevice, Value: "Телефон"},
		"source:vk.com":         {Dim: SegSource, Value: "vk.com"},
		"city:RU:Москва":        {Dim: SegCity, Value: "RU:Москва"},
		"version:3":             {Dim: SegVersion, Value: "3"},
		"source:a:b:c":          {Dim: SegSource, Value: "a:b:c"},
		"browser:Не определено": {Dim: SegBrowser, Value: "Не определено"},
	}
	for raw, want := range good {
		got, err := ParseSegment(raw)
		if err != nil || got != want {
			t.Errorf("ParseSegment(%q) = %+v, %v; ждали %+v", raw, got, err, want)
		}
	}
	for _, raw := range []string{"device", "device:", "planet:Марс", "version:0", "version:x", "city:Москва", "city::Москва"} {
		if _, err := ParseSegment(raw); !errors.Is(err, ErrValidation) {
			t.Errorf("ParseSegment(%q): ошибка %v, ждали ErrValidation", raw, err)
		}
	}
}

func TestUserAgentFilter(t *testing.T) {
	const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	rows := []UserAgentRow{{UserAgent: iphone}, {UserAgent: desktop}}

	got := UserAgentFilter(Segment{Dim: SegDevice, Value: "Телефон"}, rows)
	if got.Kind != FilterUserAgent || !reflect.DeepEqual(got.Keys, []string{iphone}) {
		t.Errorf("телефоны: %+v", got)
	}
	// Ни одного подходящего агента — пустой список, а не отсутствие фильтра: иначе
	// сегмент без визитов показал бы все визиты.
	none := UserAgentFilter(Segment{Dim: SegOS, Value: "BeOS"}, rows)
	if none.IsZero() || none.Keys == nil || len(none.Keys) != 0 {
		t.Errorf("пустой сегмент: %+v", none)
	}
}

func TestSourceFilter(t *testing.T) {
	rows := []SourceRow{
		{Referer: "https://vk.com/feed"},
		{Referer: "https://www.vk.com/", UTMMedium: "social"},
		{UTMSource: "newsletter"},
		{},
	}
	got := SourceFilter(Segment{Dim: SegSource, Value: "vk.com"}, rows)
	want := []string{SourceKey(rows[0]), SourceKey(rows[1])}
	if !reflect.DeepEqual(got.Keys, want) {
		t.Errorf("vk.com: %q, ждали %q", got.Keys, want)
	}
	direct := SourceFilter(Segment{Dim: SegSource, Value: "Прямые заходы"}, rows)
	if !reflect.DeepEqual(direct.Keys, []string{SourceKey(rows[3])}) {
		t.Errorf("прямые заходы: %q", direct.Keys)
	}
}

func TestPlaceFilter(t *testing.T) {
	if got := PlaceFilter(Segment{Dim: SegCity, Value: "RU:Москва"}); got.Kind != FilterCity || got.Keys[0] != CityKey("Москва", "RU") {
		t.Errorf("город: %+v", got)
	}
	if got := PlaceFilter(Segment{Dim: SegCountry, Value: "RU"}); got.Kind != FilterCountry || got.Keys[0] != "RU" {
		t.Errorf("страна: %+v", got)
	}
}

func TestMatchesSegment(t *testing.T) {
	const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	v := &VisitMeta{UserAgent: phone, Referer: "https://vk.com/x", CountryCode: "RU", City: "Москва"}
	for raw, want := range map[string]bool{
		"device:Телефон":   true,
		"device:Компьютер": false,
		"source:vk.com":    true,
		"country:RU":       true,
		"city:RU:Москва":   true,
		"city:BY:Москва":   false,
		"version:2":        true,
		"version:1":        false,
	} {
		seg, _ := ParseSegment(raw)
		if got := MatchesSegment(seg, v, 2); got != want {
			t.Errorf("%s: %v, ждали %v", raw, got, want)
		}
	}
	// Ответ без визита в визитный сегмент не попадает, в сегмент версии — да.
	dev, _ := ParseSegment("device:Телефон")
	ver, _ := ParseSegment("version:2")
	if MatchesSegment(dev, nil, 2) || !MatchesSegment(ver, nil, 2) {
		t.Error("ответ без визита")
	}
}

// Условий разреза бывает несколько, и приезжают они повторяющимся параметром.
func TestParseSegments(t *testing.T) {
	got, err := ParseSegments([]string{"device:Телефон", "", "source:vk.com"})
	want := Segments{{Dim: SegDevice, Value: "Телефон"}, {Dim: SegSource, Value: "vk.com"}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Errorf("ParseSegments = %+v, %v; ждали %+v", got, err, want)
	}
	if segs, err := ParseSegments(nil); err != nil || !segs.IsZero() {
		t.Errorf("без параметра: %+v, %v", segs, err)
	}
	// Одно негодное условие отвергает весь запрос: молча выбросить его значило бы
	// посчитать по более широкой совокупности, чем просили.
	if _, err := ParseSegments([]string{"device:Телефон", "planet:Марс"}); !errors.Is(err, ErrValidation) {
		t.Errorf("негодное условие: %v, ждали ErrValidation", err)
	}
	over := make([]string, MaxSegments+1)
	for i := range over {
		over[i] = "device:Телефон"
	}
	if _, err := ParseSegments(over); !errors.Is(err, ErrValidation) {
		t.Errorf("сверх потолка: %v, ждали ErrValidation", err)
	}
}

// Ответ проходит разрез, только если подходит ВСЕМ условиям.
func TestSegmentsMatches(t *testing.T) {
	const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	v := &VisitMeta{UserAgent: phone, Referer: "https://vk.com/x", CountryCode: "RU", City: "Москва"}
	all := func(raw ...string) bool {
		segs, err := ParseSegments(raw)
		if err != nil {
			t.Fatal(err)
		}
		return segs.Matches(v, 2)
	}
	if !all("device:Телефон", "source:vk.com") {
		t.Error("оба условия подходят, а ответ не прошёл")
	}
	if all("device:Телефон", "country:BY") {
		t.Error("одно условие не подошло, а ответ прошёл")
	}
	if !all() {
		t.Error("пустой разрез не пропустил ответ")
	}
	// Порог SegmentK ставит любое визитное условие, а не только одиночное.
	segs, _ := ParseSegments([]string{"version:2", "device:Телефон"})
	if !segs.VisitSegment() {
		t.Error("визитное условие в паре с версией не считается визитным")
	}
	verOnly, _ := ParseSegments([]string{"version:2"})
	if verOnly.VisitSegment() {
		t.Error("разрез по версии визитным не считается")
	}
}

// PackFilters — два массива параметра запроса; зеркалит предикат в
// internal/visits/queries.sql.
func TestPackFilters(t *testing.T) {
	kinds, keys := PackFilters([]VisitFilter{
		{Kind: FilterUserAgent, Keys: []string{"ua-1", "ua-2"}},
		{Kind: FilterCountry, Keys: []string{"RU"}},
	})
	if !reflect.DeepEqual(kinds, []string{"ua", "country"}) {
		t.Errorf("виды = %v", kinds)
	}
	// Номер условия спереди: без него два условия по одному виду слились бы в одно
	// множество, и «И» стало бы «ИЛИ».
	want := []string{"1\x1eua-1", "1\x1eua-2", "2\x1eRU"}
	if !reflect.DeepEqual(keys, want) {
		t.Errorf("ключи = %q, ждали %q", keys, want)
	}

	// Условие без подходящих значений не даёт ни одного ключа — визитов будет ноль.
	// Массив при этом не nil: nil уезжает в SQL как NULL, а это «фильтра нет».
	kinds, keys = PackFilters([]VisitFilter{{Kind: FilterSource, Keys: []string{}}})
	if len(kinds) != 1 || keys == nil || len(keys) != 0 {
		t.Errorf("пустое условие: виды %v, ключи %#v", kinds, keys)
	}

	if kinds, keys := PackFilters(nil); kinds != nil || keys != nil {
		t.Errorf("без условий: %v, %v — ждали NULL-параметры", kinds, keys)
	}
}
