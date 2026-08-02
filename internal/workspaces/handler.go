package workspaces

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Middleware — HTTP-обёртка (RequireAuth из auth), инжектируется в composition
// root: workspaces не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// workspaceService — часть сервиса, нужная транспорту.
type workspaceService interface {
	ListForUser(ctx context.Context, userID uuid.UUID) ([]Workspace, error)
	Create(ctx context.Context, userID uuid.UUID, name string) (Workspace, error)
}

// maxCreateBodyBytes — потолок тела создания: в нём одно короткое имя
// (инвариант безопасности 3 — MaxBytesReader на каждом эндпоинте с телом).
const maxCreateBodyBytes = 4 << 10

// Handler — приватный транспорт модуля workspaces. Чтение — за RequireAuth,
// запись — ещё и за RequireCSRF.
type Handler struct {
	svc         workspaceService
	requireAuth Middleware
	requireCSRF Middleware
}

func NewHandler(svc workspaceService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/workspaces", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/workspaces", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.create))))
}

type workspaceResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// isPersonal — личное пространство спрашивающего: кабинет помечает его в
	// списке и не показывает у него действий «покинуть»/«удалить».
	IsPersonal bool `json:"isPersonal"`
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
		resp.Workspaces[i] = toResponse(ws)
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

type createRequest struct {
	Name string `json:"name"`
}

// create заводит командное пространство. Владелец — текущий пользователь (из
// контекста RequireAuth, а не из тела: id в теле правом не является).
func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxCreateBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: тело запроса слишком велико", domain.ErrValidation))
		return
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	var req createRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	ws, err := h.svc.Create(r.Context(), u.ID, req.Name)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toResponse(ws))
}

func toResponse(ws Workspace) workspaceResponse {
	return workspaceResponse{ID: ws.ID.String(), Name: ws.Name, IsPersonal: ws.IsPersonal}
}
