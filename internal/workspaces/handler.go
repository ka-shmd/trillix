package workspaces

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

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
	Invite(ctx context.Context, inviterID, workspaceID uuid.UUID, email string, role Role) error
	PreviewInvitation(ctx context.Context, rawToken string) (Invitation, error)
	AcceptInvitation(ctx context.Context, userID uuid.UUID, userEmail, rawToken string) (Workspace, error)
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
	mux.Handle("POST /api/v1/workspaces/{id}/invitations", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.invite))))
	// Просмотр приглашения — БЕЗ RequireAuth намеренно: аккаунта у приглашённого
	// может ещё не быть, а понять, куда его зовут, он должен до регистрации.
	// Право здесь — сам токен: знание ссылки и есть доказательство.
	mux.Handle("GET /api/v1/invitations/{token}", http.HandlerFunc(h.previewInvite))
	mux.Handle("POST /api/v1/invitations/{token}/accept", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.acceptInvite))))
}

type inviteRequest struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

// invitationResponse — что видит приглашённый ДО принятия. Ни id пространства,
// ни кто ещё в нём состоит: до принятия он посторонний.
type invitationResponse struct {
	WorkspaceName string `json:"workspaceName"`
	Email         string `json:"email"`
	Role          string `json:"role"`
	// state — usable | used | expired: экран говорит человеку, что делать.
	State string `json:"state"`
}

func (h *Handler) invite(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	workspaceID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	var req inviteRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if err := h.svc.Invite(r.Context(), u.ID, workspaceID, req.Email, Role(req.Role)); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) previewInvite(w http.ResponseWriter, r *http.Request) {
	inv, err := h.svc.PreviewInvitation(r.Context(), r.PathValue("token"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	state := "usable"
	switch {
	case inv.Used():
		state = "used"
	case inv.Expired(time.Now()):
		state = "expired"
	}
	httpserver.WriteJSON(w, r, http.StatusOK, invitationResponse{
		WorkspaceName: inv.WorkspaceName,
		Email:         inv.Email,
		Role:          string(inv.Role),
		State:         state,
	})
}

func (h *Handler) acceptInvite(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	ws, err := h.svc.AcceptInvitation(r.Context(), u.ID, u.Email, r.PathValue("token"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toResponse(ws))
}

// decodeBody — общий разбор тела с потолком и запретом неизвестных полей
// (инвариант 3: MaxBytesReader на каждом эндпоинте с телом).
func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxCreateBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: тело запроса слишком велико", domain.ErrValidation))
		return false
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return false
	}
	return true
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

	var req createRequest
	if !decodeBody(w, r, &req) {
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
