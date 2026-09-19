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
