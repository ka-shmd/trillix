package forms

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// ogMetaMarker — плейсхолдер в собранном index.html рендерера (web/renderer/index.html),
// на место которого Go подставляет «голову формы». Всё вокруг него (ассеты: script,
// link, preload, favicon) — впрыснуто vite и отдаётся дословно: Go список ассетов
// не ведёт, поэтому расхождение «Go ≠ сборка» невозможно по построению.
//
// Имя историческое: кроме OG-меты сюда теперь уезжают theme-color и preload шрифта
// формы. Переименовать значило бы разойтись с разметкой рендерера ради красоты.
const ogMetaMarker = "<!--og-meta-->"

// shellMarker — ВТОРАЯ точка вставки, в открывающем теге <html>: на её место уезжают
// класс и стиль оформления формы (фаза 22, слайс 5). Ведущий пробел входит в
// плейсхолдер, поэтому форма без оформления даёт ровно `<html lang="ru">` — как до
// фазы, байт в байт.
//
// ПОЧЕМУ АТРИБУТЫ, А НЕ <style> В HEAD, как обещала спека §8.1. Тёмная тема — это
// класс `.rf-theme-dark` на контейнере (там живут и color-scheme, и все дефолты
// цветов), а класс на <html> из head не поставить. Значит, вариант со <style>
// заставил бы Go знать наизусть тёмные дефолты холста, поля, текста и приглушённого
// текста и печатать их с перебивающей класс специфичностью — четыре значения,
// продублированных в Go навсегда, и правка fields.css, которая молча не доезжает до
// публичной формы. Атрибуты же печатают РОВНО ТО ЖЕ, что через мгновение наденет
// клиент (DesignClasses + DesignStyleAttr — те же зеркала), поэтому третьего
// источника истины не появляется вовсе.
const shellMarker = " data-form-shell"

// headTmpl — «голова формы»: то, что зависит от формы и потому не может лежать в
// статичном index.html. Подставляется на место ogMetaMarker.
//
// html/template автоэкранирует ВСЕ подстановки в их контексте (Title/Description —
// пользовательский текст, попадает в атрибут content экранированным: инъекция вида
// "><script> невозможна; URL'ы фильтруются в src/href-контексте). Никакого «сырого»
// вывода и никакого dangerouslySetInnerHTML (инвариант безопасности 4). Собранный
// index.html вокруг — доверенный (наш билд), склеивается как есть.
//
// Preload шрифта идёт ПЕРВЫМ: это единственная строка вставки, которая говорит
// браузеру качать файл, и чем раньше её увидит сканер предзагрузки, тем раньше
// уйдёт запрос. crossorigin обязателен даже для своего origin — без него шрифт
// скачается вторым запросом (правило CORS для шрифтов), и preload сработает в минус.
var headTmpl = template.Must(template.New("head").Parse(
	`{{range .Preload}}<link rel="preload" as="font" type="font/woff2" crossorigin href="{{.}}">{{end}}` +
		`<title>{{.Title}}</title>` +
		`<meta name="description" content="{{.MetaDescription}}">` +
		`{{if .ThemeColor}}<meta name="theme-color" content="{{.ThemeColor}}">{{end}}` +
		`<meta property="og:type" content="website">` +
		`<meta property="og:title" content="{{.Title}}">` +
		`{{if .Description}}<meta property="og:description" content="{{.Description}}">{{end}}` +
		`<meta property="og:image" content="{{.OGImage}}">` +
		`<meta property="og:url" content="{{.URL}}">` +
		`<meta name="twitter:card" content="summary_large_image">`,
))

type headData struct {
	Title string
	// Description — тизер для og:description (заголовки блоков); может быть пустым,
	// тогда og:description опускается. MetaDescription — стандартный <meta
	// name="description">, всегда непустой (SEO): тот же тизер или фолбэк.
	Description     string
	MetaDescription string
	OGImage         string
	URL             string
	// ThemeColor — цвет строки браузера: холст формы. Пусто → меты нет вовсе.
	ThemeColor string
	// Preload — URL'ы подмножеств выбранного шрифта в собранной статике.
	Preload []string
}

// maxOGDescriptionLen — потолок длины og:description (превью всё равно обрезают).
const maxOGDescriptionLen = 200

// fallbackMetaDescription — <meta name="description"> для формы без заполненных
// заголовков вопросов (пустой тизер): описание страницы для поисковиков.
const fallbackMetaDescription = "Онлайн-форма — заполните и отправьте ответ."

// fallbackFormTitle — <title> вкладки и og:title формы, у которой автор заголовок
// стёр (фаза 15). На самой странице заголовка тогда нет вовсе — так решил автор, —
// но у вкладки и у превью ссылки пустоты не бывает технически, и вместо неё нужен
// нейтральный текст. Служебное «Untitled form» из колонки сюда не попадает: его
// автор не писал.
const fallbackFormTitle = "Форма"

// indexDoc — собранный index.html, разложенный вокруг двух плейсхолдеров
// (shellMarker в теге <html>, затем ogMetaMarker в <head>), вместе с приметами файла
// на диске (mtime+размер), по которым замечаем подмену.
type indexDoc struct {
	head    []byte // до атрибутов оболочки
	mid     []byte // между ними и «головой формы»
	tail    []byte // после «головы формы»
	fonts   map[string]string
	modTime time.Time
	size    int64
}

// parseIndexHTML читает собранный index.html рендерера и раскладывает его вокруг двух
// плейсхолдеров. Отсутствие любого из них, нарушенный порядок или пропавший #root —
// ошибка (на старте это fail-fast «упасть сразу, а не на первом запросе», а не
// молчаливо битая форма).
func parseIndexHTML(path string) (*indexDoc, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("stat renderer index %s: %w", path, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read renderer index %s: %w", path, err)
	}
	html := string(raw)
	// СЧИТАЕМ, А НЕ ИЩЕМ ПЕРВЫЙ: подстановка идёт в ОДНО место, и второе вхождение
	// маркера означает, что мы вставим документ не туда. Ровно это и случилось при
	// первой сборке слайса 5: поясняющий комментарий над тегом <html> начинался со
	// слов «data-form-shell — …», то есть содержал искомую подстроку вместе с ведущим
	// пробелом. Маркер «нашёлся» в комментарии, оформление уехало внутрь него, тег
	// <html> остался голым — и ни ошибки, ни падения: страница отдавалась, просто
	// светлой. Дубль обязан ронять старт, а не тихо переезжать.
	if n := strings.Count(html, shellMarker); n != 1 {
		return nil, fmt.Errorf("renderer index %s: %q must occur exactly once, found %d", path, shellMarker, n)
	}
	if n := strings.Count(html, ogMetaMarker); n != 1 {
		return nil, fmt.Errorf("renderer index %s: %q must occur exactly once, found %d", path, ogMetaMarker, n)
	}
	shell := strings.Index(html, shellMarker)
	i := strings.Index(html, ogMetaMarker)
	// Порядок проверяется, потому что склейка идёт по нему: маркер оболочки живёт в
	// открывающем теге <html>, то есть строго раньше головы. Переставленные местами
	// плейсхолдеры дали бы не ошибку, а перемешанный документ.
	if shell > i {
		return nil, fmt.Errorf("renderer index %s: %q must precede %q", path, shellMarker, ogMetaMarker)
	}
	if !strings.Contains(html, `id="root"`) {
		return nil, fmt.Errorf("renderer index %s: missing #root mount node", path)
	}
	return &indexDoc{
		head:    []byte(html[:shell]),
		mid:     []byte(html[shell+len(shellMarker) : i]),
		tail:    []byte(html[i+len(ogMetaMarker):]),
		fonts:   scanFontAssets(path),
		modTime: fi.ModTime(),
		size:    fi.Size(),
	}, nil
}

// scanFontAssets собирает карту «базовое имя шрифта → URL в собранной статике»,
// читая каталог ассетов рядом с index.html: vite хеширует имя файла
// (inter-cyrillic-DqGufNeO.woff2), а Go обязан знать URL, чтобы поставить preload
// выбранного семейства.
//
// ЭТО ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ из правила «Go ассеты не перечисляет», и оно узкое:
// список файлов не ведётся, читается то, что реально лежит на диске, а имена до
// хеша заданы каталогом шрифтов (internal/domain/design_vars.go) и сторожатся
// тестом. Пропавший файл даёт отсутствие preload, а не битую страницу.
//
// Пересчитывается вместе с разбором index.html, и этого достаточно: файл шрифта
// участвует в CSS, значит его подмена меняет хеш CSS, а тот — сам index.html.
//
// Сопоставление идёт ОТ ИЗВЕСТНОГО ИМЕНИ К ФАЙЛУ, а не разбором имени файла: хеш
// rollup'а пишется алфавитом base64url, где дефис — обычный символ (в той же сборке
// лежит `index-mIztBLt-.css`). Первая редакция резала имя по последнему дефису и на
// таком хеше молча теряла preload.
func scanFontAssets(indexPath string) map[string]string {
	dir := filepath.Join(filepath.Dir(indexPath), "assets")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	fonts := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".woff2") {
			continue
		}
		for _, base := range domain.DesignFontBases() {
			if strings.HasPrefix(name, base+"-") {
				fonts[base] = "/assets/" + name
				break
			}
		}
	}
	return fonts
}

// shellAttrs — класс и стиль оформления для открывающего тега <html>: ровно то, что
// через мгновение наденет на тот же узел клиент (FormView). Пустое оформление даёт
// пустую строку, и тег остаётся прежним.
//
// Экранирование делается ЯВНО, а не html/template: в контексте атрибута style
// шаблон включает CSS-фильтр, который наши кастомные свойства со стеком шрифтов
// (кавычки, запятые) вырезает в ZgotmplZ. Значения приходят из закрытых списков
// валидатора (#rrggbb, целые с px, enum-ключи), но экранируем всё равно — атрибут
// собирается конкатенацией, и одна кавычка в значении разорвала бы тег.
func shellAttrs(d *domain.FormDesign) string {
	var b strings.Builder
	if cls := domain.DesignClasses(d); cls != "" {
		b.WriteString(` class="` + template.HTMLEscapeString(cls) + `"`)
	}
	if style := domain.DesignStyleAttr(d); style != "" {
		b.WriteString(` style="` + template.HTMLEscapeString(style) + `"`)
	}
	return b.String()
}

// currentIndex возвращает актуальный разбор index.html, перечитывая файл, если тот
// изменился на диске (сверка по mtime+размеру — один stat, микросекунды).
//
// Зачем перечитывать, а не оставить разбор со старта: выкатка может обновить ТОЛЬКО
// статику — тег образа тот же, значит `docker compose up -d` контейнер api не
// пересоздаёт, и разобранный при старте документ остался бы старым НАВСЕГДА. Форма
// отдавала бы прошлый HTML (ссылки на несуществующие ассеты → белый экран), причём
// молча, при зелёном деплое. Тот же класс, что TD-27, только на стороне приложения.
//
// Сбой перечитывания не ломает выдачу: остаётся последний удачный разбор, а причина
// уходит в лог с request_id. Битый или наполовину записанный файл (rsync в процессе)
// не должен превращать публичную страницу формы в 500.
func (h *PublicHandler) currentIndex(r *http.Request) *indexDoc {
	cur := h.index.Load()
	fi, err := os.Stat(h.indexPath)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("stat renderer index",
			slog.String("path", h.indexPath), slog.String("error", err.Error()))
		return cur
	}
	if cur != nil && fi.ModTime().Equal(cur.modTime) && fi.Size() == cur.size {
		return cur
	}

	doc, err := parseIndexHTML(h.indexPath)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("reload renderer index (оставлен прежний)",
			slog.String("path", h.indexPath), slog.String("error", err.Error()))
		return cur
	}
	h.index.Store(doc)
	httpserver.LoggerFrom(r.Context()).Info("renderer index reloaded",
		slog.String("path", h.indexPath), slog.Int64("size", doc.size))
	return doc
}

// getHTML отдаёт HTML-документ формы /r/{slug}: собранный index.html рендерера с
// подставленной на место ogMetaMarker OG-метой опубликованной версии. Регистрируется
// только в прод-контуре (когда index загружен); в dev форму отдаёт vite-dev.
// Черновик/нет формы → 404 (HTML не раскрывает существование приватного). Закрытая
// форма отдаёт тот же SPA-шелл (200): клиент по JSON-ручке получит 410 и нарисует
// «приём закрыт» — форма была публичной (шаг 4, инвариант 5 — только черновик 404).
func (h *PublicHandler) getHTML(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	pf, err := h.svc.PublicForm(r.Context(), slug)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	// Схема разбирается ОДИН раз на все три её роли в этом ответе: тизер описания,
	// оформление оболочки и шрифт для preload. Разбор отказоустойчив — битая схема
	// даёт страницу без тизера и без оформления, а не 500.
	var design *domain.FormDesign
	var desc string
	if schema, err := domain.ValidateSchema(pf.Schema); err == nil {
		design = schema.Design
		desc = ogDescription(schema)
	}

	metaDesc := desc
	if metaDesc == "" {
		metaDesc = fallbackMetaDescription
	}

	// prefix + <атрибуты оболочки> + mid + <голова формы> + tail. Рендерим в буфер:
	// ошибка шаблона (маловероятна — статичный шаблон) не должна оставить наполовину
	// записанный ответ.
	doc := h.currentIndex(r)
	if doc == nil {
		// Недостижимо сегодня: Routes регистрирует /r только когда документ загружен
		// при старте, а currentIndex при сбое возвращает последний удачный разбор.
		// Но инвариант держится в ДРУГОМ файле, и его правка не должна оборачиваться
		// разыменованием nil (паника → 500 без объяснения). Явная ветка дешевле
		// молчаливого падения и оставляет причину в логе.
		httpserver.WriteError(w, r, fmt.Errorf("renderer index unavailable for %s", slug))
		return
	}
	data := headData{
		Title:           titleOrFallback(pf.Title),
		Description:     desc,
		MetaDescription: metaDesc,
		OGImage:         h.ogImageURL,
		URL:             h.publicBaseURL + "/r/" + slug,
		ThemeColor:      domain.DesignThemeColor(design),
		Preload:         h.fontPreload(doc, design),
	}

	var buf bytes.Buffer
	buf.Write(doc.head)
	buf.WriteString(shellAttrs(design))
	buf.Write(doc.mid)
	if err := headTmpl.Execute(&buf, data); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("render form meta %s: %w", slug, err))
		return
	}
	buf.Write(doc.tail)

	w.Header().Set("Cache-Control", "public, max-age=60")
	httpserver.WriteHTML(w, r, http.StatusOK, buf.Bytes())
}

// titleOrFallback — заголовок для мест, где пустота невозможна (<title>, og:title,
// экран «приём закрыт»). Пустой заголовок законен на самой странице (там <h1>
// просто не рисуется), но вкладке и превью ссылки нужен текст.
func titleOrFallback(title string) string {
	if strings.TrimSpace(title) == "" {
		return fallbackFormTitle
	}
	return title
}

// fontPreload — URL'ы подмножеств выбранного шрифта в собранной статике. Шрифта,
// которого в сборке не оказалось (собрали без него, файл переименовали), в списке
// нет: лишний preload на несуществующий адрес — это 404 в консоли респондента и
// потерянная предзагрузка, то есть хуже, чем её отсутствие.
//
// ПРОМАХ ПЕРЕЧИТЫВАЕТ КАТАЛОГ. Карта снята вместе с разбором index.html, а выкатка
// раскладывает статику не мгновенно (deploy/remote-update.sh чистит каталог и
// распаковывает архив): запрос, попавший в окно «index.html уже записан, woff2 ещё
// нет», иначе запомнил бы пустую карту на весь релиз — молча, потому что документ
// после этого считается актуальным. В здоровой сборке промаха не бывает, поэтому
// лишним чтением каталога это не оборачивается.
func (h *PublicHandler) fontPreload(doc *indexDoc, d *domain.FormDesign) []string {
	bases := domain.DesignFontFiles(d)
	if len(bases) == 0 {
		return nil
	}
	assets := doc.fonts
	for _, base := range bases {
		if _, ok := assets[base]; !ok {
			assets = scanFontAssets(h.indexPath)
			break
		}
	}
	var out []string
	for _, base := range bases {
		if url, ok := assets[base]; ok {
			out = append(out, url)
		}
	}
	return out
}

// ogDescriptionFromSchema — тизер по сырой схеме. Отдельно от ogDescription, потому
// что схему для страницы формы разбирает getHTML (ей нужен ещё и design), а тесту
// разбора удобнее сырой JSON.
func ogDescriptionFromSchema(schema json.RawMessage) string {
	s, err := domain.ValidateSchema(schema)
	if err != nil {
		return ""
	}
	return ogDescription(s)
}

// ogDescription собирает подзаголовок превью из формы: тексты первых блоков-подписей
// (title/label) через « · ». Отдельного поля описания у формы нет, поэтому берём
// осмысленный тизер из её содержимого. Схему, которую не удалось разобрать, сюда не
// передают вовсе — тизер тогда пуст, а страница отдаётся как обычно.
func ogDescription(s domain.FormSchema) string {
	labels := make([]string, 0, 3)
	for _, b := range s.Blocks {
		if b.Type != domain.BlockTitle && b.Type != domain.BlockLabel {
			continue
		}
		// Плоский текст: og:description читают краулеры и соцсети, разметке там места
		// нет (фаза 14).
		text := strings.TrimSpace(domain.PlainText(b.Text))
		if text == "" {
			continue
		}
		labels = append(labels, text)
		if len(labels) == 3 {
			break
		}
	}
	return truncateRunes(strings.Join(labels, " · "), maxOGDescriptionLen)
}

// truncateRunes обрезает строку до n рун (не байт — кириллица), добавляя «…».
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
