package forms

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"os"
	"strings"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/httpserver"
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

// loadIndexHTML читает собранный index.html рендерера и раскладывает его вокруг
// плейсхолдера ogMetaMarker в prefix/suffix (кэш в памяти — читается один раз при
// старте, не на каждый запрос). Отсутствие маркера или #root — ошибка старта
// (fail-fast: «упасть сразу, а не на первом запросе»), а не молчаливо битая форма.
func (h *PublicHandler) loadIndexHTML(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read renderer index %s: %w", path, err)
	}
	html := string(raw)
	i := strings.Index(html, ogMetaMarker)
	if i < 0 {
		return fmt.Errorf("renderer index %s: missing %q placeholder", path, ogMetaMarker)
	}
	if !strings.Contains(html, `id="root"`) {
		return fmt.Errorf("renderer index %s: missing #root mount node", path)
	}
	h.htmlPrefix = []byte(html[:i])
	h.htmlSuffix = []byte(html[i+len(ogMetaMarker):])
	h.servesHTML = true
	return nil
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
		Title:           pf.Title,
		Description:     desc,
		MetaDescription: metaDesc,
		OGImage:         h.ogImageURL,
		URL:             h.publicBaseURL + "/r/" + slug,
	}

	// prefix + <og-мета> + suffix. Рендерим в буфер: ошибка шаблона (маловероятна —
	// статичный шаблон) не должна оставить наполовину записанный ответ.
	var buf bytes.Buffer
	buf.Write(h.htmlPrefix)
	if err := ogMetaTmpl.Execute(&buf, data); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("render form meta %s: %w", slug, err))
		return
	}
	buf.Write(h.htmlSuffix)

	w.Header().Set("Cache-Control", "public, max-age=60")
	httpserver.WriteHTML(w, r, http.StatusOK, buf.Bytes())
}

// ogDescriptionFromSchema собирает подзаголовок превью из формы: заголовки первых
// блоков-вопросов через « · ». Отдельного поля описания у формы нет, поэтому берём
// осмысленный тизер из её содержимого. Схема уже валидна (проверена при публикации);
// разбор на всякий случай отказоустойчив — сбой даёт пустое описание, а не 500.
func ogDescriptionFromSchema(schema json.RawMessage) string {
	var s domain.FormSchema
	if err := json.Unmarshal(schema, &s); err != nil {
		return ""
	}
	labels := make([]string, 0, 3)
	for _, b := range s.Blocks {
		label := strings.TrimSpace(b.Label)
		if label == "" {
			continue
		}
		labels = append(labels, label)
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
