package media

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// хендлер (тот же приём, что в forms).
type Middleware = func(http.Handler) http.Handler

// RateLimiter — ведро на загрузку по ссылке; ratelimit.TokenBucket его реализует.
type RateLimiter interface {
	Allow(key string) bool
}

// mediaService — потребляемый интерфейс сервиса (объявлен на стороне транспорта).
type mediaService interface {
	Upload(ctx context.Context, userID, formID uuid.UUID, data []byte, purpose Purpose) (string, error)
	UploadFromURL(ctx context.Context, userID, formID uuid.UUID, rawURL string, purpose Purpose) (string, error)
	Fetch(ctx context.Context, key string) (data []byte, contentType string, err error)
}

// Handler — HTTP-транспорт модуля media. Роут приватный (за RequireAuth+RequireCSRF).
type Handler struct {
	svc         mediaService
	requireAuth Middleware
	requireCSRF Middleware
	// urlLimiter — ведро на загрузку по ссылке: каждая — исходящий запрос к чужому
	// сайту с нашего IP длиной до safehttp.DefaultTimeout. Без ведра ручкой можно было
	// бы качать по списку адресов или стучать в чужой сервер.
	urlLimiter RateLimiter
}

// urlLimiter — ОБЯЗАТЕЛЬНЫЙ параметр, а не сеттер: «лимита нет» не должно
// получаться забытым вызовом (тесты передают ratelimit.AllowAll, инвариант 6).
func NewHandler(svc mediaService, requireAuth, requireCSRF Middleware, urlLimiter RateLimiter) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF, urlLimiter: urlLimiter}
}

// Routes регистрирует эндпоинты media на общем mux. Загрузка привязана к форме:
// доступ проверяется членством в её воркспейсе, ключ неймспейсится по нему.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/forms/{id}/media", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.upload))))
	// Раздача картинок ДЛЯ ПЕЧАТИ (ADR §10). Респондент сюда не ходит и ходить не
	// должен: ему те же байты отдаёт Caddy прямо из бакета, мимо Go. Единственный
	// читатель — браузер принтера, которому наш api заменяет весь мир, поэтому путь
	// лежит под /internal/, куда Caddy запросы снаружи не проксирует вовсе (на
	// кабинете — только /api/*, на рендерере — /r/* и /public/*).
	mux.Handle("GET /internal/print/media/{key...}", http.HandlerFunc(h.printMedia))
}

// printMediaMaxAge — сколько браузеру принтера держать картинку. Ключ содержит
// sha256 содержимого, то есть неизменяем: одна и та же ссылка навсегда означает одни
// и те же байты.
const printMediaMaxAge = "public, max-age=31536000, immutable"

// maxURLBodyBytes — потолок JSON-тела загрузки по ссылке (инвариант 3): адрес
// (safehttp.MaxURLLength) и назначение.
const maxURLBodyBytes = 4 << 10

// printMedia отдаёт картинку формы браузеру принтера. Прав не спрашивает — по тем же
// основаниям, что и Fetch: картинки формы публичны, и этот путь лишь заменяет
// принтеру недоступную ему раздачу Caddy.
func (h *Handler) printMedia(w http.ResponseWriter, r *http.Request) {
	data, contentType, err := h.svc.Fetch(r.Context(), r.PathValue("key"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", printMediaMaxAge)
	if _, err := w.Write(data); err != nil {
		httpserver.LoggerFrom(r.Context()).Warn("print media write failed", "error", err.Error())
	}
}

type uploadResponse struct {
	ImageKey string `json:"imageKey"`
}

// urlUploadRequest — загрузка по ссылке: тело JSON вместо multipart на том же адресе.
type urlUploadRequest struct {
	URL     string `json:"url"`
	Purpose string `json:"purpose"`
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

	// Вид загрузки различается типом тела: JSON — ссылка, остальное — файл.
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt == "application/json" {
		h.uploadFromURL(w, r, u.ID, formID)
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

func (h *Handler) uploadFromURL(w http.ResponseWriter, r *http.Request, userID, formID uuid.UUID) {
	// Ведро на человека, до разбора тела: отказ по лимиту не должен стоить работы.
	if !h.urlLimiter.Allow(userID.String()) {
		httpserver.WriteError(w, r, domain.ErrRateLimited)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxURLBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req urlUploadRequest
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, domain.ErrTooLarge)
			return
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: ожидается JSON с полем url", domain.ErrValidation))
		return
	}
	purpose, err := ParsePurpose(req.Purpose)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	key, err := h.svc.UploadFromURL(r.Context(), userID, formID, req.URL, purpose)
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
