package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/oauth"
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
	RequestPasswordReset(ctx context.Context, email string) error
	ResetPassword(ctx context.Context, token, password string) error
	VerifyEmail(ctx context.Context, token string) error
	ResendVerification(ctx context.Context, user User) error
	UpdateProfile(ctx context.Context, userID uuid.UUID, firstName, lastName string) (User, error)
	ChangePassword(ctx context.Context, user User, currentPassword, newPassword string) (string, error)
	RequestEmailChange(ctx context.Context, user User, newEmail, currentPassword string) error
	ConfirmEmailChange(ctx context.Context, token string) error
	Identities(ctx context.Context, userID uuid.UUID) ([]Identity, error)
	UnlinkIdentity(ctx context.Context, user User, provider string) error
	TwoFactorEnabled(ctx context.Context, userID uuid.UUID) (bool, error)
	SetupTOTP(ctx context.Context, user User) (secret, otpauth string, err error)
	EnableTOTP(ctx context.Context, user User, code string) ([]string, error)
	DisableTOTP(ctx context.Context, user User, currentPassword, code string) error
	CompleteTwoFactorLogin(ctx context.Context, userID uuid.UUID, code string) (User, string, error)
	DeleteAccount(ctx context.Context, user User, currentPassword, code string) error
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
	// loginTwoFactorLimiter — ведро второго шага входа по АККАУНТУ (ключ — id из
	// подписанного пропуска). Ведро по IP на этом маршруте тоже висит, но
	// ограничивает не ту величину: код привязан к аккаунту, а не к адресу, и с
	// пула адресов перебор по IP не ограничен ничем. Не nil никогда — NewHandler
	// подставляет ведро логина, WithTwoFactorLogin меняет на своё.
	loginTwoFactorLimiter RateLimiter
	// Сброс пароля (слайс B). forgotIPLimiter/forgotEmailLimiter — два ведра на
	// /forgot-password: по IP (флуд с одного адреса) и по email (нельзя завалить
	// один почтовый ящик письмами, перебирая с разных IP). resetLimiter — по IP
	// на /reset-password (перебор токенов; заодно щит для argon2 на каждом вызове).
	forgotIPLimiter    RateLimiter
	forgotEmailLimiter RateLimiter
	resetLimiter       RateLimiter
	// Подтверждение email (слайс C). verifyLimiter — по IP на /verify-email (перебор
	// токенов). resendLimiter — по пользователю на /resend-verification (кнопка в
	// баннере не должна слать письма пачками).
	verifyLimiter RateLimiter
	resendLimiter RateLimiter
	// passwordChangeLimiter — по пользователю на POST /account/password (фаза 23).
	// Не от подбора (сессия уже своя), а от argon2id: 64 МиБ на вызов.
	passwordChangeLimiter RateLimiter
	// emailChangeLimiter — по пользователю на POST /account/email: письмо уходит
	// на ПРОИЗВОЛЬНЫЙ адрес, поэтому ведро строгое (нельзя завалить чужой ящик).
	// confirmEmailLimiter — по IP на публичный шаг подтверждения (перебор токенов).
	emailChangeLimiter  RateLimiter
	confirmEmailLimiter RateLimiter
	// twoFactorLimiter — по пользователю на включение/выключение второго
	// фактора: за выключением стоит argon2id и шестизначный код.
	twoFactorLimiter RateLimiter
	// deleteAccountLimiter — по пользователю на удаление аккаунта: за ручкой
	// argon2id и код второго фактора, а нажимают её один раз в жизни.
	deleteAccountLimiter RateLimiter

	cookieSecure bool
	// appOrigin — ожидаемый origin кабинета для проверки заголовка Origin в CSRF.
	appOrigin string
	// trustedProxy — стоим ли за доверенным прокси (влияет на извлечение IP клиента
	// для rate-limit'а, см. httpserver.ClientIP).
	trustedProxy bool

	// Вход через провайдеров (фаза 11). Реестр пуст — эндпоинты отдают 404.
	oauthSvc       oauthService
	oauthProviders oauthProviders
	// oauthLimiter — своё ведро на колбэк: он ходит во внешний сервис, и
	// долбить его чужими кодами не должно быть дешевле, чем логиниться.
	oauthLimiter RateLimiter
	// pendingSecret — ключ HMAC для подписи незавершённой привязки.
	pendingSecret []byte
}

func NewHandler(svc authService, loginLimiter, registerLimiter RateLimiter, cookieSecure bool, appOrigin string, trustedProxy bool) *Handler {
	return &Handler{
		svc:             svc,
		loginLimiter:    loginLimiter,
		registerLimiter: registerLimiter,
		// Ведро второго шага по умолчанию — ведро логина, только ключуемое
		// аккаунтом. Не «пока сойдёт»: третьим аргументом-лимитером подряд его
		// можно было бы перепутать местами с двумя соседями, а ноль вместо ведра
		// снял бы защиту молча. Прод ставит своё, более строгое, через
		// WithTwoFactorLogin.
		loginTwoFactorLimiter: loginLimiter,
		cookieSecure:          cookieSecure,
		appOrigin:             appOrigin,
		trustedProxy:          trustedProxy,
	}
}

// WithTwoFactorLogin подключает отдельное ведро второго шага входа — по
// аккаунту. Отдельным методом, а не аргументом NewHandler: см. комментарий там.
func (h *Handler) WithTwoFactorLogin(limiter RateLimiter) *Handler {
	h.loginTwoFactorLimiter = limiter
	return h
}

// WithPasswordReset подключает эндпоинты сброса пароля с их вёдрами лимита.
// Отдельный метод, а не ещё три аргумента в NewHandler: ведра параметризуют один
// узел, а не всю сборку хендлера.
func (h *Handler) WithPasswordReset(forgotIP, forgotEmail, reset RateLimiter) *Handler {
	h.forgotIPLimiter = forgotIP
	h.forgotEmailLimiter = forgotEmail
	h.resetLimiter = reset
	return h
}

// WithEmailVerification подключает эндпоинты подтверждения email с их вёдрами
// лимита (по образцу WithPasswordReset).
func (h *Handler) WithEmailVerification(verify, resend RateLimiter) *Handler {
	h.verifyLimiter = verify
	h.resendLimiter = resend
	return h
}

// AccountLimits — вёдра эндпоинтов настроек. Структурой, а не четырьмя
// аргументами одного типа подряд: перепутанные местами вёдра не дадут ни ошибки
// компиляции, ни падения теста — просто защита окажется не на той двери.
type AccountLimits struct {
	PasswordChange RateLimiter
	EmailChange    RateLimiter
	ConfirmEmail   RateLimiter
	TwoFactor      RateLimiter
	DeleteAccount  RateLimiter
}

// WithAccount подключает настройки аккаунта с их вёдрами лимита (по образцу
// WithPasswordReset). Без него AccountRoutes регистрировать нельзя — лимитеры
// будут nil.
func (h *Handler) WithAccount(l AccountLimits) *Handler {
	h.passwordChangeLimiter = l.PasswordChange
	h.emailChangeLimiter = l.EmailChange
	h.confirmEmailLimiter = l.ConfirmEmail
	h.twoFactorLimiter = l.TwoFactor
	h.deleteAccountLimiter = l.DeleteAccount
	return h
}

// WithOAuth включает вход через провайдеров. Отдельный конструктор, а не восемь
// аргументов в NewHandler: без ключей в окружении провайдеров нет вовсе, и
// парольный контур не должен об этом знать.
func (h *Handler) WithOAuth(svc oauthService, providers map[string]oauth.Provider, limiter RateLimiter, pendingSecret []byte) *Handler {
	h.oauthSvc = svc
	h.oauthProviders = providers
	h.oauthLimiter = limiter
	h.pendingSecret = pendingSecret
	return h
}

// Routes регистрирует эндпоинты auth на общем mux (RouteRegistrar).
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("POST /api/v1/auth/register", h.rateLimit(h.registerLimiter, "слишком много регистраций")(http.HandlerFunc(h.register)))
	mux.Handle("POST /api/v1/auth/login", h.rateLimit(h.loginLimiter, "слишком много попыток входа")(http.HandlerFunc(h.login)))
	// Второй шаг входа (слайс F) — под ведром ЛОГИНА по IP: иначе перебор
	// шестизначного кода переезжает на менее защищённую дверь. Второе ведро, по
	// аккаунту, стоит внутри хендлера: ключ появляется только после разбора
	// пропуска, а ограничивать надо именно попытки по аккаунту.
	mux.Handle("POST /api/v1/auth/login-2fa", h.rateLimit(h.loginLimiter, "слишком много попыток входа")(http.HandlerFunc(h.loginTwoFactor)))
	mux.Handle("POST /api/v1/auth/logout", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.logout))))
	mux.Handle("GET /api/v1/auth/me", h.RequireAuth(http.HandlerFunc(h.me)))
	// Сброс пароля — публичные (сессии ещё/уже нет): CSRF не нужен (как login/
	// register), аутентификация самим одноразовым токеном. Защита — rate-limit.
	mux.Handle("POST /api/v1/auth/forgot-password", h.rateLimit(h.forgotIPLimiter, "слишком много запросов сброса")(http.HandlerFunc(h.forgotPassword)))
	mux.Handle("POST /api/v1/auth/reset-password", h.rateLimit(h.resetLimiter, "слишком много попыток сброса")(http.HandlerFunc(h.resetPassword)))
	// Подтверждение email (слайс C). verify-email — публичный (ссылку открывают и
	// без сессии): аутентификация одноразовым токеном, CSRF не нужен, щит —
	// rate-limit по IP. resend-verification — за сессией и CSRF (действие текущего
	// пользователя), лимит по пользователю проверяется внутри хендлера.
	mux.Handle("POST /api/v1/auth/verify-email", h.rateLimit(h.verifyLimiter, "слишком много попыток подтверждения")(http.HandlerFunc(h.verifyEmail)))
	mux.Handle("POST /api/v1/auth/resend-verification", h.RequireAuth(h.RequireCSRF(http.HandlerFunc(h.resendVerification))))
}

type credentialsRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type userResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	// EmailVerified — подтверждён ли адрес (слайс C). Кабинет по нему рисует баннер
	// «подтвердите email». Выводится из nullable users.email_verified_at.
	EmailVerified bool `json:"emailVerified"`
	// FirstName/LastName — имя человека (фаза 23). Пустая строка = не указано:
	// null и "" на границе не различаются, а внутри различаются (0021), поэтому
	// приведение делается здесь, в одном месте.
	FirstName string `json:"firstName"`
	LastName  string `json:"lastName"`
	// HasPassword — есть ли у аккаунта пароль вообще (у заведённого через
	// провайдера его нет). Кабинету это нужно, чтобы решить, спрашивать ли
	// текущий пароль и как назвать раздел: «Сменить пароль» или «Задать».
	// Наружу едет ФАКТ, а не хеш.
	HasPassword bool `json:"hasPassword"`
	// TwoFactorEnabled — включён ли второй фактор (фаза 23, слайс F).
	TwoFactorEnabled bool `json:"twoFactorEnabled"`
}

// toUserResponse принимает флаг второго фактора отдельным аргументом: он живёт
// в другой таблице, и подмешивать ради него запрос в каждый ответ auth не за
// чем — там, где ответ выдаётся сразу после входа, значение известно и так.
func toUserResponse(u User, twoFactorEnabled bool) userResponse {
	return userResponse{
		ID:            u.ID.String(),
		Email:         u.Email,
		EmailVerified: u.EmailVerifiedAt != nil,
		FirstName:     strOrEmpty(u.FirstName),
		LastName:      strOrEmpty(u.LastName),
		HasPassword:   u.PasswordHash != nil,

		TwoFactorEnabled: twoFactorEnabled,
	}
}

func strOrEmpty(v *string) string {
	if v == nil {
		return ""
	}
	return *v
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
	httpserver.WriteJSON(w, r, http.StatusCreated, toUserResponse(user, false))
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeCredentials(w, r)
	if !ok {
		return
	}
	user, token, err := h.svc.Login(r.Context(), req.Email, req.Password)
	if errors.Is(err, ErrTwoFactorRequired) {
		// Пароль верен, но входа ещё нет: сессия не выдаётся, ставится
		// подписанный пропуск на второй шаг. Тело говорит фронту, куда идти.
		h.startTwoFactorChallenge(w, user.ID)
		httpserver.WriteJSON(w, r, http.StatusOK, map[string]bool{"twoFactorRequired": true})
		return
	}
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	h.startSession(w, token)
	// Сюда доходит только вход БЕЗ второго фактора: с включённым мы ушли бы в
	// ветку выше, не выдав сессии.
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(user, false))
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
	// Второй фактор живёт в своей таблице, поэтому здесь отдельный запрос: это
	// профиль, его читают редко, и экран настроек берёт флаг именно отсюда.
	twoFactor, err := h.svc.TwoFactorEnabled(r.Context(), user.ID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toUserResponse(user, twoFactor))
}

type forgotPasswordRequest struct {
	Email string `json:"email"`
}

func (h *Handler) forgotPassword(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req forgotPasswordRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	// Второе ведро — по email (первое, по IP, сработало в middleware): нельзя
	// завалить один ящик письмами, перебирая с разных адресов. Ключ нормализован
	// так же, как в сервисе, чтобы «A@x» и «a@x » считались одним адресатом.
	emailKey := strings.ToLower(strings.TrimSpace(req.Email))
	if !h.forgotEmailLimiter.Allow(emailKey) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много запросов на этот адрес", domain.ErrRateLimited))
		return
	}
	// Ответ одинаков, есть аккаунт или нет (существование не раскрываем): «нет
	// пользователя» сервис возвращает как nil. Ненулевая ошибка — инфраструктурная
	// (БД недоступна); молчать о ней хуже, чем ответить 500.
	if err := h.svc.RequestPasswordReset(r.Context(), req.Email); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type resetPasswordRequest struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

func (h *Handler) resetPassword(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req resetPasswordRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	if err := h.svc.ResetPassword(r.Context(), req.Token, req.Password); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Автологина нет: сессии после сброса мертвы, отправляем пользователя на вход.
	w.WriteHeader(http.StatusNoContent)
}

type verifyEmailRequest struct {
	Token string `json:"token"`
}

func (h *Handler) verifyEmail(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req verifyEmailRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	if err := h.svc.VerifyEmail(r.Context(), req.Token); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) resendVerification(w http.ResponseWriter, r *http.Request) {
	user, ok := UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return
	}
	// Лимит по пользователю (не по IP): ключ есть только после RequireAuth, а
	// защищаем мы почтовый ящик пользователя от шквала писем по кнопке.
	if !h.resendLimiter.Allow(user.ID.String()) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком много запросов подтверждения", domain.ErrRateLimited))
		return
	}
	// Уже подтверждённому сервис вернёт nil без письма — ответ одинаков (204),
	// клиенту незачем знать, ушло письмо или нет.
	if err := h.svc.ResendVerification(r.Context(), user); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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

// rateLimit — жёсткий лимит по IP заданным ведром. Обёртка общая
// (httpserver.RateLimitByIP) — здесь только подстановка trustedProxy, чтобы не
// таскать его по всем строкам Routes.
func (h *Handler) rateLimit(limiter RateLimiter, msg string) func(http.Handler) http.Handler {
	return httpserver.RateLimitByIP(limiter, h.trustedProxy, msg)
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
