package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// хендлер (тот же приём, что в forms).
type Middleware = func(http.Handler) http.Handler

// mediaService — потребляемый интерфейс сервиса (объявлен на стороне транспорта).
type mediaService interface {
	Upload(ctx context.Context, userID, formID uuid.UUID, data []byte, purpose Purpose) (string, error)
}

// Handler — HTTP-транспорт модуля media. Роут приватный (за RequireAuth+RequireCSRF).
type Handler struct {
	svc         mediaService
	requireAuth Middleware
	requireCSRF Middleware
}

func NewHandler(svc mediaService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

// Routes регистрирует эндпоинты media на общем mux. Загрузка привязана к форме:
// доступ проверяется членством в её воркспейсе, ключ неймспейсится по нему.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/forms/{id}/media", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.upload))))
}

type uploadResponse struct {
	ImageKey string `json:"imageKey"`
}

func (h *Handler) upload(w http.ResponseWriter, r *http.Request) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Неразбираемый id → 404 (несуществующая форма, без раскрытия), а не 400.
	formID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}

	// Потолок тела (инвариант 3): превышение → 413 через ErrTooLarge.
	r.Body = http.MaxBytesReader(w, r.Body, MaxImageBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		httpserver.WriteError(w, r, uploadInputError(err))
		return
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(file)
	if err != nil {
		httpserver.WriteError(w, r, uploadInputError(err))
		return
	}

	// Назначение — поле той же формы. Читается ПОСЛЕ FormFile: это он разбирает
	// multipart, до него формы ещё нет. Отсутствие поля = картинка блока (так
	// выглядят загрузки, которые про параметр не знают).
	purpose, err := ParsePurpose(r.FormValue("purpose"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	key, err := h.svc.Upload(r.Context(), u.ID, formID, data, purpose)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, uploadResponse{ImageKey: key})
}

// uploadInputError переводит ошибку чтения тела в доменную: превышение лимита —
// ErrTooLarge (413), прочее (нет поля file, битый multipart) — ErrValidation (422).
func uploadInputError(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return domain.ErrTooLarge
	}
	return fmt.Errorf("%w: ожидается multipart-поле file с картинкой", domain.ErrValidation)
}
