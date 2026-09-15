package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Транспорт второго фактора (0056): второй шаг входа, включение и выключение в
// настройках, список известных устройств. Сценарии — service_2fa.go.

// twoFactorCookie несёт подписанное «пароль (или провайдер) уже подтверждён,
// осталось предъявить код». Сессии в этот момент ещё нет и быть не должно:
// иначе первый шаг сам по себе давал бы доступ, и второй фактор становился бы
// украшением. TTL — общий с прочими короткими шагами входа (15 минут).
const twoFactorCookie = "two_factor"

// knownDeviceCookie помнит браузер, уже предъявлявший код. Значение — сам
// токен, в БД лежит его SHA-256.
//
// Живёт дольше сессии (180 дней против 30 суток) и переживает выход из
// аккаунта: «этот браузер уже доказал, что он мой» — утверждение про машину, а
// не про сеанс, и гасить его логаутом значило бы спрашивать код после каждого
// выхода со своего же компьютера.
const knownDeviceCookie = "known_device"

// device собирает то, что путь входа знает о браузере. User-Agent идёт в метку
// списка устройств; IP не берём сознательно (см. спеку §7).
func (h *Handler) device(r *http.Request) Device {
	dev := Device{UserAgent: r.UserAgent()}
	if c, err := h.readCookie(r, knownDeviceCookie); err == nil {
		dev.Token = c.Value
	}
	return dev
}

// startTwoFactorChallenge ставит пропуск на второй шаг. Отдельный метод, потому
// что вызывается из двух мест — парольного входа и колбэка провайдера.
func (h *Handler) startTwoFactorChallenge(w http.ResponseWriter, userID uuid.UUID) {
	h.setFlowCookie(w, twoFactorCookie, h.signUserIntent(twoFactorIntentLabel, userID))
}

func (h *Handler) readTwoFactorChallenge(r *http.Request) (uuid.UUID, bool) {
	c, err := h.readCookie(r, twoFactorCookie)
	if err != nil {
		return uuid.Nil, false
	}
	return h.readUserIntent(twoFactorIntentLabel, c.Value)
}

type twoFactorCodeRequest struct {
	Code string `json:"code"`
}

// loginTwoFactor — второй шаг входа. Вёдер два, и они ограничивают разное.
//
// По IP (на маршруте, ведро ЛОГИНА) — чтобы перебор не переехал с логина на
// менее защищённую дверь. По АККАУНТУ (здесь) — потому что перебирают код
// конкретного аккаунта, а адрес атакующему ничего не стоит: с пула IP лимит по
// адресу не ограничивает число попыток по аккаунту вовсе. Пропуск на второй шаг
// от этого не спасает — он выдаётся по паролю, а сценарий, ради которого второй
// фактор включают, начинается с утёкшего пароля.
//
// Лока после N неудач сознательно нет: он даёт запирать чужой аккаунт, зная
// только адрес. Ведро режет темп, не отбирая владельцу возможность войти.
func (h *Handler) loginTwoFactor(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.readTwoFactorChallenge(r)
	if !ok {
		// Пропуска нет или он протух — первый шаг надо пройти заново. 401, а не
		// 422: это про доступ, а не про форму запроса.
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Ключ — id из подписанного пропуска, а не из тела: тело подсовывает клиент,
	// и ведро ключевалось бы тем, что выбрал перебирающий.
	if !h.loginTwoFactorLimiter.Allow(userID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много попыток ввода кода", domain.ErrRateLimited))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req twoFactorCodeRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	user, token, deviceToken, err := h.svc.CompleteTwoFactorLogin(r.Context(), userID, req.Code, h.device(r))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Пропуск одноразовый: он выполнил свою работу и не должен пережить вход.
	h.expireCookie(w, twoFactorCookie, true)
	h.setDeviceCookie(w, deviceToken)
	h.startSession(w, token)
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(user))
}

// resendLoginCode шлёт код заново — тому же аккаунту, что назван пропуском.
// Ведро по аккаунту здесь то же, что у ввода кода: без него форма входа стала
// бы способом засыпать чужой ящик письмами.
func (h *Handler) resendLoginCode(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.readTwoFactorChallenge(r)
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	if !h.loginTwoFactorLimiter.Allow(userID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много запросов кода", domain.ErrRateLimited))
		return
	}
	if err := h.svc.ResendLoginCode(r.Context(), userID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// twoFactorPasswordRequest — тело включения и выключения. Пароль не
// спрашивается у аккаунта без пароля (заведён через провайдера): доказательством
// там служит сама сессия, как и везде в настройках.
type twoFactorPasswordRequest struct {
	CurrentPassword string `json:"currentPassword"`
}

func (h *Handler) enableTwoFactor(w http.ResponseWriter, r *http.Request) {
	h.switchTwoFactor(w, r, true)
}

func (h *Handler) disableTwoFactor(w http.ResponseWriter, r *http.Request) {
	h.switchTwoFactor(w, r, false)
}

func (h *Handler) switchTwoFactor(w http.ResponseWriter, r *http.Request, enable bool) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Ведро уместно: за проверкой пароля стоит argon2id.
	if !h.twoFactorLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много попыток", domain.ErrRateLimited))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req twoFactorPasswordRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	var err error
	if enable {
		err = h.svc.EnableTwoFactor(r.Context(), user, req.CurrentPassword)
	} else {
		err = h.svc.DisableTwoFactor(r.Context(), user, req.CurrentPassword)
	}
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Устройства забыты вместе с переключением (setTwoFactor), поэтому cookie
	// знакомства гасится здесь же: оставленная, она пережила бы сама себя и на
	// следующем включении ничего не значила.
	h.expireCookie(w, knownDeviceCookie, true)
	user.TwoFactorEnabled = enable
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(user))
}

// sendActionCode шлёт код подтверждения действия в настройках (смена адреса,
// удаление аккаунта) на почту аккаунта.
func (h *Handler) sendActionCode(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	if !h.twoFactorLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много запросов кода", domain.ErrRateLimited))
		return
	}
	if !user.TwoFactorEnabled {
		// Кода без включённого фактора не бывает: ручка не должна становиться
		// способом слать письма на чужой адрес по одной живой сессии.
		httpserver.WriteError(w, r, fmt.Errorf("%w: второй фактор не включён", domain.ErrConflict))
		return
	}
	if err := h.svc.SendActionCode(r.Context(), user); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type deviceResponse struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// LastSeenAt — когда с этого браузера входили в последний раз. Дата, а не
	// «сколько назад»: формулировку выбирает кабинет.
	LastSeenAt time.Time `json:"lastSeenAt"`
	CreatedAt  time.Time `json:"createdAt"`
	// Current — то устройство, с которого человек смотрит на список.
	Current bool `json:"current"`
}

func (h *Handler) listDevices(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	devices, err := h.svc.ListDevices(r.Context(), user.ID, h.device(r))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]deviceResponse, 0, len(devices))
	for _, d := range devices {
		out = append(out, deviceResponse{
			ID:         d.ID.String(),
			Label:      d.Label,
			LastSeenAt: d.LastSeenAt,
			CreatedAt:  d.CreatedAt,
			Current:    d.Current,
		})
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string]any{"devices": out})
}

func (h *Handler) forgetDevice(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный идентификатор устройства", domain.ErrValidation))
		return
	}
	if err := h.svc.ForgetDevice(r.Context(), user.ID, id); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// forgetAllDevices забывает все устройства и рвёт все сессии, кроме текущей
// (почему именно так — комментарий ForgetAllDevices в service_2fa.go).
func (h *Handler) forgetAllDevices(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	c, err := h.readCookie(r, sessionCookieName)
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	if err := h.svc.ForgetAllDevices(r.Context(), user.ID, c.Value); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Своё знакомство тоже забыто: следующий вход из этого браузера — с кодом.
	h.expireCookie(w, knownDeviceCookie, true)
	w.WriteHeader(http.StatusNoContent)
}
