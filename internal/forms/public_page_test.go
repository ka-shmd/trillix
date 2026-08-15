package forms

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
		{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Ваше имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text"},
		{"id":"t_b2","groupId":"g_b2","type":"title","text":[{"t":"Оценка"}]},{"id":"b2","groupId":"g_b2","type":"short_text"}]}`)
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
		return `{"id":"` + id + `","groupId":"g_` + id + `","type":"title","text":[{"t":"` + text + `"}]}`
	}
	cases := []struct {
		name   string
		schema string
		want   string
	}{
		{"три блока", `{"schemaVersion":1,"blocks":[` + title("a", "A") + `,` + title("b", "B") + `,` + title("c", "C") + `,` + title("d", "D") + `]}`, "A · B · C"},
		{"пустые пропускаются", `{"schemaVersion":1,"blocks":[` + title("a", "  ") + `,` + title("b", "X") + `]}`, "X"},
		{"нет блоков", `{"blocks":[]}`, ""},
		{"битая схема", `{oops`, ""},
		{"обрезка по рунам", `{"schemaVersion":1,"blocks":[` + title("a", long) + `]}`, string([]rune(long)[:200]) + "…"},
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
	svc := fakePublicSvc{pf: PublicForm{
		Title:     "Форма",
		Version:   1,
		Schema:    json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID: uuid.New(),
	}}

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
	svc := fakePublicSvc{pf: PublicForm{
		Title:     "Форма",
		Version:   1,
		Schema:    json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID: uuid.New(),
	}}

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

// Инвариант «документ всегда загружен» живёт в Routes (другой файл): /r
// регистрируется только когда index прочитан при старте. Если его когда-нибудь
// нарушат, getHTML не должен разыменовывать nil — паника даёт 500 без объяснения.
func TestPublicHTML_NoIndexLoaded_Returns500NotPanic(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{
		Title:     "Форма",
		Version:   1,
		Schema:    json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID: uuid.New(),
	}}
	// Собираем «невозможное» состояние руками: путь задан, документ не загружен.
	h := &PublicHandler{svc: svc, indexPath: filepath.Join(t.TempDir(), "нет-такого.html"), now: time.Now}

	rec := httptest.NewRecorder()
	h.getHTML(rec, httptest.NewRequest(http.MethodGet, "/r/abc", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("статус %d, ожидалось 500", rec.Code)
	}
}

// --- Оформление формы в оболочке страницы (фаза 22, слайс 5) ---
//
// Рендерер это SPA: схема приезжает вторым запросом, и без серверной вставки тёмная
// форма мигала бы белой. Проверяем не «есть подстрока», а весь контракт первого
// кадра: класс темы и переменные на <html>, theme-color, preload выбранного шрифта.

// designFixtureIndex кладёт рядом с index.html каталог assets с хешированными
// шрифтами — как это делает сборка.
func writeFixtureIndexWithFonts(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "index.html")
	if err := os.WriteFile(path, []byte(builtIndexFixture), 0o600); err != nil {
		t.Fatalf("запись фикстуры index.html: %v", err)
	}
	assets := filepath.Join(dir, "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatalf("создание каталога ассетов: %v", err)
	}
	for _, name := range []string{
		"inter-cyrillic-DqGufNeO.woff2",
		"inter-latin-Dx4kXJAl.woff2",
		"golos-cyrillic-mKek_fSS.woff2",
		"golos-latin-BS5oQT7X.woff2",
		"index-mIztBLt-.css",
	} {
		if err := os.WriteFile(filepath.Join(assets, name), []byte("x"), 0o600); err != nil {
			t.Fatalf("запись ассета %s: %v", name, err)
		}
	}
	return path
}

func getHTMLPageWithFonts(t *testing.T, svc publicFormService) string {
	t.Helper()
	h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, writeFixtureIndexWithFonts(t))
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.Routes(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/abc", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", rec.Code)
	}
	return rec.Body.String()
}

func designedForm(t *testing.T, design string) fakePublicSvc {
	t.Helper()
	schema := json.RawMessage(`{"schemaVersion":1,"blocks":[],"design":` + design + `}`)
	if _, err := domain.ValidateSchema(schema); err != nil {
		t.Fatalf("фикстура схемы не проходит валидатор: %v", err)
	}
	return fakePublicSvc{pf: PublicForm{Title: "Форма", Version: 1, Schema: schema, VersionID: uuid.New()}}
}

func TestPublicHTML_DarkTheme_ShellIsThemedFromFirstFrame(t *testing.T) {
	svc := designedForm(t, `{"theme":"dark","palette":{"accent":"#12ab34"},"font":"inter"}`)
	body := getHTMLPageWithFonts(t, svc)

	for _, want := range []string{
		// Класс темы — на <html>: color-scheme и все тёмные дефолты живут в нём.
		`<html lang="ru" class="rf-theme-dark" style="`,
		// Свой цвет автора — инлайном, ровно как его наденет клиент.
		`--rf-accent: #12ab34;`,
		// Строка браузера красится холстом темы.
		`<meta name="theme-color" content="oklch(0.19 0.006 60)">`,
		// Шрифт формы известен только серверу — оба подмножества уходят в preload.
		`<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/inter-cyrillic-DqGufNeO.woff2">`,
		`<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/inter-latin-Dx4kXJAl.woff2">`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("в HTML нет %q\n---\n%s", want, body)
		}
	}
	// Чужого семейства в preload быть не должно: качается только выбранное.
	if strings.Contains(body, "golos-") {
		t.Fatalf("в preload попал невыбранный шрифт:\n%s", body)
	}
}

// Форма, у которой оформление не трогали, обязана отдаваться без следов оболочки:
// плейсхолдер исчезает вместе со своим пробелом, ни класса, ни стиля, ни theme-color.
//
// ИСКЛЮЧЕНИЕ — preload дефолтного семейства: с 2026-08-15 форма без настроек набрана
// не системным стеком, а Inter (DesignFontDefault), и качать его надо тем более —
// таких форм большинство. Всё остальное в этом списке по-прежнему признак того, что
// автор что-то настраивал.
func TestPublicHTML_NoDesign_ShellUnchanged(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{
		Title:     "Форма",
		Version:   1,
		Schema:    json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID: uuid.New(),
	}}
	body := getHTMLPageWithFonts(t, svc)

	if !strings.Contains(body, "<html lang=\"ru\">\n") {
		t.Fatalf("тег <html> изменился у формы без оформления:\n%s", body)
	}
	for _, unwanted := range []string{"rf-theme", "--rf-", "theme-color", "golos-"} {
		if strings.Contains(body, unwanted) {
			t.Fatalf("у формы без оформления в HTML появилось %q:\n%s", unwanted, body)
		}
	}
	for _, want := range []string{"inter-cyrillic", "inter-latin"} {
		if !strings.Contains(body, want) {
			t.Fatalf("нет preload дефолтного семейства (%s):\n%s", want, body)
		}
	}
	if strings.Contains(body, shellMarker) {
		t.Fatalf("плейсхолдер оболочки %q не заменён:\n%s", shellMarker, body)
	}
}

// Светлая тема — это ОТСУТСТВИЕ ключа theme, поэтому у формы, где автор поменял
// только цвета, класса нет, а переменные есть. И theme-color берётся из холста
// автора, а не из темы.
func TestPublicHTML_LightThemeWithPalette_StyleOnlyNoClass(t *testing.T) {
	svc := designedForm(t, `{"palette":{"canvas":"#fff8e7"}}`)
	body := getHTMLPageWithFonts(t, svc)

	if !strings.Contains(body, `<html lang="ru" style="--rf-canvas: #fff8e7;">`) {
		t.Fatalf("ожидался тег <html> только со стилем:\n%s", body)
	}
	if !strings.Contains(body, `<meta name="theme-color" content="#fff8e7">`) {
		t.Fatalf("theme-color должен браться из холста автора:\n%s", body)
	}
}

// Шрифт выбран, а сборки рядом нет (тот же путь, что «файл переименовали»):
// страница отдаётся как обычно, просто без preload. Лишний <link> на
// несуществующий адрес был бы хуже — 404 в консоли респондента и потерянная
// предзагрузка.
func TestPublicHTML_FontChosenButAssetsMissing_NoPreload(t *testing.T) {
	svc := designedForm(t, `{"font":"golos"}`)
	body := getHTMLPage(t, svc, "abc").Body.String() // фикстура без каталога assets

	if strings.Contains(body, "rel=\"preload\" as=\"font\"") {
		t.Fatalf("preload напечатан без файла в сборке:\n%s", body)
	}
	if !strings.Contains(body, `style="--rf-font-family: &#39;Golos Text&#39;, system-ui, -apple-system, sans-serif;"`) {
		t.Fatalf("семейство должно доехать в стиль даже без preload:\n%s", body)
	}
}

// Кавычка в значении разорвала бы тег <html>. Значения приходят из закрытых списков
// валидатора, но оболочка собирается конкатенацией — и потому экранируется.
// Собираем документ МИМО валидатора, руками: тест сторожит саму печать.
func TestShellAttrs_EscapesQuotes(t *testing.T) {
	got := shellAttrs(&domain.FormDesign{
		Palette: &domain.DesignPalette{Canvas: `"><script>alert(1)</script>`},
	})
	if strings.Contains(got, `"><script>`) {
		t.Fatalf("сырая кавычка вырвалась из атрибута: %s", got)
	}
	if !strings.Contains(got, "&lt;script&gt;") {
		t.Fatalf("ожидалось экранирование, получено: %s", got)
	}
}

// Пропавший плейсхолдер оболочки — ошибка старта, как и пропавшая точка вставки
// головы: молча отдавать форму без оформления страшнее, чем не подняться.
func TestParseIndexHTML_MissingShellMarker_Fails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.html")
	broken := strings.Replace(builtIndexFixture, ` data-form-shell`, "", 1)
	if err := os.WriteFile(path, []byte(broken), 0o600); err != nil {
		t.Fatalf("запись фикстуры: %v", err)
	}
	if _, err := parseIndexHTML(path); err == nil {
		t.Fatal("ожидалась ошибка разбора index.html без плейсхолдера оболочки")
	}
}

// РАЗБОР НАСТОЯЩЕЙ ОБОЛОЧКИ РЕНДЕРЕРА, а не рукописной фикстуры. Фикстура — это то,
// что автор Go считает разметкой рендерера; расходится она с ней молча. Первая
// редакция слайса 5 именно так и уехала в прод-негодность: поясняющий комментарий
// над тегом <html> начинался со слов «data-form-shell — …», маркер нашёлся в нём, и
// оформление подставлялось ВНУТРЬ КОММЕНТАРИЯ при семи зелёных тестах на фикстуре.
//
// vite комментарии из index.html не вырезает, поэтому проверять надо исходник: он
// же и уезжает в сборку почти дословно (меняются только теги ассетов).
func TestParseIndexHTML_RealRendererTemplate(t *testing.T) {
	const real = "../../web/renderer/index.html"
	doc, err := parseIndexHTML(real)
	if err != nil {
		t.Fatalf("настоящий index.html рендерера не разбирается: %v", err)
	}

	var buf bytes.Buffer
	buf.Write(doc.head)
	buf.WriteString(shellAttrs(&domain.FormDesign{Theme: "dark"}))
	buf.Write(doc.mid)
	buf.WriteString("<!--мета-->")
	buf.Write(doc.tail)
	page := buf.String()

	if !strings.Contains(page, `<html lang="ru" class="rf-theme-dark">`) {
		t.Fatalf("оформление подставлено не в тег <html>:\n%s", page)
	}
}

// Хеш rollup'а пишется алфавитом base64url, где дефис — обычный символ (в сборке
// рядом лежит index-mIztBLt-.css). Разбор имени файла «до последнего дефиса» на
// таком хеше молча терял preload — сторожим именно такое имя.
func TestScanFontAssets_HashWithDash(t *testing.T) {
	dir := t.TempDir()
	assets := filepath.Join(dir, "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatalf("создание каталога ассетов: %v", err)
	}
	const name = "inter-latin-Dx4-XJAl.woff2"
	if err := os.WriteFile(filepath.Join(assets, name), []byte("x"), 0o600); err != nil {
		t.Fatalf("запись ассета: %v", err)
	}

	got := scanFontAssets(filepath.Join(dir, "index.html"))
	if got["inter-latin"] != "/assets/"+name {
		t.Fatalf("шрифт с дефисом в хеше не найден: %v", got)
	}
}

// Второе вхождение маркера где угодно в файле обязано ронять старт: подставить
// оболочку в одно из двух мест «на выбор» нельзя, а тихий выбор не того — это
// светлая форма при зелёном деплое.
func TestParseIndexHTML_DuplicateShellMarker_Fails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "index.html")
	doubled := strings.Replace(builtIndexFixture, "<!doctype html>",
		"<!doctype html>\n<!-- атрибут data-form-shell ставит Go -->", 1)
	if err := os.WriteFile(path, []byte(doubled), 0o600); err != nil {
		t.Fatalf("запись фикстуры: %v", err)
	}
	if _, err := parseIndexHTML(path); err == nil {
		t.Fatal("ожидалась ошибка: маркер оболочки встречается дважды")
	}
}

// Карта шрифтов снимается вместе с разбором index.html, а выкатка раскладывает
// статику не мгновенно: запрос, попавший в окно «index.html записан, woff2 ещё нет»,
// запомнил бы пустую карту на весь релиз — молча, потому что документ после этого
// считается актуальным. Промах обязан перечитывать каталог.
func TestPublicHTML_FontsAppearAfterIndex_PreloadRecovers(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "index.html")
	if err := os.WriteFile(path, []byte(builtIndexFixture), 0o600); err != nil {
		t.Fatalf("запись фикстуры index.html: %v", err)
	}
	svc := designedForm(t, `{"font":"inter"}`)
	h, err := NewPublicHandler(svc, testSecret, testBaseURL, testOGImage, path)
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}
	mux := http.NewServeMux()
	h.Routes(mux)
	get := func() string {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/abc", nil))
		return rec.Body.String()
	}

	// Проверяем НАШ preload (у него href идёт последним), а не те теги фикстуры,
	// которые доезжают дословно — «ассет, которого Go не знает», и таблицу стилей.
	if strings.Contains(get(), `type="font/woff2" crossorigin href=`) {
		t.Fatal("preload напечатан до того, как шрифты появились в статике")
	}

	// Распаковка догнала: файлы легли рядом, index.html при этом не менялся.
	assets := filepath.Join(dir, "assets")
	if err := os.Mkdir(assets, 0o755); err != nil {
		t.Fatalf("создание каталога ассетов: %v", err)
	}
	const name = "inter-cyrillic-DqGufNeO.woff2"
	if err := os.WriteFile(filepath.Join(assets, name), []byte("x"), 0o600); err != nil {
		t.Fatalf("запись ассета: %v", err)
	}

	if !strings.Contains(get(), `href="/assets/`+name+`"`) {
		t.Fatalf("preload не восстановился после появления файлов:\n%s", get())
	}
}
