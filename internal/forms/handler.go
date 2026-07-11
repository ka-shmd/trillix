package forms

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/httpserver"
)

const maxFormBodyBytes = 4 << 10 // 4 КБ — тело содержит лишь title

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// composition root: forms не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// formsService — интерфейс сервиса, нужный транспорту (реализация — *Service).
type formsService interface {
	Create(ctx context.Context, userID uuid.UUID, title string) (Form, error)
	List(ctx context.Context, userID uuid.UUID, after *Cursor, limit int) (Page, error)
	Get(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	UpdateTitle(ctx context.Context, userID, formID uuid.UUID, title string) (Form, error)
	Delete(ctx context.Context, userID, formID uuid.UUID) error
}

// Handler — HTTP-транспорт модуля forms. Все роуты приватные (за RequireAuth);
// мутации — ещё и за RequireCSRF.
type Handler struct {
	svc         formsService
	requireAuth Middleware
	requireCSRF Middleware
}

func NewHandler(svc formsService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

// Routes регистрирует эндпоинты forms на общем mux.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/forms", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.create))))
	mux.Handle("GET /api/v1/forms/{id}", h.requireAuth(http.HandlerFunc(h.get)))
	mux.Handle("PATCH /api/v1/forms/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.update))))
	mux.Handle("DELETE /api/v1/forms/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.delete))))
}

// --- DTO ---

type formResponse struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Slug      string    `json:"slug"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// formDetailResponse — GET /forms/{id}: метаданные + черновик схемы.
type formDetailResponse struct {
	formResponse
	DraftSchema json.RawMessage `json:"draftSchema"`
}

type listResponse struct {
	Forms      []formResponse `json:"forms"`
	NextCursor *string        `json:"nextCursor"`
}

type titleRequest struct {
	Title string `json:"title"`
}

func toFormResponse(f Form) formResponse {
	return formResponse{
		ID:        f.ID.String(),
		Title:     f.Title,
		Slug:      f.Slug,
		Status:    f.Status,
		CreatedAt: f.CreatedAt,
		UpdatedAt: f.UpdatedAt,
	}
}

// --- Handlers ---

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}

	after, ok := parseCursor(w, r)
	if !ok {
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))

	page, err := h.svc.List(r.Context(), userID, after, limit)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	forms := make([]formResponse, len(page.Forms))
	for i, f := range page.Forms {
		forms[i] = toFormResponse(f)
	}
	resp := listResponse{Forms: forms}
	if page.NextCursor != nil {
		enc := encodeCursor(*page.NextCursor)
		resp.NextCursor = &enc
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	req, ok := decodeTitle(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Create(r.Context(), userID, req.Title)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toFormResponse(form))
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Get(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, formDetailResponse{
		formResponse: toFormResponse(form),
		DraftSchema:  form.DraftSchema,
	})
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	req, ok := decodeTitle(w, r)
	if !ok {
		return
	}
	form, err := h.svc.UpdateTitle(r.Context(), userID, formID, req.Title)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toFormResponse(form))
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	if err := h.svc.Delete(r.Context(), userID, formID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- Разбор запроса ---

// userID достаёт пользователя, положенного RequireAuth. Отсутствие — 401
// (защита от неверной сборки цепочки middleware).
func userID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return uuid.Nil, false
	}
	return u.ID, true
}

// parseFormID разбирает {id}; неразбираемый uuid → 404 (несуществующая форма,
// без раскрытия чего-либо), а не 400.
func parseFormID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return uuid.Nil, false
	}
	return id, true
}

// decodeTitle читает необязательное тело {title}. Пустое тело допустимо (создание
// формы без названия → дефолт на сервисе).
func decodeTitle(w http.ResponseWriter, r *http.Request) (titleRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: тело запроса слишком велико", domain.ErrValidation))
		return titleRequest{}, false
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return titleRequest{}, true
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	var req titleRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return titleRequest{}, false
	}
	return req, true
}

func parseLimit(raw string) int {
	if raw == "" {
		return 0 // сервис подставит DefaultPageLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return n
}

// parseCursor разбирает непрозрачный ?cursor. Отсутствует → первая страница;
// присутствует, но битый → 422 (клиент передал испорченный курсор).
func parseCursor(w http.ResponseWriter, r *http.Request) (*Cursor, bool) {
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		return nil, true
	}
	c, err := decodeCursor(raw)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный курсор", domain.ErrValidation))
		return nil, false
	}
	return c, true
}

// Курсор кодируется в непрозрачную для клиента строку "unixNano:uuid" (base64url).
func encodeCursor(c Cursor) string {
	raw := fmt.Sprintf("%d:%s", c.UpdatedAt.UnixNano(), c.ID.String())
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(s string) (*Cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	nanoStr, idStr, ok := strings.Cut(string(raw), ":")
	if !ok {
		return nil, errors.New("cursor: missing separator")
	}
	nano, err := strconv.ParseInt(nanoStr, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("cursor: parse time: %w", err)
	}
	id, err := uuid.Parse(idStr)
	if err != nil {
		return nil, fmt.Errorf("cursor: parse id: %w", err)
	}
	return &Cursor{UpdatedAt: time.Unix(0, nano).UTC(), ID: id}, nil
}
