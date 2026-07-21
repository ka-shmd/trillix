package forms

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

func getHTMLPage(t *testing.T, svc publicFormService, slug string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	newPublicHTMLMux(t, svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/"+slug, nil))
	return rec
}

func TestPublicHTML_Published_HasOGMeta(t *testing.T) {
	schema := json.RawMessage(`{"schemaVersion":1,"blocks":[
		{"id":"b1","type":"short_text","label":"Ваше имя"},
		{"id":"b2","type":"short_text","label":"Оценка"}]}`)
	svc := fakePublicSvc{pf: PublicForm{Title: "Опрос клиентов", Version: 1, Schema: schema, VersionID: uuid.New()}}

	rec := getHTMLPage(t, svc, "abc123")
	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, ожидался text/html", ct)
	}
	body := rec.Body.String()

	// OG-мета формы вставлена на место плейсхолдера.
	for _, want := range []string{
		`<meta property="og:title" content="Опрос клиентов">`,
		`<meta property="og:image" content="http://localhost:5174/og-preview.png">`,
		`<meta property="og:url" content="http://localhost:5174/r/abc123">`,
		`<meta property="og:description" content="Ваше имя · Оценка">`, // подзаголовок из блоков
		`<meta name="description" content="Ваше имя · Оценка">`,        // стандартный SEO-мета
		`<title>Опрос клиентов</title>`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("в HTML нет %q\n---\n%s", want, body)
		}
	}

	// Плейсхолдер заменён (не остался сырым), а не продублирован.
	if strings.Contains(body, ogMetaMarker) {
		t.Fatalf("плейсхолдер %q не заменён:\n%s", ogMetaMarker, body)
	}
	// Ровно один <title> (статичный из index.html убран, вставлен серверный).
	if n := strings.Count(body, "<title>"); n != 1 {
		t.Fatalf("ожидался ровно один <title>, найдено %d:\n%s", n, body)
	}
}

// Ассеты из собранного index.html доезжают в ответ ДОСЛОВНО — Go их не перечисляет.
// Лишний <link rel="preload"> в фикстуре, о котором Go «не знает», обязан присутствовать:
// это и есть DoD «добавление ассета в сборку не требует правок Go».
func TestPublicHTML_PreservesBuiltAssetsVerbatim(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{Title: "Форма", Version: 1, Schema: json.RawMessage(`{"blocks":[]}`), VersionID: uuid.New()}}
	body := getHTMLPage(t, svc, "abc").Body.String()

	for _, want := range []string{
		`<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,                // favicon (сейчас в проде сломан — тут чинится)
		`<script type="module" crossorigin src="/assets/index-ByZMBI6C.js"></script>`, // хешированный entry
		`<link rel="stylesheet" crossorigin href="/assets/index-mIztBLt-.css">`,       // хешированный CSS
		`<link rel="preload" href="/assets/font-a1b2c3.woff2"`,                        // ассет, которого Go не знает
		`<div id="root"></div>`, // точка монтирования SPA
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("в HTML нет ассета %q\n---\n%s", want, body)
		}
	}
}

// Инъекция в title не должна прорасти сырым тегом в HTML (html/template экранирует).
func TestPublicHTML_TitleInjection_Escaped(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{
		Title:     `Опрос "><script>alert(1)</script>`,
		Version:   1,
		Schema:    json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID: uuid.New(),
	}}

	body := getHTMLPage(t, svc, "abc").Body.String()
	if strings.Contains(body, "<script>alert(1)") {
		t.Fatalf("сырой инъектированный <script> в выводе:\n%s", body)
	}
	// Экранированная форма присутствует (значит title вставлен, но обезврежен).
	if !strings.Contains(body, "&lt;script&gt;alert(1)") {
		t.Fatalf("ожидался экранированный script в мете:\n%s", body)
	}
}

// Пустая форма без вопросов → og:description опускается (тизера нет), но
// стандартный <meta name="description"> присутствует с фолбэком (SEO).
func TestPublicHTML_NoBlocks_OmitsOGButKeepsMetaDescription(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{Title: "Пустая", Version: 1, Schema: json.RawMessage(`{"blocks":[]}`), VersionID: uuid.New()}}
	body := getHTMLPage(t, svc, "abc").Body.String()
	if strings.Contains(body, "og:description") {
		t.Fatalf("для формы без вопросов og:description не ожидался:\n%s", body)
	}
	if !strings.Contains(body, `<meta name="description" content="`+fallbackMetaDescription+`">`) {
		t.Fatalf("ожидался фолбэк-мета описания для пустой формы:\n%s", body)
	}
}

func TestPublicHTML_NotPublished_Returns404(t *testing.T) {
	svc := fakePublicSvc{err: domain.ErrNotFound}
	if code := getHTMLPage(t, svc, "draft").Code; code != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404 (черновик/закрытая по HTML-пути не раскрывается)", code)
	}
}

func TestOGDescriptionFromSchema(t *testing.T) {
	// Берёт текст до трёх непустых блоков-подписей (title/label, v2), пропускает
	// пустые, режет по рунам. Схема валидируется (апгрейд v1→v2 на лету).
	long := strings.Repeat("я", 250)
	title := func(id, text string) string {
		return `{"id":"` + id + `","groupId":"g_` + id + `","type":"title","text":"` + text + `"}`
	}
	cases := []struct {
		name   string
		schema string
		want   string
	}{
		{"три блока", `{"schemaVersion":2,"blocks":[` + title("a", "A") + `,` + title("b", "B") + `,` + title("c", "C") + `,` + title("d", "D") + `]}`, "A · B · C"},
		{"пустые пропускаются", `{"schemaVersion":2,"blocks":[` + title("a", "  ") + `,` + title("b", "X") + `]}`, "X"},
		{"нет блоков", `{"blocks":[]}`, ""},
		{"битая схема", `{oops`, ""},
		{"обрезка по рунам", `{"schemaVersion":2,"blocks":[` + title("a", long) + `]}`, string([]rune(long)[:200]) + "…"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ogDescriptionFromSchema(json.RawMessage(c.schema)); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

// --- Перечитывание собранного index.html (TD-29) ---
//
// Выкатка может обновить ТОЛЬКО статику: тег образа тот же → compose не пересоздаёт
// контейнер api → разобранный при старте документ остался бы старым навсегда, и
// форма отдавала бы прошлый HTML со ссылками на несуществующие ассеты. Молча, при
// зелёном деплое. Эти тесты сторожат перечитывание и его отказоустойчивость.

func TestPublicHTML_RereadsIndexWhenStaticRedeployed(t *testing.T) {
	path := writeFixtureIndex(t)
	svc := fakePublicSvc{pf: PublicForm{Title: "Форма", Version: 1,
		Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[]}`), VersionID: uuid.New()}}

	h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, path)
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.Routes(mux)
	get := func() string {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/abc", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("статус %d, ожидалось 200", rec.Code)
		}
		return rec.Body.String()
	}

	if body := get(); !strings.Contains(body, "index-ByZMBI6C.js") {
		t.Fatalf("до подмены в HTML нет ассета сборки:\n%s", body)
	}

	// Имитируем выкатку только статики: файл на диске заменён новой сборкой.
	updated := strings.Replace(builtIndexFixture, "index-ByZMBI6C.js", "index-Zq9NEW42.js", 1)
	if err := os.WriteFile(path, []byte(updated), 0o600); err != nil {
		t.Fatalf("подмена index.html: %v", err)
	}

	body := get()
	if !strings.Contains(body, "index-Zq9NEW42.js") {
		t.Fatalf("после подмены отдан СТАРЫЙ HTML (перечитывания нет):\n%s", body)
	}
	if strings.Contains(body, "index-ByZMBI6C.js") {
		t.Fatalf("в HTML остался ассет старой сборки:\n%s", body)
	}
	// OG-мета продолжает подставляться после перечитывания.
	if !strings.Contains(body, `<meta property="og:title" content="Форма">`) {
		t.Fatalf("после перечитывания пропала OG-мета:\n%s", body)
	}
}

func TestPublicHTML_BrokenIndexAfterStart_KeepsLastGood(t *testing.T) {
	path := writeFixtureIndex(t)
	svc := fakePublicSvc{pf: PublicForm{Title: "Форма", Version: 1,
		Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[]}`), VersionID: uuid.New()}}

	h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, path)
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.Routes(mux)

	// Файл испорчен уже после старта: rsync в процессе, обрезанная запись и т.п.
	// Публичная страница формы не имеет права превратиться в 500 из-за этого.
	if err := os.WriteFile(path, []byte("<html>без плейсхолдера и root</html>"), 0o600); err != nil {
		t.Fatalf("порча index.html: %v", err)
	}

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/abc", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200 (должен остаться последний удачный разбор)", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "index-ByZMBI6C.js") {
		t.Fatalf("не сохранён последний удачный разбор:\n%s", rec.Body.String())
	}
}
