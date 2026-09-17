package legal

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Kind — вид документа. Значения совпадают с CHECK legal_documents (0071) и с путём
// публичной ручки.
type Kind string

const (
	KindTerms     Kind = "terms"
	KindPrivacy   Kind = "privacy"
	KindMarketing Kind = "marketing"
)

// ParseKind — белый список видов: произвольная строка из URL в запрос не попадает.
func ParseKind(s string) (Kind, bool) {
	switch k := Kind(s); k {
	case KindTerms, KindPrivacy, KindMarketing:
		return k, true
	}
	return "", false
}

// Edition — редакция документа.
type Edition struct {
	// ID — строка legal_documents; uuid.Nil у редакции из реестра, ещё не прочитанной из базы.
	ID   uuid.UUID
	Kind Kind
	// Version — дата редакции (YYYY-MM-DD): имя файла и значение ?version=.
	Version string
	Title   string
	Body    string
	// SHA256 — hex от Body.
	SHA256      string
	EffectiveAt time.Time
	// RequiresReacceptance — новая редакция закрывает кабинет до принятия. Смысл имеет
	// только у terms: политика не договор, согласие на рассылки остаётся привязанным к
	// своей редакции.
	RequiresReacceptance bool
	// Draft — черновик: при старте перезаписывается из файла. Публиковать черновик
	// нельзя — релизный workflow тега падает, если он есть в реестре.
	Draft bool
}

// VersionRef — строка архива редакций.
type VersionRef struct {
	Version     string
	EffectiveAt time.Time
}

//go:embed documents
var documentsFS embed.FS

// entry — строка реестра; тело лежит в documents/<kind>/<version>.txt.
type entry struct {
	kind                 Kind
	version              string
	effectiveFrom        string
	title                string
	requiresReacceptance bool
	draft                bool
}

// registry — все редакции документов. Новая редакция — новая строка и новый файл с новой
// датой; поправить опубликованную нельзя (API не стартует, см. Service.Sync).
var registry = []entry{
	{
		kind: KindTerms, version: "2026-09-17", effectiveFrom: "2026-09-17",
		title:                "Пользовательское соглашение",
		requiresReacceptance: true, draft: true,
	},
	{
		kind: KindPrivacy, version: "2026-09-17", effectiveFrom: "2026-09-17",
		title: "Политика обработки персональных данных",
		draft: true,
	},
	{
		kind: KindMarketing, version: "2026-09-17", effectiveFrom: "2026-09-17",
		title: "Согласие на получение рекламных и информационных рассылок",
		draft: true,
	},
}

// Editions — редакции реестра с телами из репозитория. Ошибка означает битый реестр и
// останавливает старт API.
func Editions() ([]Edition, error) {
	return buildEditions(registry, documentsFS)
}

var datePattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// moscow — пояс, в котором редакция вступает в силу с начала дня. Фиксированное смещение,
// а не time.LoadLocation: в Москве нет перехода на летнее время с 2014 года, а пакет не
// зависит от tzdata системы.
var moscow = time.FixedZone("MSK", 3*60*60)

func buildEditions(entries []entry, fsys fs.FS) ([]Edition, error) {
	seen := make(map[string]bool, len(entries))
	out := make([]Edition, 0, len(entries))
	for _, e := range entries {
		key := string(e.kind) + "/" + e.version
		if _, ok := ParseKind(string(e.kind)); !ok {
			return nil, fmt.Errorf("legal: неизвестный вид документа %q", e.kind)
		}
		if seen[key] {
			return nil, fmt.Errorf("legal: редакция %s в реестре дважды", key)
		}
		seen[key] = true
		if _, err := parseDate(e.version); err != nil {
			return nil, fmt.Errorf("legal: версия редакции %s: %w", key, err)
		}
		effective, err := parseDate(e.effectiveFrom)
		if err != nil {
			return nil, fmt.Errorf("legal: дата вступления в силу редакции %s: %w", key, err)
		}
		if strings.TrimSpace(e.title) == "" {
			return nil, fmt.Errorf("legal: у редакции %s нет заголовка", key)
		}
		raw, err := fs.ReadFile(fsys, path.Join("documents", string(e.kind), e.version+".txt"))
		if err != nil {
			return nil, fmt.Errorf("legal: текст редакции %s: %w", key, err)
		}
		if !utf8.Valid(raw) {
			return nil, fmt.Errorf("legal: текст редакции %s не в UTF-8", key)
		}
		body := normalizeBody(raw)
		if body == "" {
			return nil, fmt.Errorf("legal: текст редакции %s пуст", key)
		}
		out = append(out, Edition{
			Kind:                 e.kind,
			Version:              e.version,
			Title:                e.title,
			Body:                 body,
			SHA256:               bodyHash(body),
			EffectiveAt:          effective,
			RequiresReacceptance: e.requiresReacceptance,
			Draft:                e.draft,
		})
	}
	return out, nil
}

func parseDate(s string) (time.Time, error) {
	if !datePattern.MatchString(s) {
		return time.Time{}, fmt.Errorf("%q — не дата YYYY-MM-DD", s)
	}
	t, err := time.ParseInLocation(time.DateOnly, s, moscow)
	if err != nil {
		return time.Time{}, fmt.Errorf("%q — не дата: %w", s, err)
	}
	return t, nil
}

// normalizeBody — единственная нормализация текста перед хешем: переводы строк Windows и
// пробелы по краям. Мина: изменить её — значит изменить SHA-256 всех опубликованных
// редакций, и API перестанет стартовать.
func normalizeBody(raw []byte) string {
	return strings.TrimSpace(strings.ReplaceAll(string(raw), "\r\n", "\n"))
}

func bodyHash(body string) string {
	sum := sha256.Sum256([]byte(body))
	return hex.EncodeToString(sum[:])
}
