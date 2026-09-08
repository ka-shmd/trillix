package templates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// maxBodyBytes — потолок тела запросов шаблонов. Тот же, что у форм, и по той же
// причине: тело админской ручки несёт документ формы целиком.
const maxBodyBytes = 64 << 10

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// composition root: templates не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// templatesService — интерфейс сервиса, нужный транспорту (реализация — *Service).
type templatesService interface {
	List(ctx context.Context, userID uuid.UUID, workspaceID *uuid.UUID) ([]Template, error)
	SaveFromForm(ctx context.Context, userID, formID uuid.UUID, title, description string) (Template, error)
	PublishSchema(ctx context.Context, userID uuid.UUID, title, description string, schema json.RawMessage) (Template, error)
	Use(ctx context.Context, userID, templateID uuid.UUID, workspaceID *uuid.UUID) (forms.Form, error)
	Delete(ctx context.Context, userID, templateID uuid.UUID) error
}

// Handler — HTTP-транспорт модуля templates. Все роуты приватные (за RequireAuth);
// мутации — ещё и за RequireCSRF, включая админскую: она такая же ручка кабинета,
// просто доступная одному человеку.
type Handler struct {
	svc         templatesService
	requireAuth Middleware
	requireCSRF Middleware
}

func NewHandler(svc templatesService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/templates", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/templates", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.saveFromForm))))
	mux.Handle("POST /api/v1/templates/{id}/use", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.use))))
	mux.Handle("DELETE /api/v1/templates/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.delete))))
	// Витрина сервиса пополняется отдельным путём, а не полем `visibility` в
	// обычной ручке: право на неё другой природы (администратор сервиса, а не
	// участник пространства), и смешивать их в одном обработчике значило бы
	// держать развилку прав внутри разбора тела.
	mux.Handle("POST /api/v1/admin/templates", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.publish))))
}

// templateResponse — шаблон глазами кабинета. Документ отдаётся ЦЕЛИКОМ и всем,
// кто шаблон видит: плитка галереи рисует не рассказ о форме, а саму форму — теми
// же кирпичами, что публичная страница.
type templateResponse struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
	// visibility — «мой» или «публичный»: по нему галерея раскладывает шаблоны по
	// вкладкам, и по нему же решает, показывать ли удаление.
	Visibility  string    `json:"visibility"`
	WorkspaceID *string   `json:"workspaceId"`
	CreatedAt   time.Time `json:"createdAt"`
}

// createdFormResponse — то, что нужно кабинету после создания формы из шаблона:
// куда перейти. Полная карточка формы здесь не нужна — её кабинет перечитает
// списком, как и после всякой мутации.
type createdFormResponse struct {
	ID    string `json:"id"`
	Slug  string `json:"slug"`
	Title string `json:"title"`
}

func toResponse(t Template) templateResponse {
	out := templateResponse{
		ID:          t.ID.String(),
		Title:       t.Title,
		Description: t.Description,
		Schema:      t.Schema,
		Visibility:  string(t.Visibility),
		CreatedAt:   t.CreatedAt,
	}
	if t.WorkspaceID != uuid.Nil {
		ws := t.WorkspaceID.String()
		out.WorkspaceID = &ws
	}
	return out
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	wsID, ok := parseWorkspaceQuery(w, r)
	if !ok {
		return
	}
	list, err := h.svc.List(r.Context(), userID, wsID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]templateResponse, len(list))
	for i, t := range list {
		out[i] = toResponse(t)
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string]any{"items": out})
}

// saveFromFormRequest — «сохранить как шаблон» из меню формы. Пустое название
// означает «как у формы», пустое описание — законное значение.
type saveFromFormRequest struct {
	FormID      string `json:"formId"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

func (h *Handler) saveFromForm(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	var req saveFromFormRequest
	if !decode(w, r, &req) {
		return
	}
	formID, err := uuid.Parse(req.FormID)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: formId не uuid", domain.ErrValidation))
		return
	}
	t, err := h.svc.SaveFromForm(r.Context(), userID, formID, req.Title, req.Description)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toResponse(t))
}

// publishRequest — тело админской ручки: документ приходит целиком, а не берётся
// из чьей-то формы (шаблон витрины не обязан иметь форму-прародителя).
type publishRequest struct {
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"schema"`
}

func (h *Handler) publish(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	var req publishRequest
	if !decode(w, r, &req) {
		return
	}
	t, err := h.svc.PublishSchema(r.Context(), userID, req.Title, req.Description, req.Schema)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toResponse(t))
}

// useRequest — в каком пространстве завести форму. Отсутствие поля законно и
// означает личное — то же правило, что у POST /forms.
type useRequest struct {
	WorkspaceID *string `json:"workspaceId"`
}

func (h *Handler) use(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	var req useRequest
	if !decode(w, r, &req) {
		return
	}
	wsID, ok := parseWorkspaceID(w, r, req.WorkspaceID)
	if !ok {
		return
	}
	form, err := h.svc.Use(r.Context(), userID, id, wsID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, createdFormResponse{
		ID: form.ID.String(), Slug: form.Slug, Title: form.Title,
	})
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	id, ok := parseID(w, r)
	if !ok {
		return
	}
	if err := h.svc.Delete(r.Context(), userID, id); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusNoContent, nil)
}

func userID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return uuid.Nil, false
	}
	return u.ID, true
}

// parseID разбирает {id}; неразбираемый uuid → 404 (несуществующий шаблон, без
// раскрытия чего-либо), а не 400 — то же правило, что у форм.
func parseID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return uuid.Nil, false
	}
	return id, true
}

func parseWorkspaceQuery(w http.ResponseWriter, r *http.Request) (*uuid.UUID, bool) {
	raw := r.URL.Query().Get("workspaceId")
	if raw == "" {
		return nil, true
	}
	return parseWorkspaceID(w, r, &raw)
}

// parseWorkspaceID: мусор вместо uuid — ошибка ввода, а не молчаливый откат к
// личному пространству (иначе опечатка в id показала бы чужую на вид галерею).
func parseWorkspaceID(w http.ResponseWriter, r *http.Request, raw *string) (*uuid.UUID, bool) {
	if raw == nil {
		return nil, true
	}
	id, err := uuid.Parse(*raw)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: workspaceId не uuid", domain.ErrValidation))
		return nil, false
	}
	return &id, true
}

// decode читает тело запроса. Размер отделён от формата: «неверное тело» на
// слишком большом теле называет не ту причину, и починить её нечем.
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, fmt.Errorf("%w: тело больше %d байт", domain.ErrTooLarge, maxBodyBytes))
			return false
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return false
	}
	return true
}
