package visits

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Middleware — HTTP-обёртка (RequireAuth из auth), инжектируемая в composition root:
// visits не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// analyticsService — часть сервиса, нужная приватному транспорту.
type analyticsService interface {
	Funnel(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (domain.Funnel, error)
	Insights(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (domain.VisitInsights, error)
	Breakdown(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (domain.VisitsBreakdown, error)
}

// Handler — приватный транспорт модуля visits: автор смотрит воронку своей формы.
// Только чтение, поэтому CSRF не нужен (как у листинга и сводки ответов).
type Handler struct {
	svc         analyticsService
	requireAuth Middleware
}

func NewHandler(svc analyticsService, requireAuth Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms/{id}/funnel", h.requireAuth(http.HandlerFunc(h.funnel)))
	mux.Handle("GET /api/v1/forms/{id}/insights", h.requireAuth(http.HandlerFunc(h.insights)))
	mux.Handle("GET /api/v1/forms/{id}/insights/visits", h.requireAuth(http.HandlerFunc(h.breakdown)))
}

type funnelStepResponse struct {
	BlockID     string `json:"blockId"`
	Label       string `json:"label"`
	Reached     int    `json:"reached"`
	DroppedHere int    `json:"droppedHere"`
}

type funnelResponse struct {
	Visits          int                  `json:"visits"`
	Submitted       int                  `json:"submitted"`
	LeftBeforeFirst int                  `json:"leftBeforeFirst"`
	Steps           []funnelStepResponse `json:"steps"`
}

// funnel отдаёт воронку формы: сколько визитов дошло до каждого вопроса и сколько
// остановилось именно на нём.
//
// Наружу уходят только счётчики — ни одного ответа респондента, как и в сводке.
// Логирует строку со знаменателем (сколько визитов свернули и за сколько): голая
// длительность из общего middleware бесполезна — 900 мс на 300 визитах и на 30 000
// это разные новости (ARCHITECTURE §«Мониторинг», счётчики в лог, а не Prometheus).
func (h *Handler) funnel(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Неразбираемый uuid → 404 (несуществующая форма), а не 400: существование
	// приватного не раскрывается ничем, включая форму ошибки.
	formID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}

	period, err := httpserver.PeriodFromRequest(r)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	start := time.Now()
	f, err := h.svc.Funnel(r.Context(), u.ID, formID, period)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.LoggerFrom(r.Context()).Info("visits funnel",
		slog.String("form_id", formID.String()),
		slog.Int("visits", f.Visits),
		slog.Int("questions", len(f.Steps)),
		slog.Duration("duration", time.Since(start)),
	)

	// Шаги — всегда массив, а не null: пустой JSON-массив фронт рисует как «вопросов
	// нет», а null пришлось бы обрабатывать отдельной веткой на каждом потребителе.
	steps := make([]funnelStepResponse, len(f.Steps))
	for i, s := range f.Steps {
		steps[i] = funnelStepResponse{
			BlockID:     s.BlockID,
			Label:       s.Label,
			Reached:     s.Reached,
			DroppedHere: s.DroppedHere,
		}
	}
	httpserver.WriteJSON(w, r, http.StatusOK, funnelResponse{
		Visits:          f.Visits,
		Submitted:       f.Submitted,
		LeftBeforeFirst: f.LeftBeforeFirst,
		Steps:           steps,
	})
}

// insightsResponse — карточки над вкладками Insights в части визитов.
//
// timedVisits отдаётся наружу не для показа: это знаменатель медианы, по которому
// экран отличает «0 секунд» от «данных ещё нет» (второе рисуется прочерком).
type insightsResponse struct {
	Visits    int `json:"visits"`
	Submitted int `json:"submitted"`
	// uniqueVisitors за период длиннее суток ЗАВЫШЕН: ключ посетителя ротируется
	// ежесуточно. Граница записана в ANALYTICS.md; на экран не выносится.
	UniqueVisitors    int     `json:"uniqueVisitors"`
	TimedVisits       int     `json:"timedVisits"`
	MedianDurationSec float64 `json:"medianDurationSec"`
}

// insights отдаёт счётчики визитов за период. Число ответов формы сюда не входит —
// это другое множество и другой модуль (ANALYTICS.md §1); кабинет берёт его своим
// запросом и рисует соседней карточкой.
func (h *Handler) insights(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	formID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	period, err := httpserver.PeriodFromRequest(r)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	start := time.Now()
	in, err := h.svc.Insights(r.Context(), u.ID, formID, period)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.LoggerFrom(r.Context()).Info("visits insights",
		slog.String("form_id", formID.String()),
		slog.Int("visits", in.Visits),
		slog.Duration("duration", time.Since(start)),
	)
	httpserver.WriteJSON(w, r, http.StatusOK, insightsResponse{
		Visits:            in.Visits,
		Submitted:         in.Submitted,
		UniqueVisitors:    in.UniqueVisitors,
		TimedVisits:       in.TimedVisits,
		MedianDurationSec: in.MedianDurationSec,
	})
}

// --- DTO вкладки «Визиты» ---

type timeBucketResponse struct {
	At        string `json:"at"`
	Visits    int    `json:"visits"`
	Submitted int    `json:"submitted"`
}

type sourceResponse struct {
	Source string `json:"source"`
	Medium string `json:"medium"`
	Visits int    `json:"visits"`
}

type labelCountResponse struct {
	Label  string `json:"label"`
	Visits int    `json:"visits"`
}

// placeResponse — строка стран или городов. countryCode едет рядом с названием
// ради флага: у страны это её код, у города — код его страны.
type placeResponse struct {
	Name        string `json:"name"`
	CountryCode string `json:"countryCode"`
	Visits      int    `json:"visits"`
}

type breakdownResponse struct {
	Step       string               `json:"step"`
	Timeseries []timeBucketResponse `json:"timeseries"`
	// Sources пуст при sourcesLocked: разбивка закрыта тарифом. knownSources при
	// этом настоящий — визиты собираются у всех планов, платным стал показ.
	Sources       []sourceResponse     `json:"sources"`
	SourcesLocked bool                 `json:"sourcesLocked"`
	KnownSources  int                  `json:"knownSources"`
	Devices       []labelCountResponse `json:"devices"`
	Browsers      []labelCountResponse `json:"browsers"`
	Systems       []labelCountResponse `json:"systems"`
	// Countries и Cities пусты, если справочника гео на контуре нет. unknownPlace —
	// визиты, которым место не определили (справочника нет, приватный адрес, IPv6):
	// граница метрики уходит наружу и показывается рядом со списком.
	Countries    []placeResponse `json:"countries"`
	Cities       []placeResponse `json:"cities"`
	UnknownPlace int             `json:"unknownPlace"`
	// geoConfigured отличает «справочника нет» от «есть, но мест не определили».
	GeoConfigured bool `json:"geoConfigured"`
}

// breakdown отдаёт вкладку «Визиты»: ряд по времени, источники, устройства,
// браузеры, ОС. Наружу уходят только счётчики, как у сводки и воронки.
func (h *Handler) breakdown(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	formID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	period, err := httpserver.PeriodFromRequest(r)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	start := time.Now()
	b, err := h.svc.Breakdown(r.Context(), u.ID, formID, period)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.LoggerFrom(r.Context()).Info("visits breakdown",
		slog.String("form_id", formID.String()),
		slog.Int("buckets", len(b.Timeseries)),
		slog.Int("agents", len(b.Browsers)),
		slog.Duration("duration", time.Since(start)),
	)

	// Списки — всегда массивы, а не null: пустой массив фронт рисует как «данных
	// нет», а null пришлось бы обрабатывать отдельной веткой у каждого потребителя.
	series := make([]timeBucketResponse, len(b.Timeseries))
	for i, t := range b.Timeseries {
		series[i] = timeBucketResponse{
			At:        t.At.UTC().Format(time.RFC3339),
			Visits:    t.Visits,
			Submitted: t.Submitted,
		}
	}
	sources := make([]sourceResponse, len(b.Sources))
	for i, s := range b.Sources {
		sources[i] = sourceResponse{Source: s.Source, Medium: s.Medium, Visits: s.Visits}
	}
	httpserver.WriteJSON(w, r, http.StatusOK, breakdownResponse{
		Step:          string(b.Step),
		Countries:     places(b.Countries),
		Cities:        places(b.Cities),
		UnknownPlace:  b.UnknownPlace,
		GeoConfigured: b.GeoConfigured,
		Timeseries:    series,
		Sources:       sources,
		SourcesLocked: b.SourcesLocked,
		KnownSources:  b.KnownSources,
		Devices:       labelCounts(b.Devices),
		Browsers:      labelCounts(b.Browsers),
		Systems:       labelCounts(b.Systems),
	})
}

func labelCounts(in []domain.LabelCount) []labelCountResponse {
	out := make([]labelCountResponse, len(in))
	for i, l := range in {
		out[i] = labelCountResponse{Label: l.Label, Visits: l.Visits}
	}
	return out
}

func places(in []domain.PlaceCount) []placeResponse {
	out := make([]placeResponse, len(in))
	for i, p := range in {
		out[i] = placeResponse{Name: p.Name, CountryCode: p.CountryCode, Visits: p.Visits}
	}
	return out
}
