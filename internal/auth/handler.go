package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/httpserver"
)

const (
	sessionCookieName = "session"
	csrfCookieName    = "csrf_token"
	csrfHeaderName    = "X-CSRF-Token"

	maxAuthBodyBytes = 4 << 10 // 4 КБ — тело auth-запроса крошечное
	csrfTokenBytes   = 32
)

// authService — интерфейс сервиса, нужный транспорту (объявлен на стороне
// потребителя; реализация — *Service, в тестах — фейк).
type authService interface {
	Register(ctx context.Context, email, password string) (User, string, error)
	Login(ctx context.Context, email, password string) (User, string, error)
	Logout(ctx context.Context, token string) error
	UserByToken(ctx context.Context, token string) (User, error)
}

// RateLimiter — лимитер, нужный auth (жёсткий по IP на логин). Реализация —
// ratelimit.TokenBucket; в тестах инжектируется пермиссивный (инвариант 6).
type RateLimiter interface {
	Allow(key string) bool
}

type ctxKey int

const ctxKeyUser ctxKey = iota

// UserFromContext возвращает пользователя, положенного RequireAuth.
func UserFromContext(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(ctxKeyUser).(User)
	return u, ok
}

// Handler — HTTP-транспорт модуля auth.
type Handler struct {
	svc          authService
	loginLimiter RateLimiter
	// registerLimiter — отдельное ведро на POST /auth/register (argon2id — 64 МиБ на
	// вызов; отдельное от логина, чтобы брутфорс логина не съедал бюджет регистрации).
	registerLimiter RateLimiter
	cookieSecure    bool
	// appOrigin — ожидаемый origin кабинета для проверки заголовка Origin в CSRF.
	appOrigin string
	// trustedProxy — стоим ли за доверенным прокси (влияет на извлечение IP клиента
	// для rate-limit'а, см. httpserver.ClientIP).
	trustedProxy bool
}

func NewHandler(svc authService, loginLimiter, registerLimiter RateLimiter, cookieSecure bool, appOrigin string, trustedProxy bool) *Handler {
	return &Handler{svc: svc, loginLimiter: loginLimiter, registerLimiter: registerLimiter, cookieSecure: cookieSecure, appOrigin: appOrigin, trustedProxy: trustedProxy}
}

// Routes регистрирует эндпоинты auth на общем mux (RouteRegistrar).
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/auth/register", h.rateLimit(h.registerLimiter, "слишком много регистраций")(http.HandlerFunc(h.register)))
	mux.Handle("POST /api/v1/auth/login", h.rateLimit(h.loginLimiter, "слишком много попыток входа")(http.HandlerFunc(h.login)))
	mux.Handle("POST /api/v1/auth/logout", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.logout))))
	mux.Handle("GET /api/v1/auth/me", h.RequireAuth(http.HandlerFunc(h.me)))
}

type credentialsRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type userResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeCredentials(w, r)
	if !ok {
		return
	}
	user, token, err := h.svc.Register(r.Context(), req.Email, req.Password)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	h.startSession(w, token)
	httpserver.WriteJSON(w, r, http.StatusCreated, userResponse{ID: user.ID.String(), Email: user.Email})
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeCredentials(w, r)
	if !ok {
		return
	}
	user, token, err := h.svc.Login(r.Context(), req.Email, req.Password)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	h.startSession(w, token)
	httpserver.WriteJSON(w, r, http.StatusOK, userResponse{ID: user.ID.String(), Email: user.Email})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookieName); err == nil {
		if err := h.svc.Logout(r.Context(), c.Value); err != nil {
			httpserver.WriteError(w, r, err)
			return
		}
	}
	h.clearSession(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, userResponse{ID: user.ID.String(), Email: user.Email})
}

// RequireAuth пропускает запрос только с живой сессией, кладя пользователя в
// контекст. Промах — 401 (не 403): факт существования ресурса не раскрывается.
// Экспортирован для переиспользования другими модулями (forms и далее): их
// приватные роуты оборачиваются этим middleware, а пользователя достают из
// контекста через UserFromContext.
func (h *Handler) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(sessionCookieName)
		if err != nil {
			httpserver.WriteError(w, r, domain.ErrUnauthorized)
			return
		}
		user, err := h.svc.UserByToken(r.Context(), c.Value)
		if err != nil {
			httpserver.WriteError(w, r, err)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKeyUser, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// RequireCSRF защищает мутации двумя механизмами. (1) Проверка Origin: если
// браузер прислал заголовок Origin, он обязан точно совпасть с origin кабинета
// (h.appOrigin) — чужой origin отклоняется до сверки токена. Пустой Origin (редкие
// клиенты, не выставляющие его) проходит на double-submit. (2) Double-submit:
// заголовок X-CSRF-Token обязан совпасть с cookie csrf_token (её значение читаемо
// JS, но кросс-доменно недоступно из-за SOP). Вместе с SameSite=Lax на cookie
// сессии это перекрывает CSRF со всех сторон. Экспортирован для мутаций других
// модулей (POST/PATCH/DELETE forms).
func (h *Handler) RequireCSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && origin != h.appOrigin {
			httpserver.WriteError(w, r, fmt.Errorf("%w: недопустимый Origin", domain.ErrForbidden))
			return
		}
		cookie, err := r.Cookie(csrfCookieName)
		header := r.Header.Get(csrfHeaderName)
		if err != nil || header == "" ||
			subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(header)) != 1 {
			httpserver.WriteError(w, r, fmt.Errorf("%w: неверный CSRF-токен", domain.ErrForbidden))
			return
		}
		next.ServeHTTP(w, r)
	})
}

// rateLimit — middleware жёсткого лимита по IP заданным ведром. Ключ — честный IP
// клиента (см. httpserver.ClientIP). msg уходит в тело 429 после стандартного
// префикса ErrRateLimited.
func (h *Handler) rateLimit(limiter RateLimiter, msg string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !limiter.Allow(httpserver.ClientIP(r, h.trustedProxy)) {
				w.Header().Set("Retry-After", "60")
				httpserver.WriteError(w, r, fmt.Errorf("%w: %s", domain.ErrRateLimited, msg))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func decodeCredentials(w http.ResponseWriter, r *http.Request) (credentialsRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	var req credentialsRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return credentialsRequest{}, false
	}
	return req, true
}

func (h *Handler) startSession(w http.ResponseWriter, token string) {
	h.setCookie(w, sessionCookieName, token, true)
	h.setCookie(w, csrfCookieName, newCSRFToken(), false)
}

func (h *Handler) clearSession(w http.ResponseWriter) {
	h.expireCookie(w, sessionCookieName, true)
	h.expireCookie(w, csrfCookieName, false)
}

func (h *Handler) setCookie(w http.ResponseWriter, name, value string, httpOnly bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: httpOnly,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(DefaultSessionTTL.Seconds()),
	})
}

func (h *Handler) expireCookie(w http.ResponseWriter, name string, httpOnly bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: httpOnly,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

func newCSRFToken() string {
	b := make([]byte, csrfTokenBytes)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Errorf("auth: read csrf token: %w", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
