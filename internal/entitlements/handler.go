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
	AccountSnapshot(ctx context.Context, userID uuid.UUID) (AccountSnapshot, error)
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
	// Тариф аккаунта: платит человек, а не пространство (ADR §10). Id в адресе нет
	// и быть не может — субъект тут сам спрашивающий, и другого он не назовёт.
	mux.Handle("GET /api/v1/account/entitlements", h.requireAuth(http.HandlerFunc(h.accountSnapshot)))
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

// workspaceResponse — пространство аккаунта и его собственные квоты в аккаунтном
// снимке.
type workspaceResponse struct {
	ID         string            `json:"id"`
	Slug       string            `json:"slug"`
	Name       string            `json:"name"`
	IsPersonal bool              `json:"isPersonal"`
	Features   []featureResponse `json:"features"`
}

type accountSnapshotResponse struct {
	PlanCode   string              `json:"planCode"`
	PlanTitle  string              `json:"planTitle"`
	PeriodEnd  string              `json:"periodEnd"`
	Features   []featureResponse   `json:"features"`
	Workspaces []workspaceResponse `json:"workspaces"`
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

	httpserver.WriteJSON(w, r, http.StatusOK, snapshotResponse{
		PlanCode:  snap.PlanCode,
		PlanTitle: snap.PlanTitle,
		PeriodEnd: snap.PeriodEnd.Format("2006-01-02"),
		Features:  featureList(snap.Features),
	})
}

// accountSnapshot отдаёт снимок тарифа аккаунта. Проверять права не у кого и не о
// чём: субъект — сам спрашивающий, а пространства отбирает запрос по владению.
func (h *Handler) accountSnapshot(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}

	snap, err := h.svc.AccountSnapshot(r.Context(), u.ID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	workspaces := make([]workspaceResponse, 0, len(snap.Workspaces))
	for _, ws := range snap.Workspaces {
		workspaces = append(workspaces, workspaceResponse{
			ID:         ws.ID.String(),
			Slug:       ws.Slug,
			Name:       ws.Name,
			IsPersonal: ws.IsPersonal,
			Features:   featureList(ws.Features),
		})
	}

	httpserver.WriteJSON(w, r, http.StatusOK, accountSnapshotResponse{
		PlanCode:   snap.PlanCode,
		PlanTitle:  snap.PlanTitle,
		PeriodEnd:  snap.PeriodEnd.Format("2006-01-02"),
		Features:   featureList(snap.Features),
		Workspaces: workspaces,
	})
}

// featureList — возможности снимка в порядке КАТАЛОГА, а не карты: обход map в Go
// рандомизирован, и список на странице тарифа прыгал бы при каждом запросе.
// Ключи, которых в снимке нет, пропускаются молча — каждый снимок берёт свою часть
// каталога, и отсутствие ключа здесь не ошибка конфигурации (её ловит decide).
func featureList(decisions map[Key]Decision) []featureResponse {
	features := make([]featureResponse, 0, len(decisions))
	for _, key := range CatalogOrder {
		d, ok := decisions[key]
		if !ok {
			continue
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
	return features
}

func kindName(k Kind) string {
	if k == Toggle {
		return "toggle"
	}
	return "quota"
}
