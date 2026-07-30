package forms

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// ogMetaMarker — плейсхолдер в собранном index.html рендерера (web/renderer/index.html),
// на место которого Go подставляет OG-мету формы. Всё вокруг него (ассеты: script,
// link, preload, favicon) — впрыснуто vite и отдаётся дословно: Go список ассетов
// не ведёт, поэтому расхождение «Go ≠ сборка» невозможно по построению.
const ogMetaMarker = "<!--og-meta-->"

// ogMetaTmpl — только «голова формы»: то, что зависит от формы (title/тизер) и
// потому не может быть в статичном index.html. Подставляется на место ogMetaMarker.
//
// html/template автоэкранирует ВСЕ подстановки в их контексте (Title/Description —
// пользовательский текст, попадает в атрибут content экранированным: инъекция вида
// "><script> невозможна; URL'ы фильтруются в src/href-контексте). Никакого «сырого»
// вывода и никакого dangerouslySetInnerHTML (инвариант безопасности 4). Собранный
// index.html вокруг — доверенный (наш билд), склеивается как есть.
var ogMetaTmpl = template.Must(template.New("ogmeta").Parse(
	`<title>{{.Title}}</title>` +
		`<meta name="description" content="{{.MetaDescription}}">` +
		`<meta property="og:type" content="website">` +
		`<meta property="og:title" content="{{.Title}}">` +
		`{{if .Description}}<meta property="og:description" content="{{.Description}}">{{end}}` +
		`<meta property="og:image" content="{{.OGImage}}">` +
		`<meta property="og:url" content="{{.URL}}">` +
		`<meta name="twitter:card" content="summary_large_image">`,
))

type ogMetaData struct {
	Title string
	// Description — тизер для og:description (заголовки блоков); может быть пустым,
	// тогда og:description опускается. MetaDescription — стандартный <meta
	// name="description">, всегда непустой (SEO): тот же тизер или фолбэк.
	Description     string
	MetaDescription string
	OGImage         string
	URL             string
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

// indexDoc — собранный index.html, разложенный вокруг плейсхолдера ogMetaMarker,
// вместе с приметами файла на диске (mtime+размер), по которым замечаем подмену.
type indexDoc struct {
	prefix  []byte
	suffix  []byte
	modTime time.Time
	size    int64
}

// parseIndexHTML читает собранный index.html рендерера и раскладывает его вокруг
// плейсхолдера ogMetaMarker. Отсутствие маркера или #root — ошибка (на старте это
// fail-fast «упасть сразу, а не на первом запросе», а не молчаливо битая форма).
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
	i := strings.Index(html, ogMetaMarker)
	if i < 0 {
		return nil, fmt.Errorf("renderer index %s: missing %q placeholder", path, ogMetaMarker)
	}
	if !strings.Contains(html, `id="root"`) {
		return nil, fmt.Errorf("renderer index %s: missing #root mount node", path)
	}
	return &indexDoc{
		prefix:  []byte(html[:i]),
		suffix:  []byte(html[i+len(ogMetaMarker):]),
		modTime: fi.ModTime(),
		size:    fi.Size(),
	}, nil
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

	desc := ogDescriptionFromSchema(pf.Schema)
	metaDesc := desc
	if metaDesc == "" {
		metaDesc = fallbackMetaDescription
	}
	data := ogMetaData{
		Title:           titleOrFallback(pf.Title),
		Description:     desc,
		MetaDescription: metaDesc,
		OGImage:         h.ogImageURL,
		URL:             h.publicBaseURL + "/r/" + slug,
	}

	// prefix + <og-мета> + suffix. Рендерим в буфер: ошибка шаблона (маловероятна —
	// статичный шаблон) не должна оставить наполовину записанный ответ.
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
	var buf bytes.Buffer
	buf.Write(doc.prefix)
	if err := ogMetaTmpl.Execute(&buf, data); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("render form meta %s: %w", slug, err))
		return
	}
	buf.Write(doc.suffix)

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

// ogDescriptionFromSchema собирает подзаголовок превью из формы: тексты первых
// блоков-подписей (title/label) через « · ». Отдельного поля описания у формы нет,
// поэтому берём осмысленный тизер из её содержимого. ValidateSchema приводит старые
// версии к текущей на лету (v1→v2→v3); разбор отказоустойчив —
// сбой даёт пустое описание, а не 500.
func ogDescriptionFromSchema(schema json.RawMessage) string {
	s, err := domain.ValidateSchema(schema)
	if err != nil {
		return ""
	}
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
