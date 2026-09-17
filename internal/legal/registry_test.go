package legal

import (
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func TestEditions_RealRegistryIsValid(t *testing.T) {
	eds, err := Editions()
	if err != nil {
		t.Fatalf("Editions: %v", err)
	}
	kinds := map[Kind]bool{}
	for _, e := range eds {
		kinds[e.Kind] = true
		if e.Body == "" || e.SHA256 == "" {
			t.Errorf("%s/%s: пустое тело или хеш", e.Kind, e.Version)
		}
	}
	for _, k := range []Kind{KindTerms, KindPrivacy, KindMarketing} {
		if !kinds[k] {
			t.Errorf("в реестре нет ни одной редакции %s", k)
		}
	}
}

func TestBuildEditions(t *testing.T) {
	fsys := fstest.MapFS{
		"documents/terms/2026-09-17.txt": {Data: []byte("\r\nПервый абзац.\r\n\r\nВторой абзац.\r\n\n")},
	}
	ok := entry{kind: KindTerms, version: "2026-09-17", effectiveFrom: "2026-10-01", title: "Соглашение"}

	t.Run("нормализует текст и считает хеш от нормализованного", func(t *testing.T) {
		eds, err := buildEditions([]entry{ok}, fsys)
		if err != nil {
			t.Fatal(err)
		}
		if got, want := eds[0].Body, "Первый абзац.\n\nВторой абзац."; got != want {
			t.Errorf("Body = %q, want %q", got, want)
		}
		if eds[0].SHA256 != bodyHash("Первый абзац.\n\nВторой абзац.") {
			t.Error("хеш посчитан не от нормализованного текста")
		}
		wantAt := time.Date(2026, 10, 1, 0, 0, 0, 0, moscow)
		if !eds[0].EffectiveAt.Equal(wantAt) {
			t.Errorf("EffectiveAt = %v, want %v", eds[0].EffectiveAt, wantAt)
		}
	})

	cases := []struct {
		name    string
		entries []entry
		want    string
	}{
		{"неизвестный вид", []entry{{kind: "offer", version: "2026-09-17", effectiveFrom: "2026-09-17", title: "x"}}, "неизвестный вид"},
		{"дубль", []entry{ok, ok}, "дважды"},
		{"версия не дата", []entry{{kind: KindTerms, version: "2026-9-17", effectiveFrom: "2026-09-17", title: "x"}}, "версия"},
		{"несуществующая дата", []entry{{kind: KindTerms, version: "2026-02-30", effectiveFrom: "2026-09-17", title: "x"}}, "версия"},
		{"дата вступления", []entry{{kind: KindTerms, version: "2026-09-17", effectiveFrom: "", title: "x"}}, "вступления"},
		{"без заголовка", []entry{{kind: KindTerms, version: "2026-09-17", effectiveFrom: "2026-09-17", title: " "}}, "заголовка"},
		{"нет файла", []entry{{kind: KindPrivacy, version: "2026-09-17", effectiveFrom: "2026-09-17", title: "x"}}, "текст редакции privacy/2026-09-17"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := buildEditions(tc.entries, fsys)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want containing %q", err, tc.want)
			}
		})
	}

	t.Run("пустой текст", func(t *testing.T) {
		empty := fstest.MapFS{"documents/terms/2026-09-17.txt": {Data: []byte(" \n\n ")}}
		_, err := buildEditions([]entry{ok}, empty)
		if err == nil || !strings.Contains(err.Error(), "пуст") {
			t.Fatalf("err = %v", err)
		}
	})
}
