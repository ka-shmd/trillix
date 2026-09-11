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
	// intentCookie несёт подписанное «этот поход начат ВОТ ЭТИМ человеком».
	// Ставится только эндпоинтом за RequireAuth, и в этом вся защита: сессии на
	// колбэке провайдера нет, а «кому записать подключение» из параметра запроса
	// означало бы, что жертву можно заманить пройти согласие и подключить её
	// Google к аккаунту атакующего.
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
	Spreadsheets(ctx context.Context, userID, accountID uuid.UUID) ([]SpreadsheetRef, error)
	Sheets(ctx context.Context, userID, accountID uuid.UUID, spreadsheetID string) ([]SheetRef, error)
	Picker(ctx context.Context, userID, accountID uuid.UUID) (PickerCredentials, error)
	DisconnectForm(ctx context.Context, userID, formID, linkID uuid.UUID) error
	RefillForm(ctx context.Context, userID, formID, linkID uuid.UUID) error
	RecheckForm(ctx context.Context, userID, formID, linkID uuid.UUID) error
	UpdateConnection(ctx context.Context, userID, formID, linkID uuid.UUID, patch ConnectionPatch) error
	StartURL(ctx context.Context, userID, reconnect uuid.UUID, state, verifier string) (string, error)
	Connect(ctx context.Context, userID uuid.UUID, code, verifier string) (uuid.UUID, error)
	Disconnect(ctx context.Context, userID, accountID uuid.UUID) error
	Deliveries(ctx context.Context, userID, formID, linkID, cursor uuid.UUID) ([]Delivery, error)
	RetryDelivery(ctx context.Context, userID, formID, linkID, deliveryID uuid.UUID) error
	CreateWebhook(ctx context.Context, userID, formID uuid.UUID, in WebhookInput) (Webhook, string, error)
	UpdateWebhook(ctx context.Context, userID, formID, webhookID uuid.UUID, patch WebhookPatch) error
	WebhookSecret(ctx context.Context, userID, formID, webhookID uuid.UUID) (string, error)
	ReissueWebhookSecret(ctx context.Context, userID, formID, webhookID uuid.UUID) (string, error)
	DeleteWebhook(ctx context.Context, userID, formID, webhookID uuid.UUID) error
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

// Routes регистрирует приватные эндпоинты.
//
// Два семейства адресов, и граница между ними не вкусовая. Аккаунт принадлежит
// ЧЕЛОВЕКУ (ADR §10), поэтому всё, что делается с самим подключением —
// подключить, отключить, спросить его таблицы и листы, открыть окно выбора
// файла, — живёт под /integrations и не имеет в адресе ни формы, ни
// пространства: их упоминание там врало бы про область действия. Под формой
// остаётся только СВЯЗКА — правило доставки её ответов.
func (h *Handler) Routes(mux *http.ServeMux) {
	// Экран интеграций живёт у ФОРМЫ, поэтому и читается одной поездкой по её
	// адресу: пространство формы резолвит сервер. Иначе кабинет обязан был бы
	// сначала узнать, в каком пространстве лежит форма, — второй запрос ради
	// того, что сервер и так знает.
	mux.Handle("GET /api/v1/forms/{id}/integrations",
		h.requireAuth(http.HandlerFunc(h.formStatus)))
	mux.Handle("POST /api/v1/forms/{id}/integrations/google",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.connectForm))))
	// Операции над ОДНОЙ связкой адресуются её id: связок у формы сколько
	// угодно, и «отвязать интеграцию формы» перестало быть однозначным.
	mux.Handle("PATCH /api/v1/forms/{id}/integrations/{connectionId}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.updateConnection))))
	mux.Handle("POST /api/v1/forms/{id}/integrations/{connectionId}/refill",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.refillForm))))
	// Перепроверка листа: человек поправил шапку у себя и хочет знать, помогло ли,
	// не дожидаясь следующего ответа респондента.
	mux.Handle("POST /api/v1/forms/{id}/integrations/{connectionId}/recheck",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.recheckForm))))
	// Журнал доставок связки: что уехало, что не уехало и почему. Страница
	// курсором — лента длиной в поток ответов целиком не отдаётся.
	mux.Handle("GET /api/v1/forms/{id}/integrations/{connectionId}/deliveries",
		h.requireAuth(http.HandlerFunc(h.deliveries)))
	// Повтор одной доставки. Отдельным адресом от связки: предмет действия —
	// попытка, а не связка, и права у них разные быть не должны.
	mux.Handle("POST /api/v1/forms/{id}/integrations/{connectionId}/deliveries/{deliveryId}/retry",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.retryDelivery))))
	mux.Handle("DELETE /api/v1/forms/{id}/integrations/{connectionId}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.disconnectForm))))

	// Вебхуки — своё семейство под формой: у них свой id и своя форма тела, а
	// читаются они тем же состоянием таба (GET …/integrations).
	mux.Handle("POST /api/v1/forms/{id}/webhooks",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.createWebhook))))
	mux.Handle("PATCH /api/v1/forms/{id}/webhooks/{webhookId}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.updateWebhook))))
	mux.Handle("DELETE /api/v1/forms/{id}/webhooks/{webhookId}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.deleteWebhook))))
	// Секрет подписи — отдельной ручкой по нажатию «Показать», а не в состоянии
	// таба: раздавать его на каждый показ незачем. POST того же адреса — перевыпуск.
	mux.Handle("GET /api/v1/forms/{id}/webhooks/{webhookId}/secret",
		h.requireAuth(http.HandlerFunc(h.webhookSecret)))
	mux.Handle("POST /api/v1/forms/{id}/webhooks/{webhookId}/secret",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.reissueWebhookSecret))))

	// Один адрес на «подключить ещё один» и «переподключить»: возврат у них
	// общий, а различает их необязательный accountId — почта названного аккаунта
	// уезжает провайдеру подсказкой, и человек попадает сразу в нужный аккаунт.
	mux.Handle("GET /api/v1/integrations/google/start",
		h.requireAuth(http.HandlerFunc(h.start)))
	// Колбэк без RequireAuth: сюда возвращается браузер по редиректу Google, и
	// JSON-ошибка 401 в окне 560×680 оставила бы человека на origin API без
	// пути назад. Доказательство личности — подписанная HttpOnly-cookie.
	mux.Handle("GET /api/v1/integrations/google/callback", http.HandlerFunc(h.callback))
	mux.Handle("DELETE /api/v1/integrations/google/accounts/{accountId}",
		h.requireAuth(h.requireCSRF(http.HandlerFunc(h.disconnect))))
	// Список таблиц аккаунта: только созданные нами (scope drive.file), поэтому
	// чужих файлов Диска он не раскрывает — и это СВОЙ аккаунт спрашивающего.
	mux.Handle("GET /api/v1/integrations/google/accounts/{accountId}/spreadsheets",
		h.requireAuth(http.HandlerFunc(h.spreadsheets)))
	// Листы выбранной книги — второй шаг выбора. Книга приезжает параметром, а не
	// сегментом пути: её id — чужая строка произвольного вида, и в пути он
	// требовал бы экранирования на каждом клиенте.
	mux.Handle("GET /api/v1/integrations/google/accounts/{accountId}/sheets",
		h.requireAuth(http.HandlerFunc(h.sheets)))
	// Credentials окна выбора файла на Диске. Отдельной ручкой, а не в состоянии:
	// в ответе живой access-токен Google, и раздавать его на каждый показ таба
	// нельзя — только по нажатию кнопки выбора.
	mux.Handle("GET /api/v1/integrations/google/accounts/{accountId}/picker",
		h.requireAuth(http.HandlerFunc(h.picker)))
}

// accountResponse — подключения СПРАШИВАЮЩЕГО: то, из чего он выбирает в окне
// связки. Не «аккаунт пространства»: с ADR §10 (2026-08-27) аккаунт личный, и в
// команде каждый видит здесь свои.
type accountResponse struct {
	Enabled bool `json:"enabled"`
	// PickerEnabled — настроено ли окно выбора файла на Диске (нужен отдельный
	// API-key). Экран рисует по нему кнопку выбора.
	PickerEnabled bool `json:"pickerEnabled"`
	// Accounts — пустой список означает «ничего не подключено» и является
	// штатным состоянием экрана. От Enabled=false он отличается лечением: там
	// кнопки не появится вовсе, здесь она и есть весь следующий шаг.
	Accounts []connectedAccountResponse `json:"accounts"`
}

type connectedAccountResponse struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	// NeedsReconnect — подключение есть, но пользоваться им нельзя: refresh-токен
	// не расшифровывается ключом контура (ротация FORM_TOKEN_SECRET). Экран
	// обязан сказать «подключите заново», а не рисовать зелёное «подключено».
	NeedsReconnect bool   `json:"needsReconnect"`
	ConnectedAt    string `json:"connectedAt"`
}

// sheetResponse — привязка формы. Отдельным объектом (а не полями вперемешку с
// аккаунтом), потому что это два независимых состояния: аккаунт может быть
// подключён без единой привязанной формы, и экран показывает разные вещи.
type sheetResponse struct {
	ID  string `json:"id"`
	URL string `json:"url"`
	// AccountID и AccountEmail — каким подключением едет связка. Экрану нужны оба
	// и по разным поводам: id подсвечивает выбор в селекте, почта подписывает
	// строку в списке. Почта обязательна и когда аккаунт ЧУЖОЙ: в команде связку
	// заводит один участник, а смотрит другой, и без подписи «через кого» он
	// увидит интеграцию, которой нет в его селекте.
	AccountID    string `json:"accountId"`
	AccountEmail string `json:"accountEmail"`
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
	// Webhooks — вебхуки формы; пустой список — тоже состояние экрана.
	Webhooks []webhookResponse `json:"webhooks"`
}

// webhookResponse — вебхук глазами экрана.
//
// URL пуст у того, кто не вправе править форму (решает сервис): в пути адреса
// лежит токен получателя. Host — у всех. Секрета здесь нет никогда: он
// отдаётся отдельной ручкой по нажатию.
type webhookResponse struct {
	ID              string  `json:"id"`
	Name            string  `json:"name,omitempty"`
	Host            string  `json:"host"`
	URL             string  `json:"url,omitempty"`
	Enabled         bool    `json:"enabled"`
	Status          string  `json:"status"`
	LastError       string  `json:"lastError,omitempty"`
	LastDeliveredAt *string `json:"lastDeliveredAt,omitempty"`
	Queued          int64   `json:"queued"`
}

func toWebhookResponse(w Webhook) webhookResponse {
	out := webhookResponse{
		ID:        w.ID.String(),
		Name:      w.Name,
		Host:      w.Host,
		URL:       w.URL,
		Enabled:   w.Enabled,
		Status:    w.Status,
		LastError: w.LastError,
		Queued:    w.Queued,
	}
	if !w.LastDeliveredAt.IsZero() {
		at := w.LastDeliveredAt.UTC().Format(time.RFC3339)
		out.LastDeliveredAt = &at
	}
	return out
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
			Enabled:       st.Account.Enabled,
			PickerEnabled: st.Account.PickerEnabled,
			Accounts:      make([]connectedAccountResponse, 0, len(st.Account.Accounts)),
		},
	}
	for _, a := range st.Account.Accounts {
		resp.Account.Accounts = append(resp.Account.Accounts, connectedAccountResponse{
			ID:             a.ID.String(),
			Email:          a.Email,
			NeedsReconnect: a.NeedsReconnect,
			ConnectedAt:    a.ConnectedAt.UTC().Format(time.RFC3339),
		})
	}
	resp.Connections = make([]sheetResponse, 0, len(st.Connections))
	for _, link := range st.Connections {
		resp.Connections = append(resp.Connections, *toSheetResponse(link))
	}
	resp.Webhooks = make([]webhookResponse, 0, len(st.Webhooks))
	for _, wh := range st.Webhooks {
		resp.Webhooks = append(resp.Webhooks, toWebhookResponse(wh))
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

// webhookRequest — тело заведения и правки вебхука. Указатели: правка трогает
// только названные поля (тумблер из списка шлёт один enabled).
type webhookRequest struct {
	Name    *string `json:"name"`
	URL     *string `json:"url"`
	Enabled *bool   `json:"enabled"`
}

// createdWebhookResponse — заведённый вебхук и его секрет: показать сразу, не
// заставляя человека жать «Показать» в только что открытом окне.
type createdWebhookResponse struct {
	webhookResponse
	Secret string `json:"secret"`
}

type webhookSecretResponse struct {
	Secret string `json:"secret"`
}

func (h *Handler) createWebhook(w http.ResponseWriter, r *http.Request) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return
	}
	req, ok := decodeWebhookRequest(w, r)
	if !ok {
		return
	}
	in := WebhookInput{}
	if req.Name != nil {
		in.Name = *req.Name
	}
	if req.URL != nil {
		in.URL = *req.URL
	}
	wh, secret, err := h.svc.CreateWebhook(r.Context(), user.ID, formID, in)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// В ответе секрет: промежуточный кэш, сохранивший его, раздавал бы ключ подписи.
	w.Header().Set("Cache-Control", "no-store")
	httpserver.WriteJSON(w, r, http.StatusCreated, createdWebhookResponse{
		webhookResponse: toWebhookResponse(wh),
		Secret:          secret,
	})
}

func (h *Handler) updateWebhook(w http.ResponseWriter, r *http.Request) {
	user, formID, webhookID, ok := h.userFormWebhook(w, r)
	if !ok {
		return
	}
	req, ok := decodeWebhookRequest(w, r)
	if !ok {
		return
	}
	patch := WebhookPatch{Name: req.Name, Enabled: req.Enabled, URL: req.URL}
	if err := h.svc.UpdateWebhook(r.Context(), user.ID, formID, webhookID, patch); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) deleteWebhook(w http.ResponseWriter, r *http.Request) {
	user, formID, webhookID, ok := h.userFormWebhook(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteWebhook(r.Context(), user.ID, formID, webhookID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) webhookSecret(w http.ResponseWriter, r *http.Request) {
	user, formID, webhookID, ok := h.userFormWebhook(w, r)
	if !ok {
		return
	}
	secret, err := h.svc.WebhookSecret(r.Context(), user.ID, formID, webhookID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpserver.WriteJSON(w, r, http.StatusOK, webhookSecretResponse{Secret: secret})
}

func (h *Handler) reissueWebhookSecret(w http.ResponseWriter, r *http.Request) {
	user, formID, webhookID, ok := h.userFormWebhook(w, r)
	if !ok {
		return
	}
	secret, err := h.svc.ReissueWebhookSecret(r.Context(), user.ID, formID, webhookID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpserver.WriteJSON(w, r, http.StatusOK, webhookSecretResponse{Secret: secret})
}

// decodeWebhookRequest читает тело заведения или правки: потолок размера
// (инвариант 3) и запрет незнакомых полей.
func decodeWebhookRequest(w http.ResponseWriter, r *http.Request) (webhookRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req webhookRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return webhookRequest{}, false
	}
	return req, true
}

// userFormWebhook достаёт спрашивающего, форму и вебхук из адреса. Битый id —
// 404, как везде: по нему нельзя отличать существующие вебхуки.
func (h *Handler) userFormWebhook(w http.ResponseWriter, r *http.Request) (auth.User, uuid.UUID, uuid.UUID, bool) {
	user, formID, ok := h.userAndForm(w, r)
	if !ok {
		return auth.User{}, uuid.Nil, uuid.Nil, false
	}
	webhookID, err := uuid.Parse(r.PathValue("webhookId"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return auth.User{}, uuid.Nil, uuid.Nil, false
	}
	return user, formID, webhookID, true
}

// connectRequest — настройки из окна подключения.
//
// Тело стало ОБЯЗАТЕЛЬНЫМ (прежде работало без него): accountId подразумевать
// нечем — аккаунтов у человека сколько угодно, и «первый попавшийся» отправил бы
// ответы не в тот Диск молча.
type connectRequest struct {
	// AccountID — каким подключением ехать.
	AccountID string `json:"accountId"`
	Name      string `json:"name"`
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

	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req connectRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return
	}
	accountID, err := uuid.Parse(req.AccountID)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: не выбран аккаунт Google", domain.ErrValidation))
		return
	}
	opts := ConnectOptions{
		AccountID:     accountID,
		Name:          req.Name,
		SpreadsheetID: req.SpreadsheetID,
		SheetID:       req.SheetID,
		Backfill:      req.Backfill == nil || *req.Backfill,
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
	user, accountID, ok := h.userAndAccount(w, r)
	if !ok {
		return
	}

	list, err := h.svc.Sheets(r.Context(), user.ID, accountID, r.URL.Query().Get("spreadsheetId"))
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
	user, accountID, ok := h.userAndAccount(w, r)
	if !ok {
		return
	}

	cred, err := h.svc.Picker(r.Context(), user.ID, accountID)
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
	user, accountID, ok := h.userAndAccount(w, r)
	if !ok {
		return
	}

	list, err := h.svc.Spreadsheets(r.Context(), user.ID, accountID)
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
//
// accountId едет вместе с целью: сменить аккаунт, не перевыбрав таблицу, нельзя
// физически (drive.file), поэтому отдельного поля «только аккаунт» нет. Не
// назван — связка остаётся на своём аккаунте.
type connectionRequest struct {
	Name          string  `json:"name"`
	Enabled       *bool   `json:"enabled"`
	AccountID     string  `json:"accountId"`
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
		if req.AccountID != "" {
			accountID, err := uuid.Parse(req.AccountID)
			if err != nil {
				httpserver.WriteError(w, r, fmt.Errorf("%w: не выбран аккаунт Google", domain.ErrValidation))
				return
			}
			patch.Target.AccountID = accountID
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

// deliveryResponse — одна попытка доставки глазами экрана.
//
// submissionId уезжает наружу, потому что лента ссылается на ответ: из журнала
// человек уходит смотреть, что именно не доехало. У пачки переноса его нет.
type deliveryResponse struct {
	ID           string `json:"id"`
	Kind         string `json:"kind"`
	SubmissionID string `json:"submissionId,omitempty"`
	Outcome      string `json:"outcome"`
	Detail       string `json:"detail,omitempty"`
	Rows         int32  `json:"rows"`
	CreatedAt    string `json:"createdAt"`
}

// deliveriesResponse — страница ленты. nextCursor пуст, когда страница
// последняя: клиенту не нужно знать про размер страницы, чтобы это понять.
type deliveriesResponse struct {
	Deliveries []deliveryResponse `json:"deliveries"`
	NextCursor string             `json:"nextCursor,omitempty"`
}

func (h *Handler) deliveries(w http.ResponseWriter, r *http.Request) {
	user, formID, linkID, ok := h.userFormConnection(w, r)
	if !ok {
		return
	}
	// Кривой курсор — не ошибка клиента, а первая страница: ленту открывают по
	// ссылке, и 422 вместо списка здесь никому не помогает.
	cursor, _ := uuid.Parse(r.URL.Query().Get("cursor"))

	list, err := h.svc.Deliveries(r.Context(), user.ID, formID, linkID, cursor)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	resp := deliveriesResponse{Deliveries: make([]deliveryResponse, 0, len(list))}
	for _, d := range list {
		item := deliveryResponse{
			ID:        d.ID.String(),
			Kind:      d.Kind,
			Outcome:   d.Outcome,
			Detail:    d.Detail,
			Rows:      d.RowCount,
			CreatedAt: d.CreatedAt.UTC().Format(time.RFC3339),
		}
		if d.SubmissionID != uuid.Nil {
			item.SubmissionID = d.SubmissionID.String()
		}
		resp.Deliveries = append(resp.Deliveries, item)
	}
	// Полная страница означает «возможно, есть ещё»; курсор — id последней.
	// Лишний пустой запрос дешевле пропущенного хвоста ленты.
	if len(list) == DeliveryPageSize {
		resp.NextCursor = list[len(list)-1].ID.String()
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

// retryDelivery ставит доставку заново. 202, а не 204: событие поставлено в
// очередь, а не доставлено — исход появится в той же ленте отдельной строкой.
func (h *Handler) retryDelivery(w http.ResponseWriter, r *http.Request) {
	user, formID, linkID, ok := h.userFormConnection(w, r)
	if !ok {
		return
	}
	deliveryID, err := uuid.Parse(r.PathValue("deliveryId"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	if err := h.svc.RetryDelivery(r.Context(), user.ID, formID, linkID, deliveryID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
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

// recheckForm отвечает 204, если лист снова годен, и 422 с человеческой причиной,
// если нет: «не помогло» — это ответ по существу, а не сбой.
func (h *Handler) recheckForm(w http.ResponseWriter, r *http.Request) {
	user, formID, linkID, ok := h.userFormConnection(w, r)
	if !ok {
		return
	}
	if err := h.svc.RecheckForm(r.Context(), user.ID, formID, linkID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
		AccountID:     l.AccountID.String(),
		AccountEmail:  l.AccountEmail,
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
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
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

	// accountId необязателен и приезжает ПАРАМЕТРОМ, а не сегментом: без него
	// это «подключить ещё один», и городить ради необязательного значения второй
	// адрес незачем. Битый uuid — 404, как и везде: по нему нельзя отличать
	// существующие подключения от несуществующих.
	var reconnect uuid.UUID
	if raw := r.URL.Query().Get("accountId"); raw != "" {
		reconnect, err = uuid.Parse(raw)
		if err != nil {
			httpserver.WriteError(w, r, domain.ErrNotFound)
			return
		}
	}

	url, err := h.svc.StartURL(r.Context(), user.ID, reconnect, state, verifier)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	h.setFlowCookie(w, stateCookie, state+":"+verifier)
	h.setFlowCookie(w, intentCookie, h.signIntent(user.ID))
	http.Redirect(w, r, url, http.StatusFound)
}

func (h *Handler) callback(w http.ResponseWriter, r *http.Request) {
	// Обе cookie одноразовые: гасим их до любого ответа. Через defer было бы
	// нельзя — http.Redirect к тому моменту уже записал заголовки, и Set-Cookie
	// не уехал бы, оставив state жить все 15 минут TTL.
	h.expireCookie(w, stateCookie)
	userID, haveIntent := h.readIntent(r)
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
	// и подключить к его кабинету аккаунт атакующего.
	if subtle.ConstantTimeCompare([]byte(state), []byte(r.URL.Query().Get("state"))) != 1 {
		h.finish(w, r, outcomeExpired)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		h.finish(w, r, outcomeFailed)
		return
	}

	_, err := h.svc.Connect(r.Context(), userID, code, verifier)
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
	user, accountID, ok := h.userAndAccount(w, r)
	if !ok {
		return
	}
	if err := h.svc.Disconnect(r.Context(), user.ID, accountID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// userAndAccount достаёт из запроса того, кто спрашивает, и аккаунт из адреса.
// Неразбираемый id → 404 без раскрытия, а не 400: принадлежность аккаунта всё
// равно проверяет сервис, и «битый uuid» не заслуживает отдельного ответа, по
// которому можно отличать существующие подключения от несуществующих.
func (h *Handler) userAndAccount(w http.ResponseWriter, r *http.Request) (auth.User, uuid.UUID, bool) {
	user, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return auth.User{}, uuid.Nil, false
	}
	accountID, err := uuid.Parse(r.PathValue("accountId"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return auth.User{}, uuid.Nil, false
	}
	return user, accountID, true
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

// signIntent подписывает «кто начал поход» со сроком. Пространства в намерении
// больше нет: подключение принадлежит человеку, и записывать его некуда, кроме
// как на него самого (ADR §10).
func (h *Handler) signIntent(userID uuid.UUID) string {
	payload := fmt.Sprintf("%s:%d", userID, time.Now().Add(flowTTL).Unix())
	return payload + ":" + base64.RawURLEncoding.EncodeToString(h.intentMAC(payload))
}

// readIntent достаёт намерение из запроса. Битая подпись, истёкший срок и
// отсутствие cookie неразличимы снаружи — все они означают «похода не было».
func (h *Handler) readIntent(r *http.Request) (userID uuid.UUID, ok bool) {
	c, err := r.Cookie(intentCookie)
	if err != nil {
		return uuid.Nil, false
	}
	i := strings.LastIndex(c.Value, ":")
	if i < 0 {
		return uuid.Nil, false
	}
	payload, sig := c.Value[:i], c.Value[i+1:]
	want, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(want, h.intentMAC(payload)) {
		return uuid.Nil, false
	}

	parts := strings.Split(payload, ":")
	if len(parts) != 2 {
		return uuid.Nil, false
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().After(time.Unix(exp, 0)) {
		return uuid.Nil, false
	}
	userID, err = uuid.Parse(parts[0])
	if err != nil {
		return uuid.Nil, false
	}
	return userID, true
}

func (h *Handler) intentMAC(payload string) []byte {
	mac := hmac.New(sha256.New, h.secret)
	mac.Write([]byte(intentLabel + payload))
	return mac.Sum(nil)
}
