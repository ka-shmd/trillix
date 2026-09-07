package booking

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// maxBodyBytes — потолок тела (инвариант 3: MaxBytesReader на каждом эндпоинте с
// телом). В расписании — правило на семь дней с исключениями: килобайты, не мегабайты.
const maxBodyBytes = 64 << 10

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// хендлер: тот же приём, что в forms и integrations.
type Middleware = func(http.Handler) http.Handler

// bookingService — то, что транспорту нужно от сервиса.
type bookingService interface {
	List(ctx context.Context, userID, workspaceID uuid.UUID) ([]ScheduleListItem, error)
	Create(ctx context.Context, userID, workspaceID uuid.UUID, in ScheduleInput) (Schedule, error)
	Get(ctx context.Context, userID, scheduleID uuid.UUID) (Schedule, error)
	Update(ctx context.Context, userID, scheduleID uuid.UUID, in ScheduleInput) (Schedule, error)
	Delete(ctx context.Context, userID, scheduleID uuid.UUID) error
	Blocks(ctx context.Context, userID, scheduleID uuid.UUID) ([]Block, error)
	AddBlock(ctx context.Context, userID, scheduleID uuid.UUID, startsAt, endsAt time.Time, note string) (Block, error)
	RemoveBlock(ctx context.Context, userID, scheduleID, blockID uuid.UUID) error
	Upcoming(ctx context.Context, userID, scheduleID uuid.UUID) ([]Booking, error)
	Calendar(ctx context.Context, userID, scheduleID uuid.UUID, from, to time.Time) (Calendar, error)
	CancelBooking(ctx context.Context, userID, scheduleID, bookingID uuid.UUID) error
	MoveBooking(ctx context.Context, userID, scheduleID, bookingID uuid.UUID, startsAt time.Time) error
}

// Handler — приватный транспорт расписаний.
type Handler struct {
	svc         bookingService
	requireAuth Middleware
	requireCSRF Middleware
}

func NewHandler(svc bookingService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

// Routes регистрирует приватные эндпоинты.
//
// Два семейства адресов. Расписание принадлежит ПРОСТРАНСТВУ, поэтому список и
// заведение живут под ним; всё остальное адресуется id самого расписания —
// пространство сервер резолвит сам, и упоминать его второй раз значило бы дать
// клиенту возможность назвать не то.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/workspaces/{id}/schedules",
		h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/workspaces/{id}/schedules",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.create))))

	mux.Handle("GET /api/v1/schedules/{id}",
		h.requireAuth(http.HandlerFunc(h.get)))
	mux.Handle("PATCH /api/v1/schedules/{id}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.update))))
	mux.Handle("DELETE /api/v1/schedules/{id}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.remove))))

	mux.Handle("GET /api/v1/schedules/{id}/calendar",
		h.requireAuth(http.HandlerFunc(h.calendar)))

	mux.Handle("GET /api/v1/schedules/{id}/blocks",
		h.requireAuth(http.HandlerFunc(h.blocks)))
	mux.Handle("POST /api/v1/schedules/{id}/blocks",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.addBlock))))
	mux.Handle("DELETE /api/v1/schedules/{id}/blocks/{blockId}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.removeBlock))))

	mux.Handle("GET /api/v1/schedules/{id}/bookings",
		h.requireAuth(http.HandlerFunc(h.upcoming)))
	mux.Handle("POST /api/v1/schedules/{id}/bookings/{bookingId}/cancel",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.cancelBooking))))
	mux.Handle("POST /api/v1/schedules/{id}/bookings/{bookingId}/move",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.moveBooking))))
}

// scheduleView — расписание на проводе. Отдельный тип, а не доменный: у транспорта
// свои имена полей и свой формат времени, и связывать их с расчётом незачем.
type scheduleView struct {
	ID                 string              `json:"id"`
	WorkspaceID        string              `json:"workspaceId"`
	Name               string              `json:"name"`
	Timezone           string              `json:"timezone"`
	Availability       domain.Availability `json:"availability"`
	SlotMinutes        int                 `json:"slotMinutes"`
	BufferMinutes      int                 `json:"bufferMinutes"`
	HorizonDays        int                 `json:"horizonDays"`
	LeadMinutes        int                 `json:"leadMinutes"`
	Capacity           int                 `json:"capacity"`
	MaxSeatsPerBooking int                 `json:"maxSeatsPerBooking"`
	ShowRemaining      bool                `json:"showRemaining"`
	CreatedAt          time.Time           `json:"createdAt"`
	UpdatedAt          time.Time           `json:"updatedAt"`
}

func toScheduleView(s Schedule) scheduleView {
	a := s.Availability
	// Пустые карта и срез уезжают как {} и [], а не как null: клиенту не нужно
	// различать «правила нет» и «правило пустое» — их и не различает домен.
	if a.Weekly == nil {
		a.Weekly = map[string][]domain.Window{}
	}
	if a.Exceptions == nil {
		a.Exceptions = []domain.ScheduleException{}
	}
	return scheduleView{
		ID:                 s.ID.String(),
		WorkspaceID:        s.WorkspaceID.String(),
		Name:               s.Name,
		Timezone:           s.Timezone,
		Availability:       a,
		SlotMinutes:        s.SlotMinutes,
		BufferMinutes:      s.BufferMinutes,
		HorizonDays:        s.HorizonDays,
		LeadMinutes:        s.LeadMinutes,
		Capacity:           s.Capacity,
		MaxSeatsPerBooking: s.MaxSeatsPerBooking,
		ShowRemaining:      s.ShowRemaining,
		CreatedAt:          s.CreatedAt,
		UpdatedAt:          s.UpdatedAt,
	}
}

// scheduleListView — расписание В СПИСКЕ: карточка целиком плюс три числа, которых
// в самом расписании нет. Встраиванием, а не копией полей: карточка и строка списка
// обязаны называть одни и те же настройки одинаково.
//
// NextBookingAt — указатель: null значит «впереди пусто», и от «полночь 1 января»
// это отличать обязательно.
type scheduleListView struct {
	scheduleView
	FormsCount    int        `json:"formsCount"`
	UpcomingCount int        `json:"upcomingCount"`
	NextBookingAt *time.Time `json:"nextBookingAt"`
}

func toScheduleListView(it ScheduleListItem) scheduleListView {
	return scheduleListView{
		scheduleView:  toScheduleView(it.Schedule),
		FormsCount:    it.FormsCount,
		UpcomingCount: it.UpcomingCount,
		NextBookingAt: it.NextBookingAt,
	}
}

type blockView struct {
	ID       string    `json:"id"`
	StartsAt time.Time `json:"startsAt"`
	EndsAt   time.Time `json:"endsAt"`
	Note     string    `json:"note"`
}

type bookingView struct {
	ID              string    `json:"id"`
	FormID          string    `json:"formId"`
	FormTitle       string    `json:"formTitle"`
	FormSlug        string    `json:"formSlug"`
	StartsAt        time.Time `json:"startsAt"`
	DurationMinutes int       `json:"durationMinutes"`
	Seats           int       `json:"seats"`
	// SubmissionID — ссылка на ответ формы, из которого пришла запись. Пусто, если
	// ответ удалили: бронь его переживает (0050, ON DELETE SET NULL).
	SubmissionID *string `json:"submissionId"`
}

func toBookingView(b Booking) bookingView {
	v := bookingView{
		ID:              b.ID.String(),
		FormID:          b.FormID.String(),
		FormTitle:       b.FormTitle,
		FormSlug:        b.FormSlug,
		StartsAt:        b.StartsAt,
		DurationMinutes: b.DurationMinutes,
		Seats:           b.Seats,
	}
	if b.SubmissionID != nil {
		id := b.SubmissionID.String()
		v.SubmissionID = &id
	}
	return v
}

// scheduleRequest — тело заведения и правки. Указатели у необязательных полей не
// нужны: экран сохраняет настройки целиком, частичных патчей у расписания нет.
type scheduleRequest struct {
	Name               string              `json:"name"`
	Timezone           string              `json:"timezone"`
	Availability       domain.Availability `json:"availability"`
	SlotMinutes        int                 `json:"slotMinutes"`
	BufferMinutes      int                 `json:"bufferMinutes"`
	HorizonDays        int                 `json:"horizonDays"`
	LeadMinutes        int                 `json:"leadMinutes"`
	Capacity           int                 `json:"capacity"`
	MaxSeatsPerBooking int                 `json:"maxSeatsPerBooking"`
	ShowRemaining      bool                `json:"showRemaining"`
}

// input — тело в вход сервиса. Приведением, а не переписыванием полей: наборы
// совпадают, и расхождение обязано ломать сборку, а не молча терять настройку.
func (req scheduleRequest) input() ScheduleInput {
	return ScheduleInput(req)
}

type blockRequest struct {
	StartsAt time.Time `json:"startsAt"`
	EndsAt   time.Time `json:"endsAt"`
	Note     string    `json:"note"`
}

// moveRequest — куда переносят запись. Только новое начало: длительность и число
// мест переезжают как есть, а прежнее время сервер знает сам — присылать его значило
// бы дать клиенту назвать не то.
type moveRequest struct {
	StartsAt time.Time `json:"startsAt"`
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	user, workspaceID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	items, err := h.svc.List(r.Context(), user.ID, workspaceID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]scheduleListView, 0, len(items))
	for _, s := range items {
		out = append(out, toScheduleListView(s))
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string]any{"items": out})
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	user, workspaceID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	req, ok := decodeBody[scheduleRequest](w, r)
	if !ok {
		return
	}
	s, err := h.svc.Create(r.Context(), user.ID, workspaceID, req.input())
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toScheduleView(s))
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	s, err := h.svc.Get(r.Context(), user.ID, scheduleID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toScheduleView(s))
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	req, ok := decodeBody[scheduleRequest](w, r)
	if !ok {
		return
	}
	s, err := h.svc.Update(r.Context(), user.ID, scheduleID, req.input())
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toScheduleView(s))
}

func (h *Handler) remove(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	if err := h.svc.Delete(r.Context(), user.ID, scheduleID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) blocks(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	items, err := h.svc.Blocks(r.Context(), user.ID, scheduleID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]blockView, 0, len(items))
	for _, b := range items {
		out = append(out, blockView{ID: b.ID.String(), StartsAt: b.StartsAt, EndsAt: b.EndsAt, Note: b.Note})
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string]any{"items": out})
}

func (h *Handler) addBlock(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	req, ok := decodeBody[blockRequest](w, r)
	if !ok {
		return
	}
	b, err := h.svc.AddBlock(r.Context(), user.ID, scheduleID, req.StartsAt, req.EndsAt, req.Note)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated,
		blockView{ID: b.ID.String(), StartsAt: b.StartsAt, EndsAt: b.EndsAt, Note: b.Note})
}

func (h *Handler) removeBlock(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	blockID, err := uuid.Parse(r.PathValue("blockId"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	if err := h.svc.RemoveBlock(r.Context(), user.ID, scheduleID, blockID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// calendar — занятое время и записи отрезка: полотну недели. Границы обязательны
// обе, и это не придирка: запрос без них означал бы обход всей истории расписания.
func (h *Handler) calendar(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	q := r.URL.Query()
	period, err := domain.ParsePeriod(q.Get("from"), q.Get("to"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	cal, err := h.svc.Calendar(r.Context(), user.ID, scheduleID, period.From, period.To)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	blocks := make([]blockView, 0, len(cal.Blocks))
	for _, b := range cal.Blocks {
		blocks = append(blocks, blockView{ID: b.ID.String(), StartsAt: b.StartsAt, EndsAt: b.EndsAt, Note: b.Note})
	}
	bookings := make([]bookingView, 0, len(cal.Bookings))
	for _, b := range cal.Bookings {
		bookings = append(bookings, toBookingView(b))
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string]any{"blocks": blocks, "bookings": bookings})
}

func (h *Handler) upcoming(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	items, err := h.svc.Upcoming(r.Context(), user.ID, scheduleID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]bookingView, 0, len(items))
	for _, b := range items {
		out = append(out, toBookingView(b))
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string]any{"items": out})
}

func (h *Handler) cancelBooking(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	bookingID, err := uuid.Parse(r.PathValue("bookingId"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	if err := h.svc.CancelBooking(r.Context(), user.ID, scheduleID, bookingID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// moveBooking — перенос записи автором. Отказывает он двумя способами: 422, если
// время не легло на шаг сетки, и 409, если в слоте не осталось мест.
func (h *Handler) moveBooking(w http.ResponseWriter, r *http.Request) {
	user, scheduleID, ok := h.userAndID(w, r, "id")
	if !ok {
		return
	}
	bookingID, err := uuid.Parse(r.PathValue("bookingId"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	req, ok := decodeBody[moveRequest](w, r)
	if !ok {
		return
	}
	if err := h.svc.MoveBooking(r.Context(), user.ID, scheduleID, bookingID, req.StartsAt); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// userAndID — сессия плюс id из адреса. Неразобранный id даёт 404, а не 422:
// «такого адреса нет» — честнее, чем разбор чужой строки.
func (h *Handler) userAndID(w http.ResponseWriter, r *http.Request, param string) (auth.User, uuid.UUID, bool) {
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return auth.User{}, uuid.Nil, false
	}
	id, err := uuid.Parse(r.PathValue(param))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return auth.User{}, uuid.Nil, false
	}
	return user, id, true
}

// decodeBody — тело под MaxBytesReader и с запретом неизвестных полей: опечатка в
// имени настройки обязана краснеть, а не молча ничего не менять.
func decodeBody[T any](w http.ResponseWriter, r *http.Request) (T, bool) {
	var out T
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return out, false
	}
	return out, true
}
