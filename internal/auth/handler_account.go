package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/oauth"
)

// Транспорт настроек аккаунта — /api/v1/account/* (фаза 23 DEV-PLAN).
// Отдельный файл и отдельный регистратор, как у OAuthRoutes: auth и без того
// самый крупный модуль, а настройки прирастают слайсами до удаления аккаунта.

// AccountRoutes регистрирует эндпоинты настроек аккаунта. Все — за RequireAuth
// и RequireCSRF: это мутации над собственным аккаунтом, и ни одна из них не
// имеет анонимного применения.
func (h *Handler) AccountRoutes(mux *http.ServeMux) {
	// Забытый WithAccount иначе обнаруживается первым же запросом человека —
	// паникой на nil-лимитере внутри хендлера. Конфигурация проверяется на
	// старте процесса, а не на первом запросе (internal/CLAUDE.md).
	if h.passwordChangeLimiter == nil || h.emailChangeLimiter == nil ||
		h.confirmEmailLimiter == nil || h.twoFactorLimiter == nil {
		panic("auth: AccountRoutes вызван без WithAccount — вёдра лимита не заданы")
	}

	mux.Handle("PATCH /api/v1/account/profile", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.updateProfile))))
	mux.Handle("POST /api/v1/account/password", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.changePassword))))
	mux.Handle("POST /api/v1/account/email", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.requestEmailChange))))
	mux.Handle("GET /api/v1/account/identities", h.RequireAuth(http.HandlerFunc(h.listIdentities)))
	mux.Handle("DELETE /api/v1/account/identities/{provider}",
		h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.unlinkIdentity))))
	// Начало привязки — GET-редирект к провайдеру, поэтому CSRF-заголовка на нём
	// быть не может (это навигация браузера, не fetch). Защищает не он, а то, что
	// маршрут за RequireAuth и намерение уезжает в HttpOnly-cookie, подписанную
	// на конкретный аккаунт.
	mux.Handle("GET /api/v1/account/identities/{provider}/start",
		h.RequireAuth(http.HandlerFunc(h.startIdentityLink)))
	// Второй фактор (слайс F). Включение и выключение — свои мутации; второй шаг
	// ВХОДА живёт в Routes, потому что сессии на нём ещё нет.
	mux.Handle("POST /api/v1/account/2fa/setup", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.setupTOTP))))
	mux.Handle("POST /api/v1/account/2fa/enable", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.enableTOTP))))
	mux.Handle("POST /api/v1/account/2fa/disable", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.disableTOTP))))
	// Второй шаг смены адреса — ПУБЛИЧНЫЙ (по ссылке ходят из почтового клиента,
	// где сессии кабинета может не быть): аутентифицирует сам одноразовый токен,
	// CSRF не нужен, щит — лимит по IP. Живёт здесь, а не в Routes, потому что
	// это половина одного сценария, и ведро ему выдаёт тот же WithAccount.
	mux.Handle("POST /api/v1/auth/confirm-email-change",
		h.rateLimit(h.confirmEmailLimiter, "слишком много попыток смены адреса")(http.HandlerFunc(h.confirmEmailChange)))
}

type updateProfileRequest struct {
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
}

// updateProfile ставит имя и фамилию. Тело содержит ОБА поля всегда: PATCH здесь
// про часть аккаунта (профиль), а не про часть профиля — «прислать только имя»
// означало бы, что фамилию нельзя стереть.
func (h *Handler) updateProfile(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req updateProfileRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	// Пользователь берётся из контекста, а не из тела: id в запросе не является
	// доказательством права (инвариант безопасности 1), а править чужой профиль
	// эндпоинт не умеет вовсе — такого адреса нет.
	updated, err := h.svc.UpdateProfile(r.Context(), user.ID, req.FirstName, req.LastName)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Кабинет патчит этим ответом кэш профиля, поэтому объект обязан быть
	// полным: соврать про второй фактор здесь значит выключить его на экране.
	twoFactor, err := h.svc.TwoFactorEnabled(r.Context(), user.ID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(updated, twoFactor))
}

type changePasswordRequest struct {
	// CurrentPassword необязателен ровно в одном случае — у аккаунта без пароля
	// (заведён через провайдера). Во всех остальных пустая строка не пройдёт
	// проверку в сервисе.
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

// changePassword ставит новый пароль, рвёт все сессии пользователя и открывает
// взамен новую — поэтому в ответе переставляются cookie сессии и CSRF. Тела нет:
// профиль сменой пароля не меняется, а токен в JSON не отдаётся никогда.
func (h *Handler) changePassword(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Лимит по пользователю, а не по IP: ключ есть только после RequireAuth, и
	// защищаем мы не от подбора (сессия уже своя), а от argon2id — каждый вызов
	// стоит 64 МиБ памяти, и кнопка, нажатая в цикле, кладёт процесс.
	if !h.passwordChangeLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много смен пароля", domain.ErrRateLimited))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req changePasswordRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	token, err := h.svc.ChangePassword(r.Context(), user, req.CurrentPassword, req.NewPassword)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	h.startSession(w, token)
	w.WriteHeader(http.StatusNoContent)
}

type requestEmailChangeRequest struct {
	NewEmail string `json:"newEmail"`
	// CurrentPassword — как и у смены пароля, необязателен только у аккаунта без
	// пароля (заведён через провайдера).
	CurrentPassword string `json:"currentPassword"`
}

// requestEmailChange начинает смену адреса. Адрес в users НЕ меняется: ответ 204
// означает «письмо со ссылкой поставлено в очередь», а не «адрес сменился».
func (h *Handler) requestEmailChange(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Ведро по пользователю: письмо уходит на произвольный адрес, введённый в
	// форме, — то же соображение, что у приглашений в пространство.
	if !h.emailChangeLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много запросов смены адреса", domain.ErrRateLimited))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req requestEmailChangeRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	if err := h.svc.RequestEmailChange(r.Context(), user, req.NewEmail, req.CurrentPassword); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type confirmEmailChangeRequest struct {
	Token string `json:"token"`
}

// confirmEmailChange переносит адрес по токену из письма. Сессию не выдаёт и не
// рвёт: по ссылке ходят из почтового клиента, а пароль не менялся.
func (h *Handler) confirmEmailChange(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req confirmEmailChangeRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	if err := h.svc.ConfirmEmailChange(r.Context(), req.Token); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type identityResponse struct {
	Provider string `json:"provider"`
	// ProviderEmail — адрес аккаунта У ПРОВАЙДЕРА; пустой у привязок старше
	// миграции 0021 (заполнится на ближайшем входе).
	ProviderEmail string `json:"providerEmail"`
	ConnectedAt   string `json:"connectedAt"`
}

func (h *Handler) listIdentities(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	items, err := h.svc.Identities(r.Context(), user.ID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]identityResponse, 0, len(items))
	for _, it := range items {
		out = append(out, identityResponse{
			Provider:      it.Provider,
			ProviderEmail: strOrEmpty(it.ProviderEmail),
			ConnectedAt:   it.CreatedAt.UTC().Format(time.RFC3339),
		})
	}
	httpserver.WriteJSON(w, r, http.StatusOK, out)
}

func (h *Handler) unlinkIdentity(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	if err := h.svc.UnlinkIdentity(r.Context(), user, r.PathValue("provider")); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// startIdentityLink уводит к провайдеру, пометив поход как привязку к текущему
// аккаунту. Отдельный адрес, а не ?intent=link у общего /auth/oauth/{p}/start:
// тот публичный (им входят), а этот обязан быть за RequireAuth — иначе намерение
// привязки мог бы поставить кто угодно.
func (h *Handler) startIdentityLink(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	provider, ok := h.oauthProviders[r.PathValue("provider")]
	if !ok {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}

	state, err := oauth.NewSecret()
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	verifier, err := oauth.NewSecret()
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	h.setFlowCookie(w, oauthStateCookie, state+":"+verifier)
	h.setFlowCookie(w, oauthLinkCookie, h.signLinkIntent(user.ID))
	http.Redirect(w, r, provider.AuthURL(state, verifier), http.StatusFound)
}
