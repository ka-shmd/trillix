package entitlements

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// snapshotService — часть сервиса, нужная приватному транспорту.
type snapshotService interface {
	Snapshot(ctx context.Context, userID, workspaceID uuid.UUID) (Snapshot, error)
}

// Middleware — обёртка аутентификации (реализация — auth.Handler.RequireAuth),
// инжектируется в composition root.
type Middleware = func(http.Handler) http.Handler

// Access — права в пространстве глазами транспорта тарифов. Объявлен здесь, а
// не импортирован из workspaces: тот сам спрашивает лимиты у entitlements, и
// обратный импорт замкнул бы цикл. Тип действия живёт в domain ровно поэтому.
type Access interface {
	Can(ctx context.Context, workspaceID, userID uuid.UUID, action domain.Action) error
}

type Handler struct {
	svc         snapshotService
	access      Access
	requireAuth Middleware
}

func NewHandler(svc snapshotService, access Access, requireAuth Middleware) *Handler {
	return &Handler{svc: svc, access: access, requireAuth: requireAuth}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/workspaces/{id}/entitlements", h.requireAuth(http.HandlerFunc(h.snapshot)))
}

// featureResponse — одна возможность в снимке.
//
// limit == nil означает безлимит (в JSON — null), и это НЕ то же самое, что 0:
// ноль запрещает всё. У булевых возможностей used/limit не заполняются.
type featureResponse struct {
	Key     string `json:"key"`
	Title   string `json:"title"`
	Kind    string `json:"kind"` // quota | toggle
	Allowed bool   `json:"allowed"`
	Used    int64  `json:"used"`
	Limit   *int64 `json:"limit"`
}

type snapshotResponse struct {
	PlanCode  string            `json:"planCode"`
	PlanTitle string            `json:"planTitle"`
	PeriodEnd string            `json:"periodEnd"` // когда обнулится расход
	Features  []featureResponse `json:"features"`
}

// snapshot отдаёт снимок тарифа. Тариф — дело ВЛАДЕЛЬЦА: редактор пространства
// видит формы и ответы, но не то, за что и сколько платят (матрица прав,
// internal/workspaces). Право спрашивается по действию, а не по роли — иначе
// персональные исключения потребовали бы править и этот файл.
func (h *Handler) snapshot(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	workspaceID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		// Кривой id — «нет такого», а не 422: чужое существование не обсуждается.
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}

	if err := h.access.Can(r.Context(), workspaceID, u.ID, domain.ActionBillingView); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	snap, err := h.svc.Snapshot(r.Context(), u.ID, workspaceID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	// Порядок возможностей задаёт КАТАЛОГ, а не карта: обход map в Go
	// рандомизирован, и список на странице тарифа прыгал бы при каждом запросе.
	features := make([]featureResponse, 0, len(snap.Features))
	for _, key := range CatalogOrder {
		d, ok := snap.Features[key]
		if !ok {
			continue // аккаунт-уровневые в снимок не входят
		}
		f := Catalog[key]
		features = append(features, featureResponse{
			Key:     string(key),
			Title:   f.Title,
			Kind:    kindName(f.Kind),
			Allowed: d.Allowed,
			Used:    d.Used,
			Limit:   d.Limit,
		})
	}

	httpserver.WriteJSON(w, r, http.StatusOK, snapshotResponse{
		PlanCode:  snap.PlanCode,
		PlanTitle: snap.PlanTitle,
		PeriodEnd: snap.PeriodEnd.Format("2006-01-02"),
		Features:  features,
	})
}

func kindName(k Kind) string {
	if k == Toggle {
		return "toggle"
	}
	return "quota"
}
