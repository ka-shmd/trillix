package booking

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// maxHoldBytes — потолок тела холда (инвариант 3: MaxBytesReader на каждом эндпоинте
// с телом). Там время, число мест и id клиента — сотни байт.
const maxHoldBytes = 4 << 10

// RateLimiter — ведро по ключу. Реализация — ratelimit.TokenBucket; в тестах
// инжектируется пермиссивная (инвариант 6: лимит не ослабляется ради теста).
type RateLimiter interface {
	Allow(key string) bool
}

type publicService interface {
	Slots(ctx context.Context, req SlotsRequest) ([]domain.Slot, error)
	Hold(ctx context.Context, req HoldRequest) (uuid.UUID, time.Time, error)
}

// cancelService — отмена записи по ссылке из письма. Отдельным интерфейсом, а не
// методами того же: у отмены нет ни формы, ни slug'а — право предъявляет токен.
type cancelService interface {
	Show(ctx context.Context, tok string) (Card, error)
	Cancel(ctx context.Context, tok string) (Card, error)
}

// PublicHandler — публичный транспорт записи (без авторизации и CSRF).
type PublicHandler struct {
	svc          publicService
	cancel       cancelService
	listLimiter  RateLimiter
	holdLimiter  RateLimiter
	cancelLimit  RateLimiter
	trustedProxy bool
}

func NewPublicHandler(svc publicService, list, hold RateLimiter, trustedProxy bool) *PublicHandler {
	return &PublicHandler{svc: svc, listLimiter: list, holdLimiter: hold, trustedProxy: trustedProxy}
}

// WithCancel подключает отмену по ссылке. Сеттером, а не аргументом конструктора: у
// отмены свой сервис и своё ведро, а связывать их с выдачей времени незачем.
func (h *PublicHandler) WithCancel(svc cancelService, limiter RateLimiter) *PublicHandler {
	h.cancel = svc
	h.cancelLimit = limiter
	return h
}

func (h *PublicHandler) Routes(mux *http.ServeMux) {
	// ВЫДАЧА ВРЕМЕНИ — ведро по IP, хотя ручка читающая: дешёвой её не назвать, это
	// счёт занятого по диапазону плюс расчёт сетки на горизонт.
	listed := httpserver.RateLimitByIP(h.listLimiter, h.trustedProxy, "слишком много запросов")
	mux.Handle("GET /public/v1/forms/{slug}/slots", listed(http.HandlerFunc(h.slots)))
	// ХОЛД — своё ведро и свой ключ (см. hold): общее с выдачей означало бы, что
	// листание дат съедает право записаться.
	mux.Handle("POST /public/v1/forms/{slug}/slots/hold", http.HandlerFunc(h.hold))

	if h.cancel != nil {
		// ОТМЕНА АДРЕСУЕТСЯ ТОКЕНОМ, А НЕ ФОРМОЙ: у респондента нет ни slug'а, ни
		// сессии — ссылка из письма и есть его право. Ведро по IP: токен
		// неперебираемый, но подбор его всё равно должен упираться в стену.
		limited := httpserver.RateLimitByIP(h.cancelLimit, h.trustedProxy, "слишком много запросов")
		mux.Handle("GET /public/v1/bookings/{token}", limited(http.HandlerFunc(h.showCancel)))
		mux.Handle("POST /public/v1/bookings/{token}/cancel", limited(http.HandlerFunc(h.doCancel)))
	}
}

func (h *PublicHandler) showCancel(w http.ResponseWriter, r *http.Request) {
	card, err := h.cancel.Show(r.Context(), r.PathValue("token"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	writeCard(w, r, card)
}

func (h *PublicHandler) doCancel(w http.ResponseWriter, r *http.Request) {
	card, err := h.cancel.Cancel(r.Context(), r.PathValue("token"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	writeCard(w, r, card)
}

// cardView — что видит страница отмены. Имени и контактов записавшегося здесь нет:
// они живут в ответе формы и подчиняются его правилам (спека §13).
type cardView struct {
	StartsAt        time.Time `json:"startsAt"`
	DurationMinutes int       `json:"durationMinutes"`
	Seats           int       `json:"seats"`
	FormTitle       string    `json:"formTitle"`
	// Timezone — пояс РАСПИСАНИЯ: страница пишет время и в нём, и в поясе читателя,
	// когда они разные.
	Timezone string `json:"timezone"`
	Canceled bool   `json:"canceled"`
}

// writeCard — карточка на провод. Перечислением, а не приведением: у Card есть
// СЛУЖЕБНЫЕ поля (id формы и ответа), и наружу они не едут — страница отмены не
// раскрывает ничего сверх того, что человеку и так прислали письмом.
func writeCard(w http.ResponseWriter, r *http.Request, c Card) {
	w.Header().Set("Cache-Control", "no-store")
	httpserver.WriteJSON(w, r, http.StatusOK, cardView{
		StartsAt:        c.StartsAt,
		DurationMinutes: c.DurationMinutes,
		Seats:           c.Seats,
		FormTitle:       c.FormTitle,
		Timezone:        c.Timezone,
		Canceled:        c.Canceled,
	})
}

func (h *PublicHandler) slots(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	from, err := parseTime(r.URL.Query().Get("from"))
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: параметр from — не время", domain.ErrValidation))
		return
	}
	to, err := parseTime(r.URL.Query().Get("to"))
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: параметр to — не время", domain.ErrValidation))
		return
	}
	// client — чей холд не считать занятым. Мусор в параметре не отказ: право он не
	// даёт, а в худшем случае человек не увидит собственное придержанное время.
	client, _ := uuid.Parse(r.URL.Query().Get("client"))

	slots, err := h.svc.Slots(r.Context(), SlotsRequest{
		Slug:     slug,
		From:     from,
		To:       to,
		Unlock:   r.Header.Get(unlockHeader),
		ClientID: client,
	})
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	items := make([]slotView, 0, len(slots))
	for _, s := range slots {
		items = append(items, slotView{StartsAt: s.StartsAt, Remaining: s.Remaining})
	}
	// СВОБОДНОЕ ВРЕМЯ НЕ КЭШИРУЕТСЯ ВОВСЕ: это самые быстро протухающие данные
	// продукта (спека §7). Схема формы рядом живёт с ETag и max-age=60 — здесь так
	// нельзя, иначе двое увидят один и тот же занятый слот свободным.
	w.Header().Set("Cache-Control", "no-store")
	httpserver.WriteJSON(w, r, http.StatusOK, map[string]any{"items": items})
}

func (h *PublicHandler) hold(w http.ResponseWriter, r *http.Request) {
	slug := r.PathValue("slug")
	// ⚠ ВЕДРО СПИСЫВАЕТСЯ ДО РАЗБОРА ТЕЛА И ДО ЛЮБОЙ ПРОВЕРКИ (спека §7): иначе
	// перебором холдов можно заблокировать чужую форму — отказы стоили бы атакующему
	// ничего, а её респондентам всё. Ключ — пара «IP + slug»: одна форма под атакой
	// не закрывает человеку остальные.
	key := httpserver.ClientIP(r, h.trustedProxy) + "|" + slug
	if !h.holdLimiter.Allow(key) {
		httpserver.WriteError(w, r, domain.ErrRateLimited)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxHoldBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req holdRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	startsAt, err := parseTime(req.StartsAt)
	if err != nil || startsAt.IsZero() {
		httpserver.WriteError(w, r, fmt.Errorf("%w: время выбрано неверно", domain.ErrValidation))
		return
	}
	clientID, err := uuid.Parse(req.ClientID)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный идентификатор клиента", domain.ErrValidation))
		return
	}
	seats := req.Seats
	if seats == 0 {
		seats = 1
	}

	id, expires, err := h.svc.Hold(r.Context(), HoldRequest{
		Slug:     slug,
		StartsAt: startsAt,
		Seats:    seats,
		ClientID: clientID,
		Unlock:   r.Header.Get(unlockHeader),
	})
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpserver.WriteJSON(w, r, http.StatusCreated, holdView{
		BookingID: id.String(),
		ExpiresAt: expires,
	})
}

// unlockHeader — заголовок токена разблокировки формы под паролем. Тот же, что у
// отдачи формы и приёма ответа (design/form-password.md §3.3): у трёх входов один
// способ предъявить право, иначе список входов разъедется по способам.
const unlockHeader = "X-Form-Unlock"

type slotView struct {
	StartsAt time.Time `json:"startsAt"`
	// Remaining едет ВСЕГДА: без него пикер не погасит слот, куда запрошенные места
	// не влезают. Показывать ли число человеку, решает showRemaining расписания —
	// оно приезжает вместе с формой (спека §7).
	Remaining int `json:"remaining"`
}

type holdRequest struct {
	StartsAt string `json:"startsAt"`
	Seats    int    `json:"seats"`
	// ClientID — тот же id, что станет идентификатором ответа: по нему бронь держится
	// одной на клиента, и передумавший переносит свою, а не заводит вторую.
	ClientID string `json:"clientId"`
}

type holdView struct {
	BookingID string    `json:"bookingId"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// parseTime — время из параметра или тела. Пустая строка — не ошибка: у выдачи это
// «с текущего момента» и «до конца горизонта».
func parseTime(v string) (time.Time, error) {
	if v == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339, v)
}
