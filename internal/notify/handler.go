package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// composition root: notify не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// feedService — часть сервиса, нужная транспорту. Постановки и отбоя здесь нет:
// их зовут продюсеры внутри процесса, а не человек из браузера.
type feedService interface {
	Feed(ctx context.Context, userID, cursor uuid.UUID, limit int32) (Page, error)
	MarkRead(ctx context.Context, userID uuid.UUID, ids []uuid.UUID) error
	MarkAllRead(ctx context.Context, userID uuid.UUID) error
	Delete(ctx context.Context, userID, id uuid.UUID) error
	DeleteAll(ctx context.Context, userID uuid.UUID) error
}

// Handler — лента уведомлений в кабинете.
type Handler struct {
	svc         feedService
	requireAuth Middleware
	requireCSRF Middleware
}

func NewHandler(svc feedService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/notifications", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/notifications/read", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.read))))
	mux.Handle("DELETE /api/v1/notifications/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.delete))))
	mux.Handle("DELETE /api/v1/notifications", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.deleteAll))))
}

// maxReadBodyBytes — потолок тела отметки (инвариант 3). Пятьдесят id по 36
// символов с запасом на разметку: страница ленты больше не отдаёт.
const maxReadBodyBytes = 4 << 10

type notificationResponse struct {
	ID            uuid.UUID `json:"id"`
	WorkspaceID   uuid.UUID `json:"workspaceId"`
	WorkspaceName string    `json:"workspaceName"`
	WorkspaceSlug string    `json:"workspaceSlug"`
	Kind          string    `json:"kind"`
	// Text и Link собраны реестром поводов на сервере: второй реализации текста
	// не существует, и экран не решает, как называется повод.
	Text    string    `json:"text"`
	Link    string    `json:"link"`
	Count   int32     `json:"count"`
	FirstAt time.Time `json:"firstAt"`
	LastAt  time.Time `json:"lastAt"`
	Read    bool      `json:"read"`
}

type feedResponse struct {
	Items  []notificationResponse `json:"items"`
	Unread int64                  `json:"unread"`
	// NextCursor пуст, когда страница последняя.
	NextCursor string `json:"nextCursor,omitempty"`
}

// list отдаёт страницу ленты со счётчиком непрочитанных. Чужого в ней не бывает:
// отбор идёт по id спрашивающего, а строки пространств, из которых он ушёл,
// отсекает сторож членства в самом запросе.
func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	var cursor uuid.UUID
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			httpserver.WriteError(w, r, fmt.Errorf("%w: неверный курсор", domain.ErrValidation))
			return
		}
		cursor = id
	}
	var limit int32
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			httpserver.WriteError(w, r, fmt.Errorf("%w: неверный limit", domain.ErrValidation))
			return
		}
		limit = int32(n)
	}

	page, err := h.svc.Feed(r.Context(), u.ID, cursor, limit)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	items := make([]notificationResponse, len(page.Items))
	for i, it := range page.Items {
		items[i] = notificationResponse{
			ID: it.ID, WorkspaceID: it.WorkspaceID,
			WorkspaceName: it.WorkspaceName, WorkspaceSlug: it.WorkspaceSlug,
			Kind: string(it.Kind), Text: it.Text, Link: it.Link, Count: it.Count,
			FirstAt: it.FirstAt, LastAt: it.LastAt, Read: it.Read,
		}
	}
	resp := feedResponse{Items: items, Unread: page.Unread}
	if page.NextCursor != uuid.Nil {
		resp.NextCursor = page.NextCursor.String()
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

type readRequest struct {
	IDs []uuid.UUID `json:"ids"`
	All bool        `json:"all"`
}

// read отмечает прочитанным названное — либо всё. Чужие строки не трогаются
// (отбор по user_id в запросе), поэтому чужой id просто ничего не найдёт: 404
// на него означал бы «такая строка существует, но не ваша».
func (h *Handler) read(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxReadBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: тело запроса слишком велико", domain.ErrValidation))
		return
	}
	var req readRequest
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	if req.All && len(req.IDs) > 0 {
		httpserver.WriteError(w, r, fmt.Errorf("%w: либо ids, либо all", domain.ErrValidation))
		return
	}
	if req.All {
		err = h.svc.MarkAllRead(r.Context(), u.ID)
	} else {
		err = h.svc.MarkRead(r.Context(), u.ID, req.IDs)
	}
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// delete убирает одну строку ленты. Неразбираемый id и чужая строка отвечают
// одинаково — 204: строки у спрашивающего не стало (её и не было), а разные
// ответы рассказывали бы о чужих уведомлениях.
func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err := h.svc.Delete(r.Context(), u.ID, id); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteAll очищает ленту целиком — включая непрочитанное: это решение человека,
// а не уборка по возрасту.
func (h *Handler) deleteAll(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	if err := h.svc.DeleteAll(r.Context(), u.ID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
