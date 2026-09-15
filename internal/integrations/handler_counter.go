package integrations

import (
	"encoding/json"
	"fmt"
	"net/http"

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
