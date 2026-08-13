package auth

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
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
	if h.passwordChangeLimiter == nil || h.emailChangeLimiter == nil || h.confirmEmailLimiter == nil {
		panic("auth: AccountRoutes вызван без WithAccount — вёдра лимита не заданы")
	}

	mux.Handle("PATCH /api/v1/account/profile", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.updateProfile))))
	mux.Handle("POST /api/v1/account/password", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.changePassword))))
	mux.Handle("POST /api/v1/account/email", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.requestEmailChange))))
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
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(updated))
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
