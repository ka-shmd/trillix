package workspaces

import (
	"context"
	"net/http"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Middleware — HTTP-обёртка (RequireAuth из auth), инжектируется в composition
// root: workspaces не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// listService — часть сервиса, нужная транспорту (листинг воркспейсов пользователя).
type listService interface {
	ListForUser(ctx context.Context, userID uuid.UUID) ([]Workspace, error)
}

// Handler — приватный транспорт модуля workspaces. Чтение — за RequireAuth.
type Handler struct {
	svc         listService
	requireAuth Middleware
}

func NewHandler(svc listService, requireAuth Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/workspaces", h.requireAuth(http.HandlerFunc(h.list)))
}

type workspaceResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type listResponse struct {
	Workspaces []workspaceResponse `json:"workspaces"`
}

// list отдаёт воркспейсы текущего пользователя (в MVP — один личный) для крошек
// кабинета. Пользователь — из контекста RequireAuth.
func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	items, err := h.svc.ListForUser(r.Context(), u.ID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	resp := listResponse{Workspaces: make([]workspaceResponse, len(items))}
	for i, ws := range items {
		resp.Workspaces[i] = workspaceResponse{ID: ws.ID.String(), Name: ws.Name}
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}
