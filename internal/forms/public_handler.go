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
	// ShowBadge — решение о бейдже «Сделано в Trillix»: намерение автора (живая
	// колонка формы) плюс разрешение тарифа. Свойство выдачи, а не документа: и то
	// и другое спрашивается при заходе на форму (ADR §10).
	ShowBadge(ctx context.Context, workspaceID uuid.UUID, intent bool) (bool, error)
	// CollectPartial — собирать ли черновики у этой формы прямо сейчас: намерение
	// автора (тумблер) плюс разрешение тарифа.
	CollectPartial(ctx context.Context, workspaceID uuid.UUID, intent bool) (bool, error)
	// LinkPreviewFor — своя карточка ссылки, действующая прямо сейчас: намерение
	// автора плюс разрешение тарифа. nil = дефолты страницы.
	LinkPreviewFor(ctx context.Context, workspaceID uuid.UUID, p *domain.LinkPreview) (*domain.LinkPreview, error)
}

// PublicHandler — публичный транспорт форм (без авторизации и CSRF): отдаёт схему
// опубликованной версии по slug. Отдельный от Handler ровно потому, что у этих
// роутов нет RequireAuth — их регистрирует composition root без приватных middleware.
type PublicHandler struct {
	svc           publicFormService
	tokenSecret   []byte
	publicBaseURL string // база рендерера: og:url на /r/{slug} и ссылка на форму
	ogImageURL    string // абсолютный URL картинки превью (og:image)
	// tokenLimiter — ведро выдачи токена времени. Не опционально: это единственное,
	// что вообще ограничивает заготовку токенов пачкой (ADR §10).
	tokenLimiter httpserver.RateLimiter
	trustedProxy bool // за Caddy честный IP клиента — из X-Forwarded-For (TD-1)
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
func NewPublicHandler(svc publicFormService, tokenSecret []byte, publicBaseURL, ogImageURL, indexHTMLPath string,
	tokenLimiter httpserver.RateLimiter, trustedProxy bool,
) (*PublicHandler, error) {
	h := &PublicHandler{
		svc:           svc,
		tokenSecret:   tokenSecret,
		publicBaseURL: strings.TrimRight(publicBaseURL, "/"),
		ogImageURL:    ogImageURL,
		tokenLimiter:  tokenLimiter,
		trustedProxy:  trustedProxy,
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
	limited := httpserver.RateLimitByIP(h.tokenLimiter, h.trustedProxy, "слишком много запросов")
	mux.Handle("GET /public/v1/form-token", limited(http.HandlerFunc(h.formToken)))
	if h.indexPath != "" {
		mux.HandleFunc("GET /r/{slug}", h.getHTML)
	}
}

// publicFormResponse — тело GET /public/v1/forms/{slug}.
//
// Токена времени здесь НЕТ и быть не должно: ответ кэшируемый (max-age=60 плюс
// иммутабельный ETag), а значит его возраст измерял бы возраст записи в кэше
// браузера, а не время заполнения формы. Токен приезжает отдельной некэшируемой
// ручкой /public/v1/form-token — ADR §10.
type publicFormResponse struct {
	Title   string          `json:"title"`
	Version int32           `json:"version"`
	Schema  json.RawMessage `json:"schema"`
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
	// Progress — рисовать ли шкалу прогресса (индикатор шагов). В отличие от
	// ShowBadge и CollectPartial, это ЧИСТОЕ намерение автора, а не решение сервера:
	// тарифа у шкалы нет, спрашивать поверх намерения нечего. Полем, а не выводом
	// клиента из схемы, — потому что живёт оно в колонке формы, которой в снапшоте
	// версии нет.
	Progress bool `json:"progress"`
}

// closedFormResponse — тело GET /public/v1/forms/{slug} для ЗАКРЫТОЙ формы (HTTP
// 410 Gone). Схемы и токена нет — принимать ответ нельзя; рендерер по 410 рисует
// экран «приём закрыт» из этих полей. closedMessage уже разрезолвлен (свой/дефолт).
type closedFormResponse struct {
	Closed bool `json:"closed"`
	// Title — что написать заголовком: свой заголовок автора (0043), а если его нет
	// — название формы. Разрешает СЕРВЕР, чтобы у рендерера не было двух источников
	// одного заголовка и ветки «какой из них сейчас».
	Title         string `json:"title"`
	ClosedMessage string `json:"closedMessage"`
	// Бейдж стоит и на этом экране: иначе он снимается разглядыванием второго
	// экрана — открыл закрытую форму, и бренда нет.
	ShowBadge bool `json:"showBadge"`
}

// formTokenResponse — тело GET /public/v1/form-token.
type formTokenResponse struct {
	Token string `json:"token"`
}

// formToken выдаёт подписанное время выдачи — тот самый токен, чей возраст проверяют
// приём ответа, выдача слота файла и бикон визита.
//
// Ручка НЕ знает про форму и не ходит в базу: токен есть HMAC над временем, он не
// привязан к слагу (граница известна — TECH-DEBT §5), а обязательный slug стоил бы
// запроса в базу на каждое открытие формы ровно ради подписи времени.
//
// МИНА: ответ обязан быть некэшируемым. Токен жил в теле GET /forms/{slug} с
// max-age=60 и иммутабельным ETag, и из-за этого окно [minFillTime, MaxAge] мерило
// возраст записи в кэше браузера, а не человека: первое открытие формы всегда
// упиралось в отказ, а дальше 304 бессрочно возвращал первый токен. История —
// JOURNAL, «Токен формы выдаётся некэшируемым ответом».
func (h *PublicHandler) formToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	httpserver.WriteJSON(w, r, http.StatusOK, formTokenResponse{
		Token: token.Issue(h.tokenSecret, h.now().UTC()),
	})
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
			// Намерение о бейдже — живая колонка формы, поэтому разбирать снапшот
			// на этой ветке (форма закрыта, схемы в ответе нет) больше не нужно.
			ShowBadge: h.showBadge(r, pf.WorkspaceID, pf.Branding),
			// Экран «приём закрыт» — единственное место рендерера, где заголовок
			// показывается БЕЗ схемы (её в 410 нет вовсе), поэтому пустоту здесь
			// замещаем так же, как в <title> вкладки.
			Title:         closedTitle(pf),
			ClosedMessage: closedMessageOrDefault(pf.ClosedMessage),
		})
		return
	}

	// ETag = id опубликованной версии: иммутабелен, меняется только при новой
	// публикации. Кэш 60 с — терпимо для формы (правки видны после переиздания).
	//
	// ПЛЮС СОСТОЯНИЕ БЕЙДЖА: оно не часть версии, а часть ПРЕДСТАВЛЕНИЯ, и меняется
	// от тумблера автора и от смены тарифа, а не от переиздания. Без него автор,
	// снявший бейдж (или подписавшийся), получал бы на каждый повторный запрос 304 с
	// прежним телом — то есть бейдж оставался бы у всех, кто уже открывал форму,
	// пока не сменится версия.
	showBadge := h.showBadge(r, pf.WorkspaceID, pf.Branding)
	etag := `"` + pf.VersionID.String() + viewETagSuffix(showBadge, pf.Progress) + `"`
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.Header().Set("ETag", etag)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	// Рендерер знает только текущий формат — старая опубликованная версия
	// апгрейдится до v4 на отдаче (иммутабельный снапшот в БД не трогаем). Разбор
	// стоит ПОСЛЕ ветки 304: это самая дорогая операция пути (документ формы
	// целиком), и повторному запросу с тем же ETag она не нужна вовсе.
	//
	// ЧЕСТНО ПРО ОБЩИЙ СЧЁТ: на отдаче тела разборов всё равно два — первый делает
	// PublicForm, разрешая заголовок из документа версии (service.go). Чинится это
	// тем, что сервис отдавал бы уже разобранную схему, а не сырую, — правка
	// контракта ради микросекунд, поэтому не сделана.
	parsed, perr := domain.ValidateSchema(pf.Schema)
	if perr != nil {
		httpserver.WriteError(w, r, fmt.Errorf("canonical public schema %s: %w", r.PathValue("slug"), perr))
		return
	}
	schema, err := json.Marshal(parsed)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("marshal public schema %s: %w", r.PathValue("slug"), err))
		return
	}

	httpserver.WriteJSON(w, r, http.StatusOK, publicFormResponse{
		Title:          pf.Title,
		Version:        pf.Version,
		Schema:         schema,
		ShowBadge:      showBadge,
		CollectPartial: h.collectPartial(r, pf.WorkspaceID, pf.CollectPartial),
		Progress:       pf.Progress,
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

// closedTitle — заголовок экрана «приём закрыт»: свой заголовок автора, иначе
// название формы (иначе — общий фолбэк, как в <title> вкладки: у формы без названия
// заголовка нет вовсе).
func closedTitle(pf PublicForm) string {
	if pf.ClosedTitle != nil && *pf.ClosedTitle != "" {
		return *pf.ClosedTitle
	}
	return titleOrFallback(pf.Title)
}

// showBadge — решение «рисовать ли бейдж» для этой выдачи. Сбой опроса тарифа не
// имеет права уронить публичную форму: бейдж остаётся, причина уходит в лог с
// request_id (лишний бейдж у платящего дешевле, чем пятисотка респонденту).
func (h *PublicHandler) showBadge(r *http.Request, workspaceID uuid.UUID, intent bool) bool {
	show, err := h.svc.ShowBadge(r.Context(), workspaceID, intent)
	if err != nil {
		httpserver.LoggerFrom(r.Context()).Error("проверка тарифа для бейджа",
			slog.String("workspace_id", workspaceID.String()), slog.String("error", err.Error()))
	}
	return show
}

// viewETagSuffix — метка ПРЕДСТАВЛЕНИЯ в ETag: всё, что меняет тело ответа, не меняя
// опубликованной версии. Сегодня это бейдж (тумблер автора плюс тариф) и шкала
// прогресса (тумблер автора). Отдельной функцией, а не тернарником по месту: суффикс
// участвует в сравнении с If-None-Match, и обе стороны обязаны считать его одинаково.
//
// МИНА: забытый здесь признак означает 304 с прежним телом до самой перепубликации —
// автор переключил тумблер, а все, кто форму уже открывал, видят старое.
func viewETagSuffix(showBadge, progress bool) string {
	suffix := ""
	if showBadge {
		suffix += "+b"
	}
	if progress {
		suffix += "+p"
	}
	return suffix
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
