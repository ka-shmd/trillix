package integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/oauth"
)

const (
	// stateCookie держит state и code_verifier между уходом к провайдеру и
	// возвратом. HttpOnly; SameSite=Lax обязателен, чтобы cookie доехала на
	// top-level GET-редиректе с домена Google (Strict её не отдаст).
	stateCookie = "integration_state"
	// intentCookie несёт подписанное «этот поход начат ВОТ ЭТИМ человеком для
	// ВОТ ЭТОГО пространства». Ставится только эндпоинтом за RequireAuth — в
	// этом вся защита: пространство в параметре колбэка означало бы, что жертву
	// можно заманить пройти согласие и подключить свой Google к чужому
	// пространству, получив поток чужих ответов себе на Диск.
	intentCookie = "integration_intent"
	// intentLabel — метка назначения подписи. Ключ общий (FORM_TOKEN_SECRET), и
	// без метки подпись из одного контекста принималась бы в другом.
	intentLabel = "integration-connect:"
	// Человек уходит к провайдеру и возвращается — это минуты, не часы.
	flowTTL = 15 * time.Minute
)

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// хендлер: тот же приём, что в forms и answerfiles.
type Middleware = func(http.Handler) http.Handler

// integrationsService — то, что транспорту нужно от сервиса.
type integrationsService interface {
	Status(ctx context.Context, userID, workspaceID uuid.UUID) (Status, error)
	StartURL(ctx context.Context, userID, workspaceID uuid.UUID, state, verifier string) (string, error)
	Connect(ctx context.Context, userID, workspaceID uuid.UUID, code, verifier string) error
	Disconnect(ctx context.Context, userID, workspaceID uuid.UUID) error
}

// Handler — приватный транспорт интеграций.
type Handler struct {
	svc          integrationsService
	requireAuth  Middleware
	requireCSRF  Middleware
	appOrigin    string
	cookieSecure bool
	// secret — ключ подписи намерения (FORM_TOKEN_SECRET). Не логируется.
	secret []byte
}

func NewHandler(svc integrationsService, requireAuth, requireCSRF Middleware, appOrigin string, cookieSecure bool, secret []byte) *Handler {
	return &Handler{
		svc:          svc,
		requireAuth:  requireAuth,
		requireCSRF:  requireCSRF,
		appOrigin:    appOrigin,
		cookieSecure: cookieSecure,
		secret:       secret,
	}
}

// Routes регистрирует приватные эндпоинты. Адреса — по пространству, а не по
// форме: подключённый аккаунт принадлежит пространству (ADR §10), и адрес по
// форме означал бы, что отключение одной формы гасит интеграцию у соседних.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/workspaces/{id}/integrations",
		h.requireAuth(http.HandlerFunc(h.status)))
	mux.Handle("GET /api/v1/workspaces/{id}/integrations/google/start",
		h.requireAuth(http.HandlerFunc(h.start)))
	// Колбэк без RequireAuth: сюда возвращается браузер по редиректу Google, и
	// JSON-ошибка 401 в окне 560×680 оставила бы человека на origin API без
	// пути назад. Доказательство намерения — подписанная HttpOnly-cookie, а
	// право на пространство сервис всё равно проверяет заново (Connect).
	mux.Handle("GET /api/v1/integrations/google/callback", http.HandlerFunc(h.callback))
	mux.Handle("DELETE /api/v1/workspaces/{id}/integrations/google",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.disconnect))))
}

type statusResponse struct {
	Enabled     bool    `json:"enabled"`
	Connected   bool    `json:"connected"`
	Email       string  `json:"email,omitempty"`
	ConnectedAt *string `json:"connectedAt,omitempty"`
	CanManage   bool    `json:"canManage"`
}

func (h *Handler) status(w http.ResponseWriter, r *http.Request) {
	user, wsID, ok := h.userAndWorkspace(w, r)
	if !ok {
		return
	}

	st, err := h.svc.Status(r.Context(), user.ID, wsID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	resp := statusResponse{Enabled: st.Enabled, Connected: st.Connected, Email: st.Email, CanManage: st.CanManage}
	if st.Connected {
		at := st.ConnectedAt.UTC().Format(time.RFC3339)
		resp.ConnectedAt = &at
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

func (h *Handler) start(w http.ResponseWriter, r *http.Request) {
	user, wsID, ok := h.userAndWorkspace(w, r)
	if !ok {
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

	url, err := h.svc.StartURL(r.Context(), user.ID, wsID, state, verifier)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	h.setFlowCookie(w, stateCookie, state+":"+verifier)
	h.setFlowCookie(w, intentCookie, h.signIntent(user.ID, wsID))
	http.Redirect(w, r, url, http.StatusFound)
}

func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	// Обе cookie одноразовые: гасим их до любого ответа. Через defer было бы
	// нельзя — http.Redirect к тому моменту уже записал заголовки, и Set-Cookie
	// не уехал бы, оставив state жить все 15 минут TTL.
	h.expireCookie(w, stateCookie)
	userID, wsID, haveIntent := h.readIntent(r)
	h.expireCookie(w, intentCookie)

	// Человек нажал «Отклонить» на экране согласия — это не авария.
	if r.URL.Query().Get("error") != "" {
		h.finish(w, r, outcomeDenied)
		return
	}
	if !haveIntent {
		h.finish(w, r, outcomeExpired)
		return
	}

	state, verifier, ok := h.readFlowCookie(r, stateCookie)
	if !ok {
		h.finish(w, r, outcomeExpired)
		return
	}
	// Сверка state — защита от CSRF: без неё чужой код можно подсунуть человеку
	// и подключить к его пространству аккаунт атакующего.
	if subtle.ConstantTimeCompare([]byte(state), []byte(r.URL.Query().Get("state"))) != 1 {
		h.finish(w, r, outcomeExpired)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		h.finish(w, r, outcomeFailed)
		return
	}

	err := h.svc.Connect(r.Context(), userID, wsID, code, verifier)
	switch {
	case err == nil:
		h.finish(w, r, outcomeOK)
	case errors.Is(err, ErrScopeDenied), errors.Is(err, ErrNoRefreshToken):
		// Оба — про то, ЧТО человек разрешил на экране согласия, а не про сбой.
		h.finish(w, r, outcomeDenied)
	case errors.Is(err, domain.ErrForbidden), errors.Is(err, domain.ErrNotFound):
		h.finish(w, r, outcomeForbidden)
	default:
		// Колбэк — навигация браузера, а не вызов API: JSON-ошибка оставила бы
		// человека на origin API без пути назад. Причина уходит в лог.
		httpserver.LoggerFrom(r.Context()).Error("integration connect failed",
			slog.String("provider", "google"),
			slog.String("error", err.Error()))
		h.finish(w, r, outcomeFailed)
	}
}

func (h *Handler) disconnect(w http.ResponseWriter, r *http.Request) {
	user, wsID, ok := h.userAndWorkspace(w, r)
	if !ok {
		return
	}
	if err := h.svc.Disconnect(r.Context(), user.ID, wsID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// userAndWorkspace достаёт из запроса того, кто спрашивает, и пространство из
// адреса. Неразбираемый id → 404 (несуществующее пространство, без раскрытия),
// а не 400: право доступа к нему всё равно проверяется дальше.
func (h *Handler) userAndWorkspace(w http.ResponseWriter, r *http.Request) (auth.User, uuid.UUID, bool) {
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return auth.User{}, uuid.Nil, false
	}
	wsID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return auth.User{}, uuid.Nil, false
	}
	return user, wsID, true
}

// outcome — чем кончился поход за согласием. Перечень закрытый и зеркалится
// oauthOutcomeSchema в web/app/src/features/auth/oauthPopup.ts: окно передаёт
// код вкладке-опекуну, вкладка выбирает по нему текст. Разъедутся перечни —
// подключение начнёт тихо заканчиваться «не удалось».
type outcome string

const (
	outcomeOK        outcome = "integration_ok"
	outcomeDenied    outcome = "integration_denied"
	outcomeExpired   outcome = "integration_expired"
	outcomeForbidden outcome = "integration_forbidden"
	outcomeFailed    outcome = "integration_failed"
)

// finish возвращает браузер из колбэка на служебный экран отдельного окна — тот
// же /oauth/done, что у входа: окно сообщает исход опекуну и закрывается.
// Путь — всегда наш литерал, никогда не значение из запроса: параметр «куда
// вернуться» из URL — это готовый open redirect.
func (h *Handler) finish(w http.ResponseWriter, r *http.Request, o outcome) {
	http.Redirect(w, r, h.appOrigin+"/oauth/done?r="+string(o), http.StatusFound)
}

func (h *Handler) setFlowCookie(w http.ResponseWriter, name, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(flowTTL.Seconds()),
	})
}

func (h *Handler) expireCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   h.cookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
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

// signIntent подписывает «кто и для какого пространства начал поход» со сроком.
func (h *Handler) signIntent(userID, workspaceID uuid.UUID) string {
	payload := fmt.Sprintf("%s:%s:%d", userID, workspaceID, time.Now().Add(flowTTL).Unix())
	return payload + ":" + base64.RawURLEncoding.EncodeToString(h.intentMAC(payload))
}

// readIntent достаёт намерение из запроса. Битая подпись, истёкший срок и
// отсутствие cookie неразличимы снаружи — все они означают «похода не было».
func (h *Handler) readIntent(r *http.Request) (userID, workspaceID uuid.UUID, ok bool) {
	c, err := r.Cookie(intentCookie)
	if err != nil {
		return uuid.Nil, uuid.Nil, false
	}
	i := strings.LastIndex(c.Value, ":")
	if i < 0 {
		return uuid.Nil, uuid.Nil, false
	}
	payload, sig := c.Value[:i], c.Value[i+1:]
	want, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(want, h.intentMAC(payload)) {
		return uuid.Nil, uuid.Nil, false
	}

	parts := strings.Split(payload, ":")
	if len(parts) != 3 {
		return uuid.Nil, uuid.Nil, false
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || time.Now().After(time.Unix(exp, 0)) {
		return uuid.Nil, uuid.Nil, false
	}
	userID, err = uuid.Parse(parts[0])
	if err != nil {
		return uuid.Nil, uuid.Nil, false
	}
	workspaceID, err = uuid.Parse(parts[1])
	if err != nil {
		return uuid.Nil, uuid.Nil, false
	}
	return userID, workspaceID, true
}

func (h *Handler) intentMAC(payload string) []byte {
	mac := hmac.New(sha256.New, h.secret)
	mac.Write([]byte(intentLabel + payload))
	return mac.Sum(nil)
}
