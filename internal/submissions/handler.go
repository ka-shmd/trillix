package submissions

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/httpserver"
)

// Middleware — HTTP-обёртка (RequireAuth из auth), инжектируемая в composition root:
// submissions не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// listService — часть сервиса, нужная приватному транспорту (листинг + экспорт).
type listService interface {
	ListForForm(ctx context.Context, userID, formID uuid.UUID, after *Cursor, limit int) (Page, error)
	ExportCSV(ctx context.Context, userID, formID uuid.UUID, emit func(record []string) error) error
}

// utf8BOM — метка порядка байтов: Excel без неё принимает UTF-8 CSV за ANSI и
// ломает кириллицу. Пишется первой, до заголовка таблицы.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// csvFlushEvery — как часто сбрасывать буфер csv.Writer в сеть: ответ начинает
// течь клиенту, не дожидаясь всей выборки.
const csvFlushEvery = 500

// Handler — приватный транспорт модуля submissions: автор смотрит ответы своей формы.
// Только чтение (GET), поэтому за RequireAuth, но без CSRF.
type Handler struct {
	svc         listService
	requireAuth Middleware
}

func NewHandler(svc listService, requireAuth Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms/{id}/submissions", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("GET /api/v1/forms/{id}/submissions/export", h.requireAuth(http.HandlerFunc(h.export)))
}

// --- DTO ---

type submissionResponse struct {
	ID          string          `json:"id"`
	FormVersion int32           `json:"formVersion"`
	CreatedAt   time.Time       `json:"createdAt"`
	Answers     json.RawMessage `json:"answers"`
}

type listResponse struct {
	Submissions []submissionResponse `json:"submissions"`
	NextCursor  *string              `json:"nextCursor"`
	Total       int64                `json:"total"`
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	after, ok := parseCursor(w, r)
	if !ok {
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))

	page, err := h.svc.ListForForm(r.Context(), userID, formID, after, limit)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	items := make([]submissionResponse, len(page.Submissions))
	for i, s := range page.Submissions {
		items[i] = submissionResponse{
			ID:          s.ID.String(),
			FormVersion: s.FormVersion,
			CreatedAt:   s.CreatedAt,
			Answers:     s.Answers,
		}
	}
	resp := listResponse{Submissions: items, Total: page.Total}
	if page.NextCursor != nil {
		enc := encodeCursor(*page.NextCursor)
		resp.NextCursor = &enc
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

// export стримит все ответы формы в CSV (браузерное скачивание, cookie авторизует).
// Заголовки и статус 200 пишутся ЛЕНИВО — на первой строке (заголовке таблицы):
// пока не пошёл body, ошибка авторизации из сервиса (чужая/нет формы) ещё может
// стать 404 через WriteError. После начала стрима статус не поменять — ошибку
// (обрыв записи, отмена ctx) только логируем на самом верху.
func (h *Handler) export(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}

	var (
		cw      *csv.Writer
		started bool
		written int
	)
	emit := func(record []string) error {
		if !started {
			started = true
			w.Header().Set("Content-Type", "text/csv; charset=utf-8")
			w.Header().Set("Content-Disposition", csvContentDisposition(formID))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(utf8BOM)
			cw = csv.NewWriter(w)
		}
		if err := cw.Write(record); err != nil {
			return err
		}
		if written++; written%csvFlushEvery == 0 {
			cw.Flush()
			return cw.Error()
		}
		return nil
	}

	err := h.svc.ExportCSV(r.Context(), userID, formID, emit)
	if !started {
		// Тело ещё не начато → ошибка маппится на статус (404/…). Сюда попадаем только
		// при ошибке авторизации: успешный экспорт всегда эмитит заголовок таблицы.
		httpserver.WriteError(w, r, err)
		return
	}
	cw.Flush()
	if err == nil {
		err = cw.Error()
	}
	if err != nil {
		// Стрим уже начат (200 отправлен) — статус не изменить. Логируем на самом верху.
		httpserver.LoggerFrom(r.Context()).Error("csv export interrupted",
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
	}
}

// csvContentDisposition — имя скачиваемого файла. ASCII-фолбэк + RFC 5987 filename*
// (на случай нелатинских частей в будущем); сейчас имя из id формы — уже ASCII.
func csvContentDisposition(formID uuid.UUID) string {
	name := "submissions-" + formID.String() + ".csv"
	return fmt.Sprintf("attachment; filename=%q", name)
}

// --- Разбор запроса ---

// currentUserID достаёт пользователя, положенного RequireAuth. Отсутствие — 401
// (защита от неверной сборки цепочки middleware).
func currentUserID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
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

// Курсор ответов — одна колонка (id): кодируем uuid в непрозрачную base64url-строку.
func encodeCursor(c Cursor) string {
	return base64.RawURLEncoding.EncodeToString([]byte(c.ID.String()))
}

func decodeCursor(s string) (*Cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(string(raw))
	if err != nil {
		return nil, fmt.Errorf("cursor: parse id: %w", err)
	}
	return &Cursor{ID: id}, nil
}
