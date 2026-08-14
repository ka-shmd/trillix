package auth

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Транспорт второго фактора (фаза 23 DEV-PLAN, слайс F): включение и выключение
// в настройках плюс второй шаг входа.

// twoFactorCookie несёт подписанное «пароль (или провайдер) уже подтверждён,
// осталось предъявить код». Сессии в этот момент ещё нет и быть не должно:
// иначе первый шаг сам по себе давал бы доступ, и второй фактор становился бы
// украшением. TTL — общий с прочими короткими шагами входа (15 минут).
const twoFactorCookie = "two_factor"

// startTwoFactorChallenge ставит пропуск на второй шаг. Отдельный метод, потому
// что вызывается из двух мест — парольного входа и колбэка провайдера.
func (h *Handler) startTwoFactorChallenge(w http.ResponseWriter, userID uuid.UUID) {
	h.setFlowCookie(w, twoFactorCookie, h.signUserIntent(twoFactorIntentLabel, userID))
}

func (h *Handler) readTwoFactorChallenge(r *http.Request) (uuid.UUID, bool) {
	c, err := r.Cookie(twoFactorCookie)
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

	user, token, err := h.svc.CompleteTwoFactorLogin(r.Context(), userID, req.Code)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Пропуск одноразовый: он выполнил свою работу и не должен пережить вход.
	h.expireCookie(w, twoFactorCookie, true)
	h.startSession(w, token)
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(user, true))
}

type setupTOTPResponse struct {
	// Secret — тот же секрет, что в ссылке, но группами по четыре символа: его
	// вводят руками, когда ссылка не открылась.
	Secret string `json:"secret"`
	// OtpauthURL — ссылка, которую телефон открывает приложением-аутентификатором.
	// QR не рисуем: кодировщик Рида — Соломона это ~500 строк или новая
	// зависимость (решение владельца 2026-08-13).
	OtpauthURL string `json:"otpauthUrl"`
}

func (h *Handler) setupTOTP(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	if !h.twoFactorLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много попыток", domain.ErrRateLimited))
		return
	}
	secret, otpauth, err := h.svc.SetupTOTP(r.Context(), user)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, setupTOTPResponse{Secret: secret, OtpauthURL: otpauth})
}

type enableTOTPResponse struct {
	// RecoveryCodes отдаются РОВНО ОДИН РАЗ: в БД лежат хеши, и восстановить
	// исходные строки нельзя ни нам, ни тому, кто получит дамп.
	RecoveryCodes []string `json:"recoveryCodes"`
}

func (h *Handler) enableTOTP(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	if !h.twoFactorLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много попыток", domain.ErrRateLimited))
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

	codes, err := h.svc.EnableTOTP(r.Context(), user, req.Code)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, enableTOTPResponse{RecoveryCodes: codes})
}

type disableTOTPRequest struct {
	// CurrentPassword — как и везде в настройках, не спрашивается у аккаунта без
	// пароля. Code обязателен всегда: снять второй фактор, не предъявив второй
	// фактор, значит его не иметь.
	CurrentPassword string `json:"currentPassword"`
	Code            string `json:"code"`
}

func (h *Handler) disableTOTP(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Ведро здесь особенно уместно: за проверкой пароля стоит argon2id, а за
	// кодом — шестизначный перебор.
	if !h.twoFactorLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много попыток", domain.ErrRateLimited))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req disableTOTPRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	if err := h.svc.DisableTOTP(r.Context(), user, req.CurrentPassword, req.Code); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
