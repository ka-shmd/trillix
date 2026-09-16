package integrations

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Транспорт счётчиков аналитики формы (фаза 29 DEV-PLAN). Сервис — counter.go.

// counterResponse — счётчик формы глазами экрана.
type counterResponse struct {
	Counter string `json:"counter"`
	Enabled bool   `json:"enabled"`
}

// toCounterResponse — nil у формы без счётчика: в состоянии таба это `null`.
func toCounterResponse(c *Counter) *counterResponse {
	if c == nil {
		return nil
	}
	return &counterResponse{Counter: c.Number, Enabled: c.Enabled}
}

// counterRequest — тело подключения и правки. Enabled необязателен: подключение
// включает счётчик сразу, а тумблер строки шлёт его явно.
type counterRequest struct {
	Counter string `json:"counter"`
	Enabled *bool  `json:"enabled"`
}

func (h *Handler) setMetrika(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req counterRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	in := CounterInput{Number: req.Counter, Enabled: req.Enabled == nil || *req.Enabled}
	c, err := h.svc.SetCounter(r.Context(), user.ID, formID, CounterYandexMetrika, in)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toCounterResponse(&c))
}

func (h *Handler) deleteMetrika(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteCounter(r.Context(), user.ID, formID, CounterYandexMetrika); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Счётчики аккаунта Яндекса и заведение целей (спека §13.3). Сервис — counter.go.

// metrikaCounterResponse — счётчик в списке выбора. Номер числом, как его отдаёт
// Метрика; строкой он становится в теле PUT, которым счётчик сохраняется.
type metrikaCounterResponse struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Site string `json:"site"`
}

func (h *Handler) metrikaCounters(w http.ResponseWriter, r *http.Request) {
	user, accountID, ok := h.userAndAccount(w, r)
	if !ok {
		return
	}
	list, err := h.svc.MetrikaCounters(r.Context(), user.ID, accountID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]metrikaCounterResponse, 0, len(list))
	for _, c := range list {
		out = append(out, metrikaCounterResponse(c))
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string][]metrikaCounterResponse{"counters": out})
}

// goalsRequest — чьим аккаунтом заводить цели. Форма и её счётчик в теле не
// нужны: форма в адресе, счётчик у формы.
type goalsRequest struct {
	AccountID string `json:"accountId"`
}

// goalsResponse — сколько целей завели и сколько уже было. Второе число не
// формальность: «уже было три» — это ответ «всё на месте», а не «ничего не
// произошло».
type goalsResponse struct {
	Created  int `json:"created"`
	Existing int `json:"existing"`
}

// counterCreatedResponse — что вернулось из одного действия: номер нового
// счётчика и итог по целям.
type counterCreatedResponse struct {
	Counter  string `json:"counter"`
	Created  int    `json:"created"`
	Existing int    `json:"existing"`
}

func (h *Handler) createMetrikaCounter(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}
	accountID, ok := h.accountFromBody(w, r)
	if !ok {
		return
	}
	c, goals, err := h.svc.CreateMetrikaCounter(r.Context(), user.ID, formID, accountID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, counterCreatedResponse{
		Counter: c.Number, Created: goals.Created, Existing: goals.Existing,
	})
}

// accountFromBody — чьим аккаунтом Яндекса действовать. Общее для обеих ручек
// тело: форма в адресе, счётчик у формы, в теле остаётся только аккаунт.
func (h *Handler) accountFromBody(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req goalsRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return uuid.Nil, false
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: не выбран аккаунт Яндекса", domain.ErrValidation))
		return uuid.Nil, false
	}
	return accountID, true
}

func (h *Handler) metrikaGoals(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}
	accountID, ok := h.accountFromBody(w, r)
	if !ok {
		return
	}
	res, err := h.svc.EnsureMetrikaGoals(r.Context(), user.ID, formID, accountID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, goalsResponse(res))
}
