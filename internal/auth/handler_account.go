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
	mux.Handle("PATCH /api/v1/account/profile", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.updateProfile))))
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
