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

// RateLimiter — лимитер приглашений. Реализация — ratelimit.TokenBucket;
// в тестах инжектируется пермиссивный (инвариант 6: лимит не ослабляется ради
// прохождения теста).
type RateLimiter interface {
	Allow(key string) bool
}

// Middleware — HTTP-обёртка (RequireAuth из auth), инжектируется в composition
// root: workspaces не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// workspaceService — часть сервиса, нужная транспорту.
type workspaceService interface {
	ListForUser(ctx context.Context, userID uuid.UUID) ([]Workspace, error)
	Create(ctx context.Context, userID uuid.UUID, name string) (Workspace, error)
	Rename(ctx context.Context, userID, workspaceID uuid.UUID, name string) (Workspace, error)
	Invite(ctx context.Context, inviterID, workspaceID uuid.UUID, email string, role Role) error
	PreviewInvitation(ctx context.Context, rawToken string) (Invitation, error)
	AcceptInvitation(ctx context.Context, userID uuid.UUID, userEmail, rawToken string) (Workspace, error)
	Members(ctx context.Context, userID, workspaceID uuid.UUID) ([]Member, []PendingInvite, error)
	RemoveMember(ctx context.Context, actorID, workspaceID, memberID uuid.UUID) error
	Leave(ctx context.Context, userID, workspaceID uuid.UUID) error
	AllowedActions(ctx context.Context, workspaceID, userID uuid.UUID) ([]domain.Action, error)
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
	// inviteLimiter — ведро по ПОЛЬЗОВАТЕЛЮ: приглашение — единственная ручка,
	// отправляющая письмо на произвольный адрес, причём с подконтрольным
	// отправителю текстом (имя пространства попадает в тело). Без лимитера один
	// аккаунт превращается в рассылку с нашего домена, и в спам-лист уезжают
	// заодно письма подтверждения живых пользователей. Ключ — id пользователя,
	// а не IP: он есть после RequireAuth и не размывается за NAT.
	inviteLimiter RateLimiter
}

func NewHandler(svc workspaceService, inviteLimiter RateLimiter, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, inviteLimiter: inviteLimiter, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/workspaces", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/workspaces", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.create))))
	mux.Handle("PATCH /api/v1/workspaces/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.rename))))
	mux.Handle("POST /api/v1/workspaces/{id}/invitations", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.invite))))
	// Просмотр приглашения — БЕЗ RequireAuth намеренно: аккаунта у приглашённого
	// может ещё не быть, а понять, куда его зовут, он должен до регистрации.
	// Право здесь — сам токен: знание ссылки и есть доказательство.
	mux.Handle("GET /api/v1/invitations/{token}", http.HandlerFunc(h.previewInvite))
	mux.Handle("POST /api/v1/invitations/{token}/accept", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.acceptInvite))))
	mux.Handle("GET /api/v1/workspaces/{id}/members", h.requireAuth(http.HandlerFunc(h.members)))
	mux.Handle("DELETE /api/v1/workspaces/{id}/members/{userId}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.removeMember))))
	mux.Handle("POST /api/v1/workspaces/{id}/leave", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.leave))))
}

type memberResponse struct {
	UserID string `json:"userId"`
	Email  string `json:"email"`
	// Имя и ключ аватара — для кружка и подписи в списке участников. Пустые
	// строки вместо null: null и "" на границе не различаются, а внутри
	// различаются (колонки nullable), поэтому приведение делает repo.
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	AvatarKey string `json:"avatarKey"`
	Role      string `json:"role"`
	JoinedAt  string `json:"joinedAt"`
}

type pendingInviteResponse struct {
	Email     string `json:"email"`
	Role      string `json:"role"`
	ExpiresAt string `json:"expiresAt"`
}

type membersResponse struct {
	Members []memberResponse        `json:"members"`
	Invites []pendingInviteResponse `json:"invites"`
	// permissions — что МОЖЕТ спрашивающий в этом пространстве. Кабинет прячет
	// по нему кнопки и не дублирует матрицу прав в TypeScript.
	Permissions []string `json:"permissions"`
}

func (h *Handler) members(w http.ResponseWriter, r *http.Request) {
	u, workspaceID, ok := userAndWorkspace(w, r)
	if !ok {
		return
	}
	members, invites, err := h.svc.Members(r.Context(), u.ID, workspaceID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	actions, err := h.svc.AllowedActions(r.Context(), workspaceID, u.ID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	resp := membersResponse{
		Members:     make([]memberResponse, len(members)),
		Invites:     make([]pendingInviteResponse, len(invites)),
		Permissions: make([]string, len(actions)),
	}
	for i, m := range members {
		resp.Members[i] = memberResponse{
			UserID: m.UserID.String(), Email: m.Email,
			FirstName: m.FirstName, LastName: m.LastName, AvatarKey: m.AvatarKey,
			Role:     string(m.Role),
			JoinedAt: m.JoinedAt.UTC().Format(time.RFC3339),
		}
	}
	for i, inv := range invites {
		resp.Invites[i] = pendingInviteResponse{
			Email: inv.Email, Role: string(inv.Role),
			ExpiresAt: inv.ExpiresAt.UTC().Format(time.RFC3339),
		}
	}
	for i, a := range actions {
		resp.Permissions[i] = string(a)
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

func (h *Handler) removeMember(w http.ResponseWriter, r *http.Request) {
	u, workspaceID, ok := userAndWorkspace(w, r)
	if !ok {
		return
	}
	memberID, err := uuid.Parse(r.PathValue("userId"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	if err := h.svc.RemoveMember(r.Context(), u.ID, workspaceID, memberID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) leave(w http.ResponseWriter, r *http.Request) {
	u, workspaceID, ok := userAndWorkspace(w, r)
	if !ok {
		return
	}
	if err := h.svc.Leave(r.Context(), u.ID, workspaceID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// userAndWorkspace — общий разбор «кто спрашивает и про какое пространство».
// Кривой id — 404, а не 422: чужое существование не обсуждается.
func userAndWorkspace(w http.ResponseWriter, r *http.Request) (auth.User, uuid.UUID, bool) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return auth.User{}, uuid.Nil, false
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return auth.User{}, uuid.Nil, false
	}
	return u, id, true
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
	if !h.inviteLimiter.Allow(u.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много приглашений", domain.ErrRateLimited))
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
	// formCount — сколько форм в пространстве (подпись рядом с названием в
	// обзоре). Точен на СПИСКЕ; у ответов мутаций всегда 0 — они отвечают самой
	// вывеской, а число кабинет перечитает списком.
	FormCount int64 `json:"formCount"`
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

// create заводит дополнительное пространство. Владелец — текущий пользователь (из
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

type renameRequest struct {
	Name string `json:"name"`
}

// rename правит название пространства. Кривой id — 404, а не 422: чужое
// существование не обсуждается (тем же занят userAndWorkspace, который здесь и
// разбирает адрес).
func (h *Handler) rename(w http.ResponseWriter, r *http.Request) {
	u, workspaceID, ok := userAndWorkspace(w, r)
	if !ok {
		return
	}
	var req renameRequest
	if !decodeBody(w, r, &req) {
		return
	}
	ws, err := h.svc.Rename(r.Context(), u.ID, workspaceID, req.Name)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toResponse(ws))
}

func toResponse(ws Workspace) workspaceResponse {
	return workspaceResponse{
		ID: ws.ID.String(), Name: ws.Name, IsPersonal: ws.IsPersonal, FormCount: ws.FormCount,
	}
}
