package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/oauth"
)

const (
	// oauthStateCookie держит state и code_verifier между уходом к провайдеру и
	// возвратом. HttpOnly: JS они не нужны. SameSite=Lax — обязателен, чтобы
	// cookie доехала на top-level GET-редиректе с домена провайдера (Strict её
	// не отдаст, и вход сломается на ровном месте).
	oauthStateCookie = "oauth_state"
	// oauthPendingCookie несёт подписанное «этот человек подтвердил у провайдера
	// вот эту личность» между колбэком и вводом пароля.
	oauthPendingCookie = "oauth_pending"

	// Человек уходит к провайдеру и возвращается — это минуты, не часы.
	oauthFlowTTL = 15 * time.Minute
)

// oauthProviders — реестр включённых провайдеров. Пустой (ключей нет в env) —
// эндпоинты отдают 404, фронт кнопку не рисует.
type oauthProviders map[string]oauth.Provider

// oauthService — то, что транспорту нужно от сервиса сверх authService.
type oauthService interface {
	LoginWithIdentity(ctx context.Context, p IdentityProfile) (User, string, error)
	LinkIdentityWithPassword(ctx context.Context, email, password, provider, providerUserID string) (User, string, error)
}

// OAuthRoutes регистрирует эндпоинты входа через провайдеров.
func (h *Handler) OAuthRoutes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/auth/providers", http.HandlerFunc(h.providers))
	mux.Handle("GET /api/v1/auth/oauth/{provider}/start", http.HandlerFunc(h.oauthStart))
	mux.Handle("GET /api/v1/auth/oauth/{provider}/callback",
		h.rateLimit(h.oauthLimiter, "слишком много попыток входа")(http.HandlerFunc(h.oauthCallback)))
	// /link принимает пароль — живёт под ведром логина, а не под своим:
	// иначе перебор просто переезжает на менее защищённую дверь.
	mux.Handle("POST /api/v1/auth/oauth/link",
		h.rateLimit(h.loginLimiter, "слишком много попыток входа")(http.HandlerFunc(h.oauthLink)))
}

func (h *Handler) providers(w http.ResponseWriter, r *http.Request) {
	names := make([]string, 0, len(h.oauthProviders))
	for name := range h.oauthProviders {
		names = append(names, name)
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string][]string{"providers": names})
}

func (h *Handler) oauthStart(w http.ResponseWriter, r *http.Request) {
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
	http.Redirect(w, r, provider.AuthURL(state, verifier), http.StatusFound)
}

func (h *Handler) oauthCallback(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("provider")
	provider, ok := h.oauthProviders[name]
	if !ok {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	// Cookie одноразовая: гасим её сразу, до любого ответа. Через defer было бы
	// нельзя — http.Redirect и WriteError к тому моменту уже записали заголовки,
	// и Set-Cookie просто не уехал бы, оставив state жить все 15 минут TTL.
	h.expireCookie(w, oauthStateCookie, true)

	// Провайдер вернул отказ (человек нажал «Отклонить») — это не авария.
	if r.URL.Query().Get("error") != "" {
		h.redirectToApp(w, r, "/login?oauth=denied")
		return
	}

	state, verifier, ok := h.readFlowCookie(r, oauthStateCookie)
	if !ok {
		h.redirectToApp(w, r, "/login?oauth=expired")
		return
	}
	// Сверка state — защита от CSRF: без неё чужой код можно подсунуть
	// залогиненному человеку и привязать к нему свою личность у провайдера.
	if subtle.ConstantTimeCompare([]byte(state), []byte(r.URL.Query().Get("state"))) != 1 {
		h.redirectToApp(w, r, "/login?oauth=state")
		return
	}

	code := r.URL.Query().Get("code")
	if code == "" {
		h.redirectToApp(w, r, "/login?oauth=failed")
		return
	}

	profile, err := provider.Exchange(r.Context(), code, verifier)
	if err != nil {
		if errors.Is(err, oauth.ErrNoEmail) {
			h.redirectToApp(w, r, "/login?oauth=no_email")
			return
		}
		// Провайдер лежит или не уложился в таймаут. Колбэк — навигация
		// браузера, а не вызов API: отдать сюда JSON-ошибку значит оставить
		// человека на origin API без пути назад. Причина уходит в лог, человек —
		// на экран входа.
		h.logOAuthFailure(r, name, "exchange", err)
		h.redirectToApp(w, r, "/login?oauth=failed")
		return
	}

	_, token, err := h.oauthSvc.LoginWithIdentity(r.Context(), IdentityProfile{
		Provider:       name,
		ProviderUserID: profile.ID,
		Email:          profile.Email,
		FirstName:      profile.FirstName,
		LastName:       profile.LastName,
	})
	switch {
	case err == nil:
		h.startSession(w, token)
		h.redirectToApp(w, r, "/")
	case errors.Is(err, ErrPasswordLinkRequired):
		// Личность подтверждена провайдером, но доступ к аккаунту ещё не доказан.
		// Кладём её в подписанную cookie: без подписи фронт мог бы прислать в
		// /link любой provider_user_id и привязать к аккаунту чужую личность,
		// получив постоянный вход по чужому паролю.
		h.setFlowCookie(w, oauthPendingCookie, h.signPending(name, profile.ID))
		h.redirectToApp(w, r, "/link-account?provider="+name)
	case errors.Is(err, ErrProviderOnlyAccount):
		// Адрес занят аккаунтом, войти в который можно только через провайдера,
		// а пришли мы с другой личностью. Просить пароль бессмысленно — его нет.
		h.redirectToApp(w, r, "/login?oauth=provider_only")
	default:
		// Та же логика, что и на обмене кода: браузеру нужен экран, не JSON.
		h.logOAuthFailure(r, name, "login", err)
		h.redirectToApp(w, r, "/login?oauth=failed")
	}
}

// logOAuthFailure пишет причину отказа для человека за логом. Ни токена, ни
// email здесь нет: провайдер, стадия и текст ошибки — всё, что нужно для
// разбора, и всё, что можно (internal/CLAUDE.md).
func (h *Handler) logOAuthFailure(r *http.Request, provider, stage string, err error) {
	httpserver.LoggerFrom(r.Context()).Error("oauth login failed",
		slog.String("provider", provider),
		slog.String("stage", stage),
		slog.String("error", err.Error()))
}

type oauthLinkRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (h *Handler) oauthLink(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(oauthPendingCookie)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: привязка не начата или истекла", domain.ErrUnauthorized))
		return
	}
	name, providerUserID, ok := h.verifyPending(c.Value)
	if !ok {
		httpserver.WriteError(w, r, fmt.Errorf("%w: привязка не начата или истекла", domain.ErrUnauthorized))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req oauthLinkRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}

	user, token, err := h.oauthSvc.LinkIdentityWithPassword(r.Context(), req.Email, req.Password, name, providerUserID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	h.expireCookie(w, oauthPendingCookie, true)
	h.startSession(w, token)
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(user))
}

// redirectToApp уводит браузер на экран кабинета. Путь — всегда наш литерал,
// никогда не значение из запроса: параметр «куда вернуться» из URL — это
// готовый open redirect.
func (h *Handler) redirectToApp(w http.ResponseWriter, r *http.Request, path string) {
	http.Redirect(w, r, h.appOrigin+path, http.StatusFound)
}

func (h *Handler) setFlowCookie(w http.ResponseWriter, name, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(oauthFlowTTL.Seconds()),
	})
}

func (h *Handler) readFlowCookie(r *http.Request, name string) (first, second string, ok bool) {
	c, err := r.Cookie(name)
	if err != nil {
		return "", "", false
	}
	a, b, found := strings.Cut(c.Value, ":")
	if !found || a == "" || b == "" {
		return "", "", false
	}
	return a, b, true
}

// signPending подписывает «провайдер + личность + срок». Ключ — тот же
// FORM_TOKEN_SECRET, но сообщение начинается с метки назначения: без неё
// подпись из одного контекста теоретически принимается в другом.
func (h *Handler) signPending(provider, providerUserID string) string {
	payload := fmt.Sprintf("%s:%s:%d", provider, providerUserID, time.Now().Add(oauthFlowTTL).Unix())
	return payload + ":" + base64.RawURLEncoding.EncodeToString(h.pendingMAC(payload))
}

func (h *Handler) verifyPending(value string) (provider, providerUserID string, ok bool) {
	i := strings.LastIndex(value, ":")
	if i < 0 {
		return "", "", false
	}
	payload, sig := value[:i], value[i+1:]

	want, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(want, h.pendingMAC(payload)) {
		return "", "", false
	}

	parts := strings.Split(payload, ":")
	if len(parts) != 3 {
		return "", "", false
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || time.Now().After(time.Unix(exp, 0)) {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (h *Handler) pendingMAC(payload string) []byte {
	mac := hmac.New(sha256.New, h.pendingSecret)
	mac.Write([]byte("oauth-link:" + payload))
	return mac.Sum(nil)
}
