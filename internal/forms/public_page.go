package forms

import (
	"bytes"
	"fmt"
	"html/template"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

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
// СВОЯ ИКОНКА ПЕЧАТАЕТСЯ ВТОРЫМ <link rel="icon">, а не заменяет первый. Значок по
// умолчанию (/favicon.svg) стоит в web/renderer/index.html выше плейсхолдера, и Go
// разметку вокруг маркера не переписывает принципиально — он её только раздвигает.
// Из двух одинаковых rel браузеры берут последний объявленный, поэтому своя иконка
// перебивает дефолтную; при этом в dev, где страницу отдаёт vite и Go не участвует
// вовсе, значок формы не пропадает.
//
// Preload шрифта идёт ПЕРВЫМ: это единственная строка вставки, которая говорит
// браузеру качать файл, и чем раньше её увидит сканер предзагрузки, тем раньше
// уйдёт запрос. crossorigin обязателен даже для своего origin — без него шрифт
// скачается вторым запросом (правило CORS для шрифтов), и preload сработает в минус.
var headTmpl = template.Must(template.New("head").Parse(
	`{{range .Preload}}<link rel="preload" as="font" type="font/woff2" crossorigin href="{{.}}">{{end}}` +
		`<title>{{.Title}}</title>` +
		`<meta name="description" content="{{.Description}}">` +
		`{{if .ThemeColor}}<meta name="theme-color" content="{{.ThemeColor}}">{{end}}` +
		`{{if .Icon}}<link rel="icon" href="{{.Icon}}">{{end}}` +
		`<meta property="og:type" content="website">` +
		`<meta property="og:site_name" content="{{.SiteName}}">` +
		`<meta property="og:title" content="{{.Title}}">` +
		`<meta property="og:description" content="{{.Description}}">` +
		`<meta property="og:image" content="{{.OGImage}}">` +
		`<meta property="og:url" content="{{.URL}}">` +
		`<meta name="twitter:card" content="summary_large_image">`,
))

type headData struct {
	Title string
	// Description — og:description и <meta name="description"> одной строкой: с
	// появлением поля описания в карточке ссылки различать их стало нечем, а два
	// значения на одну мысль расходятся при первой же правке.
	Description string
	OGImage     string
	URL         string
	// SiteName — имя площадки над заголовком карточки; всегда непусто (дефолт —
	// имя сервиса).
	SiteName string
	// Icon — абсолютный URL своей иконки площадки; пусто → остаётся значок из
	// разметки рендерера.
	Icon string
	// ThemeColor — цвет строки браузера: холст формы. Пусто → меты нет вовсе.
	ThemeColor string
	// Preload — URL'ы подмножеств выбранного шрифта в собранной статике.
	Preload []string
}

// maxOGDescriptionLen — потолок длины og:description (превью всё равно обрезают).
const maxOGDescriptionLen = 200

// Дефолты карточки ссылки — то, что видит получатель ссылки на форму, автор которой
// карточку не настраивал (или настраивал, но тариф её не разрешает).
//
// ЗЕРКАЛО: те же две строки объявлены в web/app/src/entities/form.ts
// (LINK_PREVIEW_SITE_NAME, LINK_PREVIEW_DESCRIPTION) — по ним кабинет рисует
// предпросмотр и заполняет окно настройки. Разойдутся — предпросмотр начнёт врать
// про то, что увидит получатель, а заметить это можно только отправив себе ссылку.
const (
	defaultSiteName = "Trillix"
	// defaultDescription — общий текст, а НЕ тизер из заголовков первых вопросов
	// (решение владельца 2026-08-27, отменяет прежнее поведение): у формы появилось
	// своё поле описания, и держать рядом второй, выводимый источник значило бы
	// объяснять автору, почему в окне одно, а по ссылке другое.
	defaultDescription = "Форма на Trillix — соберите свою за пару минут."
)

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

	// Оформление оболочки и шрифт для preload берутся из уже разобранного документа
	// (pf.Parsed). Отказоустойчиво, как и было: битая схема даёт страницу без
	// оформления, а не 500.
	var design *domain.FormDesign
	if pf.ParseErr == nil {
		design = pf.Parsed.Design
	}

	// Своя карточка ссылки поверх дефолтов. Право тарифа спрашивается ЗДЕСЬ, при
	// отдаче (а не при сохранении карточки) — тот же приём, что у бейджа: в колонке
	// намерение автора, в выдаче намерение плюс разрешение.
	card := h.linkPreview(r, pf.WorkspaceID, pf.LinkPreview)

	title := titleOrFallback(pf.Title)
	desc := defaultDescription
	siteName := defaultSiteName
	if card != nil {
		// Пустое поле карточки = «оставить дефолт», а не «показать пустоту»: карточка,
		// у которой заполнен один заголовок, — законное и частое состояние.
		if card.Title != "" {
			title = card.Title
		}
		if card.Description != "" {
			desc = truncateRunes(card.Description, maxOGDescriptionLen)
		}
		if card.SiteName != "" {
			siteName = card.SiteName
		}
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
		Title:       title,
		Description: desc,
		SiteName:    siteName,
		OGImage:     h.ogImageURL,
		URL:         h.publicBaseURL + "/r/" + slug,
		ThemeColor:  domain.DesignThemeColor(design),
		Preload:     h.fontPreload(doc, design),
	}
	if card != nil {
		if url := h.mediaURL(card.ImageKey); url != "" {
			data.OGImage = url
		}
		data.Icon = h.mediaURL(card.IconKey)
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

// getCancelHTML отдаёт оболочку рендерера для страницы отмены записи /cancel/{token}
// (фаза 27). Тот же собранный index.html, что у формы, но БЕЗ её головы: ни OG-меты,
// ни оформления, ни preload шрифта здесь нет и быть не может — до разбора токена
// сервер не знает ни формы, ни автора, а знать бы и не следовало.
//
// Токен НЕ разбирается: страница спрашивает о записи сама, своей ручкой. Отдай мы 404
// на негодной ссылке, страница отмены отличалась бы от протухшей ссылки видом ошибки
// браузера вместо человеческого текста.
func (h *PublicHandler) getCancelHTML(w http.ResponseWriter, r *http.Request) {
	doc := h.currentIndex(r)
	if doc == nil {
		httpserver.WriteError(w, r, fmt.Errorf("renderer index unavailable for cancel page"))
		return
	}
	var buf bytes.Buffer
	buf.Write(doc.head)
	buf.Write(doc.mid)
	if err := headTmpl.Execute(&buf, headData{
		Title:       "Отмена записи",
		Description: defaultDescription,
		SiteName:    defaultSiteName,
		OGImage:     h.ogImageURL,
	}); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("render cancel page: %w", err))
		return
	}
	buf.Write(doc.tail)

	// Не кэшируется: страница говорит о состоянии записи, а оно меняется той же
	// кнопкой, что на ней стоит.
	w.Header().Set("Cache-Control", "no-store")
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

// truncateRunes обрезает строку до n рун (не байт — кириллица), добавляя «…».
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// linkPreview — карточка ссылки, действующая для этой выдачи (nil = дефолты).
// Сбой опроса тарифа не имеет права уронить публичную страницу: остаётся дефолтная
// карточка, причина уходит в лог с request_id. Выбор тот же, что у бейджа, — при
// сбое склоняемся к бесплатному поведению, а не к платному.
func (h *PublicHandler) linkPreview(r *http.Request, workspaceID uuid.UUID, intent *domain.LinkPreview) *domain.LinkPreview {
	card, err := h.svc.LinkPreviewFor(r.Context(), workspaceID, intent)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("проверка тарифа для карточки ссылки",
			slog.String("workspace_id", workspaceID.String()), slog.String("error", err.Error()))
		return nil
	}
	return card
}

// mediaURL — АБСОЛЮТНЫЙ адрес картинки карточки по её ключу в бакете. Абсолютный
// обязателен: относительный `/media/<key>` краулеры превью не резолвят — они читают
// мету, не имея базы документа. База — домен рендерера, потому что `/media/*`
// раздаётся и с него тоже (deploy/caddy/Caddyfile, сниппет media), то есть картинка
// карточки лежит на том же origin, что и сама форма.
//
// Ключ в URL не кодируется: он S3-безопасный по построению (workspaceID/<sha256>.ext,
// media.Service.put), и лишнее кодирование сломало бы слеш неймспейса.
func (h *PublicHandler) mediaURL(key string) string {
	if key == "" {
		return ""
	}
	return h.publicBaseURL + "/media/" + key
}
