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

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// maxFormBodyBytes — потолок тела запросов forms. 64 КБ: title крошечный, но
// PATCH автосейва несёт весь draft_schema (до ~200 блоков). Внутренние лимиты
// документа стережёт ValidateSchema; MaxBytesReader — грубый внешний предел.
const maxFormBodyBytes = 64 << 10

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// composition root: forms не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// formsService — интерфейс сервиса, нужный транспорту (реализация — *Service).
type formsService interface {
	Create(ctx context.Context, userID uuid.UUID, title string) (Form, error)
	Duplicate(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	List(ctx context.Context, userID uuid.UUID, opts ListOptions) (Page, error)
	Get(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	GetBySlug(ctx context.Context, userID uuid.UUID, slug string) (Form, error)
	UpdateTitle(ctx context.Context, userID, formID uuid.UUID, title string) (Form, error)
	UpdateName(ctx context.Context, userID, formID uuid.UUID, name string) (Form, error)
	UpdateCloseSettings(ctx context.Context, userID, formID uuid.UUID, settings domain.CloseSettings) (Form, error)
	UpdateDraftSchema(ctx context.Context, userID, formID uuid.UUID, rawSchema json.RawMessage, expectedUpdatedAt time.Time) (Form, error)
	Delete(ctx context.Context, userID, formID uuid.UUID) error
	Publish(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	Unpublish(ctx context.Context, userID, formID uuid.UUID) (Form, error)
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
	// Резолв формы по slug (кабинет адресует форму slug'ом в URL редактора/ответов/
	// шаринга, как рендерер — /r/{slug}). slug — в query, а не в пути: путь
	// /forms/by-slug/{slug} конфликтовал бы в net/http-mux с /forms/{id}/submissions
	// (оба матчат /forms/by-slug/submissions, ни один не специфичнее). Литеральный
	// сегмент /forms/lookup специфичнее /forms/{id} — коллизии нет.
	mux.Handle("GET /api/v1/forms/lookup", h.requireAuth(http.HandlerFunc(h.getBySlug)))
	mux.Handle("PATCH /api/v1/forms/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.update))))
	mux.Handle("DELETE /api/v1/forms/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.delete))))
	mux.Handle("POST /api/v1/forms/{id}/duplicate", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.duplicate))))
	mux.Handle("POST /api/v1/forms/{id}/publish", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.publish))))
	mux.Handle("POST /api/v1/forms/{id}/unpublish", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.unpublish))))
}

// --- DTO ---

type formResponse struct {
	ID string `json:"id"`
	// name — внутреннее имя для дашборда (null = не задано, кабинет показывает title).
	// title — публичный заголовок (его видит респондент). См. ADR §10.
	Name      *string   `json:"name"`
	Title     string    `json:"title"`
	Slug      string    `json:"slug"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// publishedVersion/publishedVersionId — текущая опубликованная версия (null,
	// пока форму не публиковали; после закрытия сохраняются — «была версия N»).
	PublishedVersion   *int32  `json:"publishedVersion"`
	PublishedVersionID *string `json:"publishedVersionId"`
	// hasUnpublishedChanges — черновик отличается от опубликованной версии (бейдж
	// «есть неопубликованные изменения»). Точен на GET/список; у ответов мутаций
	// всегда false (см. Form.HasUnpublishedChanges).
	HasUnpublishedChanges bool `json:"hasUnpublishedChanges"`
	// submissionCount — число ответов формы (счётчик на карточке). Точен на
	// GET/список; у ответов мутаций всегда 0.
	SubmissionCount int64 `json:"submissionCount"`
	// visitCount / visitSubmittedCount — просмотры формы и сколько из них
	// закончились ответом (фаза 8.5 шаг 6). Конверсию считает фронт по этой паре;
	// делить submissionCount на visitCount нельзя — это разные множества (ADR §10).
	// Точны на GET/список; у ответов мутаций всегда 0.
	VisitCount          int64 `json:"visitCount"`
	VisitSubmittedCount int64 `json:"visitSubmittedCount"`
}

// formDetailResponse — GET /forms/{id}: метаданные + черновик схемы + живые
// настройки закрытия (страница настроек кабинета их читает; фаза 8.5 шаг 4).
type formDetailResponse struct {
	formResponse
	DraftSchema json.RawMessage `json:"draftSchema"`
	// null/пусто = ограничение не задано. Только в детали формы (не в списке/мутациях).
	CloseAt       *time.Time `json:"closeAt"`
	ResponseLimit *int32     `json:"responseLimit"`
	ClosedMessage *string    `json:"closedMessage"`
}

// closeSettingsBody — фасет closeSettings в PATCH: полный набор настроек закрытия
// (отсутствующее поле = снято). Замена всех трёх колонок разом, не частичный патч.
type closeSettingsBody struct {
	CloseAt       *time.Time `json:"closeAt"`
	ResponseLimit *int32     `json:"responseLimit"`
	ClosedMessage string     `json:"closedMessage"`
}

type listResponse struct {
	Forms      []formResponse `json:"forms"`
	NextCursor *string        `json:"nextCursor"`
}

type titleRequest struct {
	Title string `json:"title"`
}

// patchRequest — тело PATCH /forms/{id}. Указатели различают «поле отсутствует»
// (nil) от «прислано». За один запрос меняется ровно одно из
// name/title/draftSchema/closeSettings: name — переименование с дашборда (внутреннее
// имя, не трогает публичный заголовок); title — публичный заголовок (первая строка
// билдера, без блокировки); draftSchema — автосейв билдера, требует updatedAt для
// оптимистичной блокировки; closeSettings — настройки закрытия (страница настроек).
type patchRequest struct {
	Name          *string            `json:"name"`
	Title         *string            `json:"title"`
	DraftSchema   *json.RawMessage   `json:"draftSchema"`
	UpdatedAt     *time.Time         `json:"updatedAt"`
	CloseSettings *closeSettingsBody `json:"closeSettings"`
}

func toFormResponse(f Form) formResponse {
	resp := formResponse{
		ID:                    f.ID.String(),
		Name:                  f.Name,
		Title:                 f.Title,
		Slug:                  f.Slug,
		Status:                f.Status,
		CreatedAt:             f.CreatedAt,
		UpdatedAt:             f.UpdatedAt,
		PublishedVersion:      f.PublishedVersion,
		HasUnpublishedChanges: f.HasUnpublishedChanges,
		SubmissionCount:       f.SubmissionCount,
		VisitCount:            f.VisitCount,
		VisitSubmittedCount:   f.VisitSubmittedCount,
	}
	if f.PublishedVersionID != nil {
		id := f.PublishedVersionID.String()
		resp.PublishedVersionID = &id
	}
	return resp
}

// toFormDetailResponse — деталь формы (GET /forms/{id} и /forms/lookup): метаданные,
// черновик схемы и живые настройки закрытия (их читает страница настроек кабинета).
func toFormDetailResponse(f Form) formDetailResponse {
	// Редактор кабинета знает только текущий формат — старый черновик апгрейдится
	// до v2 на отдаче. Ошибка невозможна на валидных данных БД; на всякий случай
	// отдаём сырьё, а не пустоту (лучше отладить, чем потерять черновик).
	schema := f.DraftSchema
	if up, err := domain.CanonicalV2(schema); err == nil {
		schema = up
	}
	return formDetailResponse{
		formResponse:  toFormResponse(f),
		DraftSchema:   schema,
		CloseAt:       f.CloseAt,
		ResponseLimit: f.ResponseLimit,
		ClosedMessage: f.ClosedMessage,
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
	sort, err := ParseSortOrder(r.URL.Query().Get("sort"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))

	page, err := h.svc.List(r.Context(), userID, ListOptions{
		Search: r.URL.Query().Get("q"),
		Sort:   sort,
		After:  after,
		Limit:  limit,
	})
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
	httpserver.WriteJSON(w, r, http.StatusOK, toFormDetailResponse(form))
}

// getBySlug — тот же ответ, что get, но форма адресована slug'ом (query-параметр
// ?slug=). Пустой slug трактуем как 404, а не 500.
func (h *Handler) getBySlug(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	slug := r.URL.Query().Get("slug")
	if slug == "" {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	form, err := h.svc.GetBySlug(r.Context(), userID, slug)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toFormDetailResponse(form))
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
	req, ok := decodePatch(w, r)
	if !ok {
		return
	}

	// Ровно одно из name/title/draftSchema/closeSettings за запрос — иначе непонятно,
	// что менять.
	set := 0
	for _, present := range []bool{req.Name != nil, req.Title != nil, req.DraftSchema != nil, req.CloseSettings != nil} {
		if present {
			set++
		}
	}
	if set != 1 {
		httpserver.WriteError(w, r, fmt.Errorf("%w: за один запрос меняется ровно одно из name/title/draftSchema/closeSettings", domain.ErrValidation))
		return
	}

	var (
		form Form
		err  error
	)
	switch {
	case req.DraftSchema != nil:
		if req.UpdatedAt == nil {
			httpserver.WriteError(w, r, fmt.Errorf("%w: updatedAt обязателен при сохранении схемы", domain.ErrValidation))
			return
		}
		form, err = h.svc.UpdateDraftSchema(r.Context(), userID, formID, *req.DraftSchema, *req.UpdatedAt)
	case req.Title != nil:
		form, err = h.svc.UpdateTitle(r.Context(), userID, formID, *req.Title)
	case req.Name != nil:
		form, err = h.svc.UpdateName(r.Context(), userID, formID, *req.Name)
	case req.CloseSettings != nil:
		cs := *req.CloseSettings
		form, err = h.svc.UpdateCloseSettings(r.Context(), userID, formID, domain.CloseSettings{
			CloseAt:       cs.CloseAt,
			ResponseLimit: cs.ResponseLimit,
			ClosedMessage: cs.ClosedMessage,
		})
	}
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

// publish снимает снапшот черновика в новую версию и публикует форму. Тела нет.
func (h *Handler) publish(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Publish(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toFormResponse(form))
}

func (h *Handler) duplicate(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Duplicate(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toFormResponse(form))
}

// unpublish закрывает форму (status='closed'). Тела нет.
func (h *Handler) unpublish(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Unpublish(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toFormResponse(form))
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

// decodePatch читает тело PATCH (title и/или draftSchema + updatedAt). Пустое
// тело недопустимо (в отличие от создания) — обработчик сам решит, чего не хватает.
func decodePatch(w http.ResponseWriter, r *http.Request) (patchRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req patchRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return patchRequest{}, false
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
	raw := fmt.Sprintf("%d:%s:%s", c.SortKey, c.ID.String(), c.Sort)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(s string) (*Cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	keyStr, rest, ok := strings.Cut(string(raw), ":")
	if !ok {
		return nil, errors.New("cursor: missing separator")
	}
	key, err := strconv.ParseInt(keyStr, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("cursor: parse sort key: %w", err)
	}
	// Третья часть (порядок) появилась в фазе 8.5 шаг 8. Курсор без неё — выданный
	// прежней версией и уже открытой у кого-то страницей: читаем как сортировку по
	// умолчанию, а не роняем листание в 422 из-за момента выкатки.
	idStr, sortStr, hasSort := strings.Cut(rest, ":")
	id, err := uuid.Parse(idStr)
	if err != nil {
		return nil, fmt.Errorf("cursor: parse id: %w", err)
	}
	sort := SortUpdated
	if hasSort {
		if sort, err = ParseSortOrder(sortStr); err != nil {
			return nil, fmt.Errorf("cursor: %w", err)
		}
	}
	return &Cursor{SortKey: key, ID: id, Sort: sort}, nil
}
