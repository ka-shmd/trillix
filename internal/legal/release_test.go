//go:build release

package legal

import (
	"strings"
	"testing"
)

// Гейт тега (docs/design/signup-consent.md §3.4): в реестре не должно остаться черновых
// редакций. Черновик — текст с заглушками вместо реквизитов, и на проде он стал бы офертой
// без стороны. Под своим тегом сборки, а не в обычных тестах: на ветке с черновиками PR-CI
// обязан оставаться зелёным. Запуск — `make check-legal-release`, в CI — job
// legal-documents в release.yml.
func TestRegistryHasNoDrafts(t *testing.T) {
	eds, err := Editions()
	if err != nil {
		t.Fatalf("реестр документов: %v", err)
	}
	if drafts := DraftEditions(eds); len(drafts) > 0 {
		t.Fatalf("в реестре черновые редакции: %s — выкатывать нельзя, опубликуйте настоящие тексты (draft: false)",
			strings.Join(drafts, ", "))
	}
}
