package forms

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"strings"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/httpserver"
)

// formPageTmpl — HTML-оболочка публичной формы для /r/{slug}. «Голова на сервере»:
// краулеры мессенджеров/соцсетей читают HTML без JS, поэтому OG-мета подставляет Go.
// «Тело на клиенте»: <div id="root"> + модуль-скрипт грузит React-SPA рендерера.
//
// html/template автоэкранирует ВСЕ подстановки в их контексте (Title/Description —
// пользовательский текст, попадает в атрибут content экранированным: инъекция вида
// "><script> невозможна; URL'ы фильтруются в src/href-контексте). Никакого «сырого»
// вывода и никакого dangerouslySetInnerHTML (инвариант безопасности 4).
var formPageTmpl = template.Must(template.New("formpage").Parse(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}}</title>
<meta name="description" content="{{.MetaDescription}}">
<meta property="og:type" content="website">
<meta property="og:title" content="{{.Title}}">
{{if .Description}}<meta property="og:description" content="{{.Description}}">
{{end}}<meta property="og:image" content="{{.OGImage}}">
<meta property="og:url" content="{{.URL}}">
<meta name="twitter:card" content="summary_large_image">
{{if .StyleSrc}}<link rel="stylesheet" href="{{.StyleSrc}}">
{{end}}</head>
<body>
<div id="root"></div>
<script type="module" src="{{.ScriptSrc}}"></script>
</body>
</html>
`))

type formPageData struct {
	Title string
	// Description — тизер для og:description (заголовки блоков); может быть пустым,
	// тогда og:description опускается. MetaDescription — стандартный <meta
	// name="description">, всегда непустой (SEO): тот же тизер или фолбэк.
	Description     string
	MetaDescription string
	OGImage         string
	URL             string
	ScriptSrc       string
	// StyleSrc — абсолютный URL CSS рендерера; пусто в dev (vite инжектит стили
	// через JS), тогда <link> не выводится.
	StyleSrc string
}

// maxOGDescriptionLen — потолок длины og:description (превью всё равно обрезают).
const maxOGDescriptionLen = 200

// fallbackMetaDescription — <meta name="description"> для формы без заполненных
// заголовков вопросов (пустой тизер): описание страницы для поисковиков.
const fallbackMetaDescription = "Онлайн-форма — заполните и отправьте ответ."

// getHTML отдаёт HTML-документ формы /r/{slug} с OG-мета опубликованной версии.
// Только опубликованная форма; черновик/закрытая/нет формы → 404 (тем же путём,
// что JSON-ручка: HTML не раскрывает существование приватного).
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
	data := formPageData{
		Title:           pf.Title,
		Description:     desc,
		MetaDescription: metaDesc,
		OGImage:         h.ogImageURL,
		URL:             h.publicBaseURL + "/r/" + slug,
		ScriptSrc:       h.publicBaseURL + h.scriptPath,
	}
	if h.stylePath != "" {
		data.StyleSrc = h.publicBaseURL + h.stylePath
	}

	// Рендерим в буфер: ошибка шаблона (маловероятна — статичный шаблон) не должна
	// оставить наполовину записанный ответ. Успех → отдаём как HTML.
	var buf bytes.Buffer
	if err := formPageTmpl.Execute(&buf, data); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("render form page %s: %w", slug, err))
		return
	}
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
