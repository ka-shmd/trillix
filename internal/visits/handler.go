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

// funnelService — часть сервиса, нужная приватному транспорту.
type funnelService interface {
	Funnel(ctx context.Context, userID, formID uuid.UUID) (domain.Funnel, error)
}

// Handler — приватный транспорт модуля visits: автор смотрит воронку своей формы.
// Только чтение, поэтому CSRF не нужен (как у листинга и сводки ответов).
type Handler struct {
	svc         funnelService
	requireAuth Middleware
}

func NewHandler(svc funnelService, requireAuth Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms/{id}/funnel", h.requireAuth(http.HandlerFunc(h.funnel)))
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

	start := time.Now()
	f, err := h.svc.Funnel(r.Context(), u.ID, formID)
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
