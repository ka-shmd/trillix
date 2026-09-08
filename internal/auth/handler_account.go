package auth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	if h.passwordChangeLimiter == nil || h.twoFactorLimiter == nil ||
		h.deleteAccountLimiter == nil || h.avatarLimiter == nil {
		panic("auth: AccountRoutes вызван без WithAccount — вёдра лимита не заданы")
	}

	mux.Handle("PATCH /api/v1/account/profile", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.updateProfile))))
	// Аватар. Тело — multipart, а не JSON: это файл. Снятие отдельным методом
	// на том же адресе, а не PATCH с пустым ключом, — у ресурса «картинка
	// профиля» ровно два действия, поставить и снять.
	mux.Handle("POST /api/v1/account/avatar", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.uploadAvatar))))
	mux.Handle("DELETE /api/v1/account/avatar", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.deleteAvatar))))
	mux.Handle("POST /api/v1/account/password", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.changePassword))))
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
	mux.Handle("POST /api/v1/account/2fa/enable", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.enableTwoFactor))))
	mux.Handle("POST /api/v1/account/2fa/disable", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.disableTwoFactor))))
	// Код подтверждения действия: его просит форма удаления аккаунта — у
	// аккаунта с включённым фактором взять код больше негде.
	mux.Handle("POST /api/v1/account/2fa/send-code", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.sendActionCode))))
	// Известные устройства (0056). Список — под сессией; забывание меняет
	// состояние, поэтому под CSRF.
	mux.Handle("GET /api/v1/account/devices", h.RequireAuth(http.HandlerFunc(h.listDevices)))
	mux.Handle("DELETE /api/v1/account/devices/{id}", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.forgetDevice))))
	mux.Handle("DELETE /api/v1/account/devices", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.forgetAllDevices))))
	// Удаление аккаунта (слайс G) — POST, а не DELETE: у запроса есть тело
	// (подтверждение паролем и кодом), а DELETE с телом читают не все прокси.
	mux.Handle("POST /api/v1/account/delete", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.deleteAccount))))
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
	h.writeProfile(w, r, updated)
}

// writeProfile отвечает профилем на любую его правку (имя, аватар). Кабинет
// патчит этим ответом кэш целиком, поэтому флаг второго фактора обязан ехать
// вместе со всем остальным — он живёт в самой строке users (0056).
func (h *Handler) writeProfile(w http.ResponseWriter, r *http.Request, u User) {
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(u))
}

// maxAvatarBytes зеркалит media.MaxImageBytes: импортировать оттуда нельзя
// (media стоит на RequireAuth из auth — вышел бы цикл), а расхождение означало
// бы, что MaxBytesReader режет тело раньше или позже, чем валидатор картинки.
const maxAvatarBytes = 5 << 20 // 5 МиБ

// uploadAvatar принимает картинку multipart-полем file, кладёт её в хранилище и
// записывает ключ в профиль. Отвечает ПОЛНЫМ профилем, как и updateProfile:
// кабинет патчит им кэш, и урезанный ответ стёр бы в нём остальные поля.
func (h *Handler) uploadAvatar(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Лимит по пользователю, как у смены пароля: сессия уже своя, защищаем не от
	// подбора, а от стоимости декода и ре-энкода картинки.
	if !h.avatarLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много загрузок аватара", domain.ErrRateLimited))
		return
	}

	// Потолок тела (инвариант 3): превышение → 413.
	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarBytes)
	file, _, err := r.FormFile("file")
	if err != nil {
		httpserver.WriteError(w, r, avatarInputError(err))
		return
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(file)
	if err != nil {
		httpserver.WriteError(w, r, avatarInputError(err))
		return
	}

	updated, err := h.svc.SetAvatar(r.Context(), user.ID, data)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	h.writeProfile(w, r, updated)
}

// deleteAvatar снимает аватар. Повторный вызов — не ошибка: ключа и так нет.
func (h *Handler) deleteAvatar(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	updated, err := h.svc.ClearAvatar(r.Context(), user.ID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	h.writeProfile(w, r, updated)
}

// avatarInputError переводит ошибку чтения тела в доменную: превышение лимита —
// 413, отсутствие поля file и битый multipart — 422.
func avatarInputError(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return domain.ErrTooLarge
	}
	return fmt.Errorf("%w: ожидается multipart-поле file с картинкой", domain.ErrValidation)
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

type deleteAccountRequest struct {
	// CurrentPassword — необязателен только у аккаунта без пароля; Code — только
	// при выключенном втором факторе. Проверяет это сервис: транспорт не знает,
	// чем этот аккаунт вообще может доказать, что он свой.
	CurrentPassword string `json:"currentPassword"`
	Code            string `json:"code"`
}

// deleteAccount помечает аккаунт удалённым и гасит cookie: сессий у него больше
// нет ни одной, и оставленная cookie означала бы кабинет, который открывается
// ровно до первого запроса.
func (h *Handler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	if !h.deleteAccountLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много попыток удаления", domain.ErrRateLimited))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req deleteAccountRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	if err := h.svc.DeleteAccount(r.Context(), user, req.CurrentPassword, req.Code); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	h.clearSession(w)
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
	h.setPopupMode(w, r)
	// ПРИВЯЗКА ВСЕГДА СПРАШИВАЕТ АККАУНТ ЗАНОВО. Иначе человек, у которого в
	// браузере залогинен не тот аккаунт провайдера, получает один и тот же отказ
	// на каждой попытке: выбрать другой ему негде (найдено владельцем 2026-09-08).
	http.Redirect(w, r, provider.AuthURL(state, verifier, oauth.ForceChooser), http.StatusFound)
}
