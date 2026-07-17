package forms

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/httpserver"
	"github.com/ka-shmd/trierra/internal/token"
)

// defaultClosedMessage — текст экрана «приём закрыт» для формы без своего текста.
// Резолвится на сервере (не в рендерере), чтобы JSON-ручка и HTML-страница не
// разъехались в дефолте. Владелец задаёт свой в настройках (closed_message).
const defaultClosedMessage = "Приём ответов на эту форму закрыт."

// publicFormService — часть сервиса форм, нужная публичному транспорту.
type publicFormService interface {
	PublicForm(ctx context.Context, slug string) (PublicForm, error)
}

// PublicHandler — публичный транспорт форм (без авторизации и CSRF): отдаёт схему
// опубликованной версии по slug. Отдельный от Handler ровно потому, что у этих
// роутов нет RequireAuth — их регистрирует composition root без приватных middleware.
type PublicHandler struct {
	svc           publicFormService
	tokenSecret   []byte
	publicBaseURL string // база рендерера: og:url на /r/{slug} и ссылка на форму
	ogImageURL    string // абсолютный URL картинки превью (og:image)
	// htmlPrefix/htmlSuffix — собранный index.html рендерера, разложенный вокруг
	// плейсхолдера ogMetaMarker (см. loadIndexHTML). servesHTML — задан ли index:
	// в проде true (Go отдаёт /r), в dev false (форму отдаёт vite-dev, /r не регится).
	htmlPrefix []byte
	htmlSuffix []byte
	servesHTML bool
	now        func() time.Time // подменяется в тестах
}

// NewPublicHandler создаёт публичный транспорт форм. indexHTMLPath — путь к
// собранному index.html рендерера (прод); пустой в dev — тогда /r не обслуживается
// Go (форму отдаёт vite-dev). Непустой путь читается сразу: нечитаемый файл или
// отсутствие плейсхолдера — ошибка старта, а не первого запроса.
func NewPublicHandler(svc publicFormService, tokenSecret []byte, publicBaseURL, ogImageURL, indexHTMLPath string) (*PublicHandler, error) {
	h := &PublicHandler{
		svc:           svc,
		tokenSecret:   tokenSecret,
		publicBaseURL: strings.TrimRight(publicBaseURL, "/"),
		ogImageURL:    ogImageURL,
		now:           time.Now,
	}
	if indexHTMLPath != "" {
		if err := h.loadIndexHTML(indexHTMLPath); err != nil {
			return nil, err
		}
	}
	return h, nil
}

// Routes регистрирует публичные эндпоинты форм на общем mux: JSON-ручку рендерера
// (/public/v1) и — только когда задан собранный index.html (прод) — HTML-страницу
// формы с OG-мета (/r/{slug}). В dev /r отдаёт vite-dev, поэтому Go его не регит.
func (h *PublicHandler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /public/v1/forms/{slug}", h.get)
	if h.servesHTML {
		mux.HandleFunc("GET /r/{slug}", h.getHTML)
	}
}

// publicFormResponse — тело GET /public/v1/forms/{slug}. token — подписанное время
// выдачи (антиспам «минимальное время заполнения», проверяется при приёме, фаза 5).
type publicFormResponse struct {
	Title   string          `json:"title"`
	Version int32           `json:"version"`
	Schema  json.RawMessage `json:"schema"`
	Token   string          `json:"token"`
}

// closedFormResponse — тело GET /public/v1/forms/{slug} для ЗАКРЫТОЙ формы (HTTP
// 410 Gone). Схемы и токена нет — принимать ответ нельзя; рендерер по 410 рисует
// экран «приём закрыт» из этих полей. closedMessage уже разрезолвлен (свой/дефолт).
type closedFormResponse struct {
	Closed        bool   `json:"closed"`
	Title         string `json:"title"`
	ClosedMessage string `json:"closedMessage"`
}

func (h *PublicHandler) get(w http.ResponseWriter, r *http.Request) {
	pf, err := h.svc.PublicForm(r.Context(), r.PathValue("slug"))
	if err != nil {
		// ErrNotFound → 404 для черновика/несуществующей (приватное не раскрывается).
		httpserver.WriteError(w, r, err)
		return
	}

	// Форма была публичной, но больше не принимает ответы (снята/дата/лимит) → 410
	// «приём закрыт» вместо 404 (решение владельца, шаг 4). Кэш выключаем: закрытость
	// живая (продление даты, удаление ответа могут переоткрыть форму).
	if domain.FormClosed(pf.Status, pf.CloseAt, pf.ResponseLimit, pf.SubmissionCount, h.now().UTC()) {
		w.Header().Set("Cache-Control", "no-store")
		httpserver.WriteJSON(w, r, http.StatusGone, closedFormResponse{
			Closed:        true,
			Title:         pf.Title,
			ClosedMessage: closedMessageOrDefault(pf.ClosedMessage),
		})
		return
	}

	// ETag = id опубликованной версии: иммутабелен, меняется только при новой
	// публикации. Кэш 60 с — терпимо для формы (правки видны после переиздания).
	etag := `"` + pf.VersionID.String() + `"`
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.Header().Set("ETag", etag)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	// Токен выдаётся на каждый ответ; при кэшировании его возраст растёт, но это
	// только усиливает проверку «не раньше 3 с» (свежий мгновенный токен — бот).
	httpserver.WriteJSON(w, r, http.StatusOK, publicFormResponse{
		Title:   pf.Title,
		Version: pf.Version,
		Schema:  pf.Schema,
		Token:   token.Issue(h.tokenSecret, h.now().UTC()),
	})
}

// closedMessageOrDefault — свой текст владельца, если задан, иначе дефолт.
func closedMessageOrDefault(msg *string) string {
	if msg != nil {
		if trimmed := strings.TrimSpace(*msg); trimmed != "" {
			return trimmed
		}
	}
	return defaultClosedMessage
}

// etagMatches сверяет заголовок If-None-Match с текущим ETag (список через запятую
// либо "*"). Достаточно для нашего сильного валидатора; W/ слабых тегов мы не выдаём.
func etagMatches(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" {
		return false
	}
	if strings.TrimSpace(ifNoneMatch) == "*" {
		return true
	}
	for _, part := range strings.Split(ifNoneMatch, ",") {
		if strings.TrimSpace(part) == etag {
			return true
		}
	}
	return false
}
