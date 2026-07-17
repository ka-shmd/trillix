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

// listService — часть сервиса, нужная приватному транспорту (листинг + экспорт +
// сводка + удаление).
type listService interface {
	ListForForm(ctx context.Context, userID, formID uuid.UUID, after *Cursor, limit int) (Page, error)
	ExportCSV(ctx context.Context, userID, formID uuid.UUID, emit func(record []string) error) error
	Summary(ctx context.Context, userID, formID uuid.UUID) (domain.Summary, error)
	DeleteForForm(ctx context.Context, userID, formID, submissionID uuid.UUID) error
}

// utf8BOM — метка порядка байтов: Excel без неё принимает UTF-8 CSV за ANSI и
// ломает кириллицу. Пишется первой, до заголовка таблицы.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// csvFlushEvery — как часто сбрасывать буфер csv.Writer в сеть: ответ начинает
// течь клиенту, не дожидаясь всей выборки.
const csvFlushEvery = 500

// exportWriteChunkTimeout — потолок времени на отправку одного чанка экспорта.
// Дедлайн записи продлевается на каждом флаше (см. export), поэтому длинный, но
// прогрессирующий трансфер не рвётся, а полностью зависший клиент отваливается
// через этот таймаут. Переопределяет общий WriteTimeout сервера (10 с) для этого
// стрима — иначе большой экспорт на медленном канале обрубается на середине (TD-4).
const exportWriteChunkTimeout = 30 * time.Second

// Handler — приватный транспорт модуля submissions: автор смотрит и удаляет ответы
// своей формы. Чтение (GET) — за RequireAuth; удаление (DELETE) — ещё и за RequireCSRF.
type Handler struct {
	svc         listService
	requireAuth Middleware
	requireCSRF Middleware
}

func NewHandler(svc listService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms/{id}/submissions", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("GET /api/v1/forms/{id}/submissions/export", h.requireAuth(http.HandlerFunc(h.export)))
	mux.Handle("GET /api/v1/forms/{id}/submissions/summary", h.requireAuth(http.HandlerFunc(h.summary)))
	mux.Handle("DELETE /api/v1/forms/{id}/submissions/{sid}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.delete))))
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

// Сводка. kind — по нему фронт выбирает вид: distribution → buckets, number →
// number, fill → только asked/answered. buckets/number приходят лишь там, где
// осмысленны (omitempty), Zod-схема кабинета это допускает.
type summaryBucketResponse struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

type numberStatsResponse struct {
	Avg float64 `json:"avg"`
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

type blockSummaryResponse struct {
	BlockID  string                  `json:"blockId"`
	Label    string                  `json:"label"`
	Type     string                  `json:"type"`
	Kind     string                  `json:"kind"`
	Asked    int                     `json:"asked"`
	Answered int                     `json:"answered"`
	Buckets  []summaryBucketResponse `json:"buckets,omitempty"`
	Number   *numberStatsResponse    `json:"number,omitempty"`
}

type summaryResponse struct {
	Total  int                    `json:"total"`
	Blocks []blockSummaryResponse `json:"blocks"`
}

// summary отдаёт агрегат по ответам формы: наружу уходят только счётчики, сырые
// ответы браузер не получает.
//
// Логирует строку «сколько ответов свернули и за сколько». Длительность запроса пишет
// и общий middleware, но без знаменателя она бесполезна: 900 мс на 300 ответах и на
// 30 000 — разные новости. Это третий слой наблюдаемости из ARCHITECTURE §«Мониторинг»
// (счётчики в лог, а не Prometheus на одном VPS); содержимое ответов в лог не идёт.
func (h *Handler) summary(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}

	start := time.Now()
	sum, err := h.svc.Summary(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.LoggerFrom(r.Context()).Info("submissions summary",
		slog.String("form_id", formID.String()),
		slog.Int("submissions", sum.Total),
		slog.Int("questions", len(sum.Blocks)),
		slog.Duration("duration", time.Since(start)),
	)

	blocks := make([]blockSummaryResponse, len(sum.Blocks))
	for i, b := range sum.Blocks {
		item := blockSummaryResponse{
			BlockID:  b.BlockID,
			Label:    b.Label,
			Type:     string(b.Type),
			Kind:     string(b.Kind),
			Asked:    b.Asked,
			Answered: b.Answered,
		}
		if len(b.Buckets) > 0 {
			item.Buckets = make([]summaryBucketResponse, len(b.Buckets))
			for j, bk := range b.Buckets {
				item.Buckets[j] = summaryBucketResponse{Key: bk.Key, Label: bk.Label, Count: bk.Count}
			}
		}
		if b.Number != nil {
			item.Number = &numberStatsResponse{Avg: b.Number.Avg, Min: b.Number.Min, Max: b.Number.Max}
		}
		blocks[i] = item
	}
	httpserver.WriteJSON(w, r, http.StatusOK, summaryResponse{Total: sum.Total, Blocks: blocks})
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

	// rc продлевает write-дедлайн соединения между чанками: общий WriteTimeout
	// сервера (10 с) обрубил бы длинный экспорт, а тут дедлайн обновляется на каждом
	// флаше (TD-4). Доходит до соединения через statusWriter.Unwrap.
	rc := http.NewResponseController(w)
	deadlineErrLogged := false
	extendWriteDeadline := func() {
		if err := rc.SetWriteDeadline(time.Now().Add(exportWriteChunkTimeout)); err != nil && !deadlineErrLogged {
			deadlineErrLogged = true
			httpserver.LoggerFrom(r.Context()).Warn("csv export: cannot extend write deadline",
				slog.String("form_id", formID.String()), slog.String("error", err.Error()))
		}
	}

	var (
		cw      *csv.Writer
		started bool
		written int
	)
	emit := func(record []string) error {
		if !started {
			started = true
			extendWriteDeadline()
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
			if err := cw.Error(); err != nil {
				return err
			}
			extendWriteDeadline()
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

// delete удаляет один ответ формы (GDPR-гигиена). За RequireAuth+RequireCSRF.
func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	userID, ok := currentUserID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	subID, err := uuid.Parse(r.PathValue("sid"))
	if err != nil {
		// Неразбираемый id → 404 (несуществующий ответ), без раскрытия чего-либо.
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	if err := h.svc.DeleteForForm(r.Context(), userID, formID, subID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
