package forms

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/token"
)

// defaultClosedMessage — текст экрана «приём закрыт» для формы без своего текста.
// Резолвится на сервере (не в рендерере), чтобы JSON-ручка и HTML-страница не
// разъехались в дефолте. Владелец задаёт свой в настройках (closed_message).
const defaultClosedMessage = "Приём ответов на эту форму закрыт."

// publicFormService — часть сервиса форм, нужная публичному транспорту.
type publicFormService interface {
	PublicForm(ctx context.Context, slug string) (PublicForm, error)
	// ShowBadge — решение о бейдже «Сделано в Trillix»: намерение автора из схемы
	// плюс разрешение тарифа. Свойство выдачи, а не документа (спека §9.4).
	ShowBadge(ctx context.Context, workspaceID uuid.UUID, design *domain.FormDesign) (bool, error)
	// CollectPartial — собирать ли черновики у этой формы прямо сейчас: намерение
	// автора (тумблер) плюс разрешение тарифа.
	CollectPartial(ctx context.Context, workspaceID uuid.UUID, intent bool) (bool, error)
}

// PublicHandler — публичный транспорт форм (без авторизации и CSRF): отдаёт схему
// опубликованной версии по slug. Отдельный от Handler ровно потому, что у этих
// роутов нет RequireAuth — их регистрирует composition root без приватных middleware.
type PublicHandler struct {
	svc           publicFormService
	tokenSecret   []byte
	publicBaseURL string // база рендерера: og:url на /r/{slug} и ссылка на форму
	ogImageURL    string // абсолютный URL картинки превью (og:image)
	// indexPath — путь к собранному index.html рендерера. Пустой в dev: тогда /r не
	// обслуживается Go (форму отдаёт vite-dev), и index не читается вовсе.
	indexPath string
	// index — разобранный документ (см. indexDoc). Атомарный указатель, потому что
	// файл перечитывается на лету при подмене на диске: читатели идут без блокировки,
	// подмена — одной записью указателя.
	index atomic.Pointer[indexDoc]
	now   func() time.Time // подменяется в тестах
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
		doc, err := parseIndexHTML(indexHTMLPath)
		if err != nil {
			return nil, err
		}
		h.indexPath = indexHTMLPath
		h.index.Store(doc)
	}
	return h, nil
}

// Routes регистрирует публичные эндпоинты форм на общем mux: JSON-ручку рендерера
// (/public/v1) и — только когда задан собранный index.html (прод) — HTML-страницу
// формы с OG-мета (/r/{slug}). В dev /r отдаёт vite-dev, поэтому Go его не регит.
func (h *PublicHandler) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /public/v1/forms/{slug}", h.get)
	if h.indexPath != "" {
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
	// ShowBadge — рисовать ли бейдж «Сделано в Trillix». Решение СЕРВЕРА и
	// свойство выдачи, а не документа: в схеме лежит лишь намерение автора, а
	// разрешает его тариф (спека §9.4). Поле, а не вывод клиента из схемы, ровно
	// поэтому — тариф клиенту знать неоткуда и незачем.
	ShowBadge bool `json:"showBadge"`
	// CollectPartial — сохранять ли набранное до отправки. Решение СЕРВЕРА: тумблер
	// автора плюс разрешение тарифа прямо сейчас (даунгрейд останавливает сбор, как
	// и с бейджем). Рендерер по этому полю делает ровно две вещи — автосохраняет и
	// предупреждает респондента; разъехаться они не могут, потому что факт один.
	CollectPartial bool `json:"collectPartial"`
}

// closedFormResponse — тело GET /public/v1/forms/{slug} для ЗАКРЫТОЙ формы (HTTP
// 410 Gone). Схемы и токена нет — принимать ответ нельзя; рендерер по 410 рисует
// экран «приём закрыт» из этих полей. closedMessage уже разрезолвлен (свой/дефолт).
type closedFormResponse struct {
	Closed        bool   `json:"closed"`
	Title         string `json:"title"`
	ClosedMessage string `json:"closedMessage"`
	// Бейдж стоит и на этом экране: иначе он снимается разглядыванием второго
	// экрана — открыл закрытую форму, и бренда нет.
	ShowBadge bool `json:"showBadge"`
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
			Closed: true,
			// Свой разбор снапшота: ветка редкая (форма закрыта), и тащить его
			// выше общего пути ради неё незачем. Битая схема бейджу не мешает —
			// намерения в ней просто нет.
			ShowBadge: h.showBadge(r, pf.WorkspaceID, designOf(pf.Schema)),
			// Экран «приём закрыт» — единственное место рендерера, где заголовок
			// показывается БЕЗ схемы (её в 410 нет вовсе), поэтому пустоту здесь
			// замещаем так же, как в <title> вкладки.
			Title:         titleOrFallback(pf.Title),
			ClosedMessage: closedMessageOrDefault(pf.ClosedMessage),
		})
		return
	}

	// ETag = id опубликованной версии: иммутабелен, меняется только при новой
	// публикации. Кэш 60 с — терпимо для формы (правки видны после переиздания).
	//
	// ПЛЮС СОСТОЯНИЕ БЕЙДЖА: оно не часть версии, а часть ПРЕДСТАВЛЕНИЯ, и меняется
	// от смены тарифа, а не от переиздания. Без него подписавшийся автор получал бы
	// на каждый повторный запрос 304 с прежним телом — то есть бейдж оставался бы у
	// всех, кто уже открывал форму, пока не сменится версия.
	// Здесь снапшот разбирается ОДИН раз на обе его роли: намерение автора про бейдж
	// и канон схемы для рендерера (потому и не CanonicalV4 — тот разобрал бы его
	// вторично). Разбор — самая дорогая операция на этом пути (документ формы
	// целиком), и платить им за одно булево поле не нужно.
	//
	// ЧЕСТНО ПРО ОБЩИЙ СЧЁТ: разборов на запрос всё равно два — первый делает
	// PublicForm, разрешая заголовок из документа версии (service.go). Бейдж его не
	// добавил и не убрал; чинится это тем, что сервис отдавал бы уже разобранную
	// схему, а не сырую, — правка контракта ради микросекунд, поэтому не сделана.
	parsed, perr := domain.ValidateSchema(pf.Schema)
	var design *domain.FormDesign
	if perr == nil {
		design = parsed.Design
	}

	showBadge := h.showBadge(r, pf.WorkspaceID, design)
	etag := `"` + pf.VersionID.String() + badgeETagSuffix(showBadge) + `"`
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.Header().Set("ETag", etag)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	// Рендерер знает только текущий формат — старая опубликованная версия
	// апгрейдится до v4 на отдаче (иммутабельный снапшот в БД не трогаем).
	// Апгрейд уже сделан разбором выше; здесь остаётся сериализация.
	if perr != nil {
		httpserver.WriteError(w, r, fmt.Errorf("canonical public schema %s: %w", r.PathValue("slug"), perr))
		return
	}
	schema, err := json.Marshal(parsed)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("marshal public schema %s: %w", r.PathValue("slug"), err))
		return
	}

	// Токен выдаётся на каждый ответ; при кэшировании его возраст растёт, но это
	// только усиливает проверку «не раньше 3 с» (свежий мгновенный токен — бот).
	httpserver.WriteJSON(w, r, http.StatusOK, publicFormResponse{
		Title:          pf.Title,
		Version:        pf.Version,
		Schema:         schema,
		Token:          token.Issue(h.tokenSecret, h.now().UTC()),
		ShowBadge:      showBadge,
		CollectPartial: h.collectPartial(r, pf.WorkspaceID, pf.CollectPartial),
	})
}

// collectPartial — решение «собирать ли черновики» для этой выдачи. Сбой опроса
// тарифа сбор НЕ начинает: невзятый черновик дешевле, чем взятый без права
// (у бейджа выбор обратный — там при сбое остаётся бренд).
func (h *PublicHandler) collectPartial(r *http.Request, workspaceID uuid.UUID, intent bool) bool {
	on, err := h.svc.CollectPartial(r.Context(), workspaceID, intent)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("collect partial gate",
			slog.String("workspace_id", workspaceID.String()), slog.String("error", err.Error()))
		return false
	}
	return on
}

// showBadge — решение «рисовать ли бейдж» для этой выдачи. Сбой опроса тарифа не
// имеет права уронить публичную форму: бейдж остаётся, причина уходит в лог с
// request_id (лишний бейдж у платящего дешевле, чем пятисотка респонденту).
//
// Схема разбирается ОТКАЗОУСТОЙЧИВО и только ради одного поля — намерения автора.
// Битая схема на этом пути невозможна (снапшот проверен при публикации), но
// возвращать из-за неё 500 незачем: бейдж по умолчанию стоит.
func (h *PublicHandler) showBadge(r *http.Request, workspaceID uuid.UUID, design *domain.FormDesign) bool {
	show, err := h.svc.ShowBadge(r.Context(), workspaceID, design)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("проверка тарифа для бейджа",
			slog.String("workspace_id", workspaceID.String()), slog.String("error", err.Error()))
	}
	return show
}

// designOf — оформление из снапшота, отказоустойчиво: неразбираемая схема даёт nil,
// то есть «намерения снять бейдж нет». Публичный путь из-за разбора не падает.
func designOf(raw json.RawMessage) *domain.FormDesign {
	parsed, err := domain.ValidateSchema(raw)
	if err != nil {
		return nil
	}
	return parsed.Design
}

// badgeETagSuffix — метка состояния бейджа в ETag. Отдельной функцией, а не
// тернарником по месту: суффикс участвует в сравнении с If-None-Match, и обе
// стороны обязаны считать его одинаково.
func badgeETagSuffix(showBadge bool) string {
	if showBadge {
		return "+b"
	}
	return ""
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
