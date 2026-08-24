package integrations

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
	// maxBodyBytes — потолок тела запроса настроек (инвариант 3: MaxBytesReader
	// на каждом эндпоинте с телом). Там имя связки и id таблицы — сотни байт.
	maxBodyBytes = 4 << 10
)

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// хендлер: тот же приём, что в forms и answerfiles.
type Middleware = func(http.Handler) http.Handler

// integrationsService — то, что транспорту нужно от сервиса.
type integrationsService interface {
	FormStatus(ctx context.Context, userID, formID uuid.UUID) (FormStatus, error)
	ConnectForm(ctx context.Context, userID, formID uuid.UUID, opts ConnectOptions) (FormLink, error)
	Spreadsheets(ctx context.Context, userID, formID uuid.UUID) ([]SpreadsheetRef, error)
	Sheets(ctx context.Context, userID, formID uuid.UUID, spreadsheetID string) ([]SheetRef, error)
	Picker(ctx context.Context, userID, formID uuid.UUID) (PickerCredentials, error)
	DisconnectForm(ctx context.Context, userID, formID, linkID uuid.UUID) error
	RefillForm(ctx context.Context, userID, formID, linkID uuid.UUID) error
	UpdateConnection(ctx context.Context, userID, formID, linkID uuid.UUID, patch ConnectionPatch) error
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
	// Экран интеграций живёт у ФОРМЫ, поэтому и читается одной поездкой по её
	// адресу: пространство формы резолвит сервер. Иначе кабинет обязан был бы
	// сначала узнать, в каком пространстве лежит форма, — второй запрос ради
	// того, что сервер и так знает.
	mux.Handle("GET /api/v1/forms/{id}/integrations",
		h.requireAuth(http.HandlerFunc(h.formStatus)))
	// Список таблиц для окна настроек: только созданные нами (scope drive.file),
	// поэтому чужих файлов Диска он не раскрывает.
	mux.Handle("GET /api/v1/forms/{id}/integrations/google/spreadsheets",
		h.requireAuth(http.HandlerFunc(h.spreadsheets)))
	// Credentials окна выбора файла на Диске. Отдельной ручкой, а не в состоянии:
	// в ответе живой access-токен Google, и раздавать его на каждый показ таба
	// нельзя — только по нажатию кнопки выбора.
	// Листы выбранной книги — второй шаг выбора. Книга приезжает параметром, а не
	// сегментом пути: её id — чужая строка произвольного вида, и в пути он
	// требовал бы экранирования на каждом клиенте.
	mux.Handle("GET /api/v1/forms/{id}/integrations/google/sheets",
		h.requireAuth(http.HandlerFunc(h.sheets)))
	mux.Handle("GET /api/v1/forms/{id}/integrations/google/picker",
		h.requireAuth(http.HandlerFunc(h.picker)))
	mux.Handle("POST /api/v1/forms/{id}/integrations/google",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.connectForm))))
	// Операции над ОДНОЙ связкой адресуются её id: связок у формы сколько
	// угодно, и «отвязать интеграцию формы» перестало быть однозначным.
	mux.Handle("PATCH /api/v1/forms/{id}/integrations/{connectionId}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.updateConnection))))
	mux.Handle("POST /api/v1/forms/{id}/integrations/{connectionId}/refill",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.refillForm))))
	mux.Handle("DELETE /api/v1/forms/{id}/integrations/{connectionId}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.disconnectForm))))
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

type accountResponse struct {
	Enabled bool `json:"enabled"`
	// PickerEnabled — настроено ли окно выбора файла на Диске (нужен отдельный
	// API-key). Экран рисует по нему кнопку выбора.
	PickerEnabled bool `json:"pickerEnabled"`
	Connected     bool `json:"connected"`
	// NeedsReconnect — подключение есть, но пользоваться им нельзя: refresh-токен
	// не расшифровывается ключом контура (ротация FORM_TOKEN_SECRET). Экран
	// обязан сказать «подключите заново», а не рисовать зелёное «подключено».
	NeedsReconnect bool    `json:"needsReconnect"`
	Email          string  `json:"email,omitempty"`
	ConnectedAt    *string `json:"connectedAt,omitempty"`
	CanManage      bool    `json:"canManage"`
}

// sheetResponse — привязка формы. Отдельным объектом (а не полями вперемешку с
// аккаунтом), потому что это два независимых состояния: аккаунт может быть
// подключён без единой привязанной формы, и экран показывает разные вещи.
type sheetResponse struct {
	ID  string `json:"id"`
	URL string `json:"url"`
	// SpreadsheetID и SheetID — текущая цель. Экран правки открывается тем же
	// окном, что и подключение, и обязан показать в полях то, что уже выбрано.
	SpreadsheetID   string  `json:"spreadsheetId"`
	SheetID         int32   `json:"sheetId"`
	Enabled         bool    `json:"enabled"`
	Name            string  `json:"name,omitempty"`
	Status          string  `json:"status"`
	LastError       string  `json:"lastError,omitempty"`
	LastDeliveredAt *string `json:"lastDeliveredAt,omitempty"`
}

type formStatusResponse struct {
	WorkspaceID string          `json:"workspaceId"`
	Account     accountResponse `json:"account"`
	// Connections — подключённые связки формы. Пустой список — не ошибка, а
	// состояние экрана: у формы просто нет интеграций.
	Connections []sheetResponse `json:"connections"`
}

func (h *Handler) formStatus(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}

	st, err := h.svc.FormStatus(r.Context(), user.ID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	resp := formStatusResponse{
		WorkspaceID: st.WorkspaceID.String(),
		Account: accountResponse{
			Enabled:        st.Account.Enabled,
			PickerEnabled:  st.Account.PickerEnabled,
			Connected:      st.Account.Connected,
			NeedsReconnect: st.Account.NeedsReconnect,
			Email:          st.Account.Email,
			CanManage:      st.Account.CanManage,
		},
	}
	if st.Account.Connected {
		at := st.Account.ConnectedAt.UTC().Format(time.RFC3339)
		resp.Account.ConnectedAt = &at
	}
	resp.Connections = make([]sheetResponse, 0, len(st.Connections))
	for _, link := range st.Connections {
		resp.Connections = append(resp.Connections, *toSheetResponse(link))
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

// connectRequest — настройки из окна подключения. Тело необязательно: без него
// работают умолчания (новая таблица, перенос включён) — так же, как в окне.
type connectRequest struct {
	Name string `json:"name"`
	// SpreadsheetID пуст — новая книга; иначе работаем в названной.
	SpreadsheetID string `json:"spreadsheetId"`
	// SheetID — существующий лист книги; отсутствует = завести новый.
	// Указатель: у первого листа книги gid равен нулю.
	SheetID *int32 `json:"sheetId"`
	// Backfill — указатель, чтобы отличить «выключил тумблер» от «поля нет».
	Backfill *bool `json:"backfill"`
}

func (h *Handler) connectForm(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}

	opts := ConnectOptions{Backfill: true}
	if r.ContentLength != 0 {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		var req connectRequest
		if err := dec.Decode(&req); err != nil {
			httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
			return
		}
		opts.Name, opts.SpreadsheetID, opts.SheetID = req.Name, req.SpreadsheetID, req.SheetID
		if req.Backfill != nil {
			opts.Backfill = *req.Backfill
		}
	}

	link, err := h.svc.ConnectForm(r.Context(), user.ID, formID, opts)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toSheetResponse(link))
}

type sheetRefResponse struct {
	ID    int32  `json:"id"`
	Title string `json:"title"`
}

func (h *Handler) sheets(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}

	list, err := h.svc.Sheets(r.Context(), user.ID, formID, r.URL.Query().Get("spreadsheetId"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	out := make([]sheetRefResponse, 0, len(list))
	for _, sh := range list {
		out = append(out, sheetRefResponse(sh))
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string][]sheetRefResponse{"sheets": out})
}

type pickerResponse struct {
	AccessToken  string `json:"accessToken"`
	DeveloperKey string `json:"developerKey"`
	AppID        string `json:"appId"`
}

func (h *Handler) picker(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}

	cred, err := h.svc.Picker(r.Context(), user.ID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Учётные данные: промежуточный кэш, сохранивший ответ, раздавал бы чужой
	// токен (тот же довод, что у подписи скачивания файла ответа).
	w.Header().Set("Cache-Control", "no-store")
	// Конверсия, а не сборка по полю: DTO намеренно повторяет тип сервиса.
	httpserver.WriteJSON(w, r, http.StatusOK, pickerResponse(cred))
}

type spreadsheetResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (h *Handler) spreadsheets(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}

	list, err := h.svc.Spreadsheets(r.Context(), user.ID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Конверсия, а не сборка по полю: DTO намеренно повторяет тип сервиса, и
	// компилятор ловит расхождение в тот момент, когда оно появится.
	out := make([]spreadsheetResponse, 0, len(list))
	for _, s := range list {
		out = append(out, spreadsheetResponse(s))
	}
	httpserver.WriteJSON(w, r, http.StatusOK, map[string][]spreadsheetResponse{"spreadsheets": out})
}

// connectionRequest — правка связки с того же экрана, на котором её подключали:
// подпись, тумблер и цель.
//
// spreadsheetId отсутствует в теле — цель не трогаем вовсе (так шлёт тумблер из
// списка). Присутствует и отличается от текущей — связка переезжает.
type connectionRequest struct {
	Name          string  `json:"name"`
	Enabled       *bool   `json:"enabled"`
	SpreadsheetID *string `json:"spreadsheetId"`
	SheetID       *int32  `json:"sheetId"`
	Backfill      *bool   `json:"backfill"`
}

func (h *Handler) updateConnection(w http.ResponseWriter, r *http.Request) {
	user, formID, linkID, ok := h.userFormConnection(w, r)
	if !ok {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req connectionRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	// Тумблер не назван — связка остаётся включённой: правка подписи не должна
	// исподтишка что-то выключать.
	patch := ConnectionPatch{
		Name:       req.Name,
		Enabled:    req.Enabled == nil || *req.Enabled,
		KeepTarget: req.SpreadsheetID == nil,
	}
	if req.SpreadsheetID != nil {
		patch.Target = ConnectOptions{
			SpreadsheetID: *req.SpreadsheetID,
			SheetID:       req.SheetID,
			Backfill:      req.Backfill != nil && *req.Backfill,
		}
	}

	if err := h.svc.UpdateConnection(r.Context(), user.ID, formID, linkID, patch); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// userFormConnection достаёт спрашивающего, форму и связку из адреса.
func (h *Handler) userFormConnection(w http.ResponseWriter, r *http.Request) (auth.User, uuid.UUID, uuid.UUID, bool) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return auth.User{}, uuid.Nil, uuid.Nil, false
	}
	linkID, err := uuid.Parse(r.PathValue("connectionId"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return auth.User{}, uuid.Nil, uuid.Nil, false
	}
	return user, formID, linkID, true
}

// refillForm перезаливает лист заново. 202, а не 204: работа начата, а не
// сделана — перенос идёт пачками в фоне, и экран показывает его статусом.
func (h *Handler) refillForm(w http.ResponseWriter, r *http.Request) {
	user, formID, linkID, ok := h.userFormConnection(w, r)
	if !ok {
		return
	}
	if err := h.svc.RefillForm(r.Context(), user.ID, formID, linkID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *Handler) disconnectForm(w http.ResponseWriter, r *http.Request) {
	user, formID, linkID, ok := h.userFormConnection(w, r)
	if !ok {
		return
	}
	if err := h.svc.DisconnectForm(r.Context(), user.ID, formID, linkID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func toSheetResponse(l FormLink) *sheetResponse {
	out := &sheetResponse{
		ID:            l.ID.String(),
		URL:           l.SpreadsheetURL,
		SpreadsheetID: l.SpreadsheetID,
		SheetID:       l.SheetID,
		Enabled:       l.Enabled,
		Name:          l.Name,
		Status:        l.Status,
		LastError:     l.LastError,
	}
	if !l.LastDeliveredAt.IsZero() {
		at := l.LastDeliveredAt.UTC().Format(time.RFC3339)
		out.LastDeliveredAt = &at
	}
	return out
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

// userAndForm — то же для адресов по форме. Неразбираемый id → 404: право на
// форму всё равно проверяет сервис, и «битый uuid» не заслуживает отдельного
// ответа, по которому можно отличать существующие формы от несуществующих.
func (h *Handler) userAndForm(w http.ResponseWriter, r *http.Request) (auth.User, uuid.UUID, bool) {
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return auth.User{}, uuid.Nil, false
	}
	formID, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return auth.User{}, uuid.Nil, false
	}
	return user, formID, true
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
