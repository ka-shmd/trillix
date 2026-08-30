package forms

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// maxFormBodyBytes — потолок тела запросов forms. 64 КБ: title крошечный, но
// PATCH автосейва несёт весь draft_schema (до ~200 блоков). Внутренние лимиты
// документа стережёт ValidateSchema; MaxBytesReader — грубый внешний предел.
const maxFormBodyBytes = 64 << 10

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// composition root: forms не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// formsService — интерфейс сервиса, нужный транспорту (реализация — *Service).
type formsService interface {
	Create(ctx context.Context, userID uuid.UUID, title string, workspaceID *uuid.UUID) (Form, error)
	Duplicate(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	List(ctx context.Context, userID uuid.UUID, opts ListOptions) (Page, error)
	Get(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	// SubmissionOwner — адресат письма о новом ответе. Прав НЕ проверяет (это
	// адресат, а не доступ), поэтому зовётся только ПОСЛЕ Get/GetBySlug, которые
	// членство уже проверили.
	SubmissionOwner(ctx context.Context, formID uuid.UUID) (Owner, error)
	GetBySlug(ctx context.Context, userID uuid.UUID, slug string) (Form, error)
	UpdateName(ctx context.Context, userID, formID uuid.UUID, name string) (Form, error)
	UpdateCloseSettings(ctx context.Context, userID, formID uuid.UUID, settings domain.CloseSettings) (Form, error)
	UpdateNotifyOnSubmission(ctx context.Context, userID, formID uuid.UUID, enabled bool) (Form, error)
	UpdateCollectPartial(ctx context.Context, userID, formID uuid.UUID, enabled bool) (Form, error)
	UpdateBranding(ctx context.Context, userID, formID uuid.UUID, show bool) (Form, error)
	UpdateProgress(ctx context.Context, userID, formID uuid.UUID, show bool) (Form, error)
	UpdateBehavior(ctx context.Context, userID, formID uuid.UUID, autoJump, saveLocally bool) (Form, error)
	UpdateNotifyEmail(ctx context.Context, userID, formID uuid.UUID, n *domain.NotifyEmail) (Form, error)
	UpdateLinkPreview(ctx context.Context, userID, formID uuid.UUID, p *domain.LinkPreview) (Form, error)
	UpdateDraftSchema(ctx context.Context, userID, formID uuid.UUID, rawSchema json.RawMessage, expectedUpdatedAt time.Time) (Form, error)
	Delete(ctx context.Context, userID, formID uuid.UUID) error
	Publish(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	Unpublish(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	Reopen(ctx context.Context, userID, formID uuid.UUID) (Form, error)
}

// Handler — HTTP-транспорт модуля forms. Все роуты приватные (за RequireAuth);
// мутации — ещё и за RequireCSRF.
type Handler struct {
	svc         formsService
	requireAuth Middleware
	requireCSRF Middleware
	// notifyMail — письмо о новом ответе без авторских правок; адресат
	// подставляется на каждый запрос детали (он свой у каждой формы). Пустое, когда
	// почта на контуре не настроена.
	notifyMail notifyMailBody
}

// WithNotifyMail сообщает транспорту, как выглядит письмо о новом ответе без правок
// автора. Отдельным сеттером, а не аргументом конструктора: к формам это отношения
// не имеет, нужно ровно одному бланку в настройках.
func (h *Handler) WithNotifyMail(from, fromName, subject string) *Handler {
	h.notifyMail = notifyMailBody{From: from, FromName: fromName, Subject: subject}
	return h
}

func NewHandler(svc formsService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

// Routes регистрирует эндпоинты forms на общем mux.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/forms", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.create))))
	mux.Handle("GET /api/v1/forms/{id}", h.requireAuth(http.HandlerFunc(h.get)))
	// Резолв формы по slug (кабинет адресует форму slug'ом в URL редактора/ответов/
	// шаринга, как рендерер — /r/{slug}). slug — в query, а не в пути: путь
	// /forms/by-slug/{slug} конфликтовал бы в net/http-mux с /forms/{id}/submissions
	// (оба матчат /forms/by-slug/submissions, ни один не специфичнее). Литеральный
	// сегмент /forms/lookup специфичнее /forms/{id} — коллизии нет.
	mux.Handle("GET /api/v1/forms/lookup", h.requireAuth(http.HandlerFunc(h.getBySlug)))
	mux.Handle("PATCH /api/v1/forms/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.update))))
	mux.Handle("DELETE /api/v1/forms/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.delete))))
	mux.Handle("POST /api/v1/forms/{id}/duplicate", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.duplicate))))
	mux.Handle("POST /api/v1/forms/{id}/publish", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.publish))))
	mux.Handle("POST /api/v1/forms/{id}/unpublish", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.unpublish))))
	mux.Handle("POST /api/v1/forms/{id}/reopen", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.reopen))))
}

// --- DTO ---

type formResponse struct {
	ID string `json:"id"`
	// name — внутреннее имя для дашборда (null = не задано, кабинет показывает title).
	// title — публичный заголовок (его видит респондент). См. ADR §10.
	Name      *string   `json:"name"`
	Title     string    `json:"title"`
	Slug      string    `json:"slug"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// publishedVersion/publishedVersionId — текущая опубликованная версия (null,
	// пока форму не публиковали; после закрытия сохраняются — «была версия N»).
	PublishedVersion   *int32  `json:"publishedVersion"`
	PublishedVersionID *string `json:"publishedVersionId"`
	// hasUnpublishedChanges — черновик отличается от опубликованной версии (бейдж
	// «есть неопубликованные изменения»). Точен на GET/список; у ответов мутаций
	// всегда false (см. Form.HasUnpublishedChanges).
	HasUnpublishedChanges bool `json:"hasUnpublishedChanges"`
	// submissionCount — число ответов формы (счётчик на карточке). Точен на
	// GET/список; у ответов мутаций всегда 0.
	SubmissionCount int64 `json:"submissionCount"`
	// visitCount / visitSubmittedCount — просмотры формы и сколько из них
	// закончились ответом (фаза 8.5 шаг 6). Конверсию считает фронт по этой паре;
	// делить submissionCount на visitCount нельзя — это разные множества (ADR §10).
	// Точны на GET/список; у ответов мутаций всегда 0.
	VisitCount          int64 `json:"visitCount"`
	VisitSubmittedCount int64 `json:"visitSubmittedCount"`
}

// formDetailResponse — GET /forms/{id}: метаданные + черновик схемы + живые
// настройки закрытия (страница настроек кабинета их читает; фаза 8.5 шаг 4).
type formDetailResponse struct {
	formResponse
	DraftSchema json.RawMessage `json:"draftSchema"`
	// null/пусто = ограничение не задано. Только в детали формы (не в списке/мутациях).
	CloseAt       *time.Time `json:"closeAt"`
	ResponseLimit *int32     `json:"responseLimit"`
	ClosedMessage *string    `json:"closedMessage"`
	// ClosedTitle — заголовок экрана «приём закрыт» (0043); null = заголовком
	// остаётся название формы.
	ClosedTitle *string `json:"closedTitle"`
	// Тумблер уведомления владельцу о новом ответе (слайс D). Только в детали формы.
	NotifyOnSubmission bool `json:"notifyOnSubmission"`
	// CollectPartial — тумблер сбора незавершённых ответов. Кабинет рисует по нему
	// состояние переключателя; включение требует платного тарифа (402).
	CollectPartial bool `json:"collectPartial"`
	// Branding — показывать ли бейдж «Сделано в Trillix» (ADR §10). Только в детали
	// формы: у списка и мутаций здесь false, а false значит «бейдж снят» (мина
	// описана у Form.Branding). Карточка формы этого поля не читает — её Zod-тип на
	// фронте его не объявляет и срезает.
	Branding bool `json:"branding"`
	// Progress — показывать ли шкалу прогресса (индикатор шагов многостраничной
	// формы, миграция 0040). Та же мина, что у Branding: только в детали формы, а
	// false у списка и мутаций значит «шкала снята».
	Progress bool `json:"progress"`
	// Behavior — раздел «Поведение» (0044). Та же мина, что у Branding: только в
	// детали формы.
	AutoJump    bool `json:"autoJump"`
	SaveLocally bool `json:"saveLocally"`
	// NotifyEmail — настройка письма о новом ответе; null = не настраивали, письмо
	// уходит дефолтным шаблоном. Отдаётся НЕЗАВИСИМО от тарифа, как и карточка
	// ссылки: кабинет показывает сохранённое всем, а применяет настройку отправка
	// письма (гейт стоит там же и при сохранении).
	NotifyEmail *notifyEmailBody `json:"notifyEmail"`
	// NotifyMail — письмо о новом ответе БЕЗ авторских правок: как его отправит
	// сервис, если в notifyEmail пусто. Нужно бланку письма в настройках формы: он
	// показывает автору настоящие адреса и настоящий текст, а не описание того, чем
	// они являются, и вычислить их фронт не может.
	//
	// Получатель — почта ВЛАДЕЛЬЦА пространства, а не того, кто открыл страницу:
	// письмо уходит владельцу, и участник команды обязан видеть настоящего адресата,
	// иначе строка «Кому» врёт всем, кроме владельца. Новой утечки нет — почты
	// участников пространства и так видны на экране участников.
	//
	// Пустые поля = значение неизвестно (почта на контуре не настроена, владелец не
	// разрезолвился): кабинет тогда рисует описание вместо значения.
	NotifyMail notifyMailBody `json:"notifyMail"`
	// LinkPreview — своя карточка ссылки; null = не настраивали, публичная страница
	// берёт дефолты. Отдаётся НЕЗАВИСИМО от тарифа: окно кастомизации показывает
	// сохранённое всем, а применяет карточку к самой ссылке публичный слой (гейт
	// стоит там). Живая колонка — перепубликации не требует.
	LinkPreview *linkPreviewBody `json:"linkPreview"`
}

// linkPreviewBody — карточка ссылки в теле запроса и ответа. Полный набор полей,
// не частичный патч: окно кабинета шлёт карточку целиком, пустая строка = «снять
// переопределение и вернуть дефолт».
type linkPreviewBody struct {
	SiteName    string `json:"siteName"`
	Title       string `json:"title"`
	Description string `json:"description"`
	ImageKey    string `json:"imageKey"`
	IconKey     string `json:"iconKey"`
}

// behaviorBody — фасет behavior в PATCH: раздел «Поведение» целиком (0044). Набором,
// а не по тумблеру: это один экранный раздел, и кабинет сохраняет его одной кнопкой.
type behaviorBody struct {
	AutoJump    bool `json:"autoJump"`
	SaveLocally bool `json:"saveLocally"`
}

// closeSettingsBody — фасет closeSettings в PATCH: полный набор настроек закрытия
// (отсутствующее поле = снято). Замена всех четырёх колонок разом, не частичный патч.
type closeSettingsBody struct {
	CloseAt       *time.Time `json:"closeAt"`
	ResponseLimit *int32     `json:"responseLimit"`
	ClosedMessage string     `json:"closedMessage"`
	ClosedTitle   string     `json:"closedTitle"`
}

type listResponse struct {
	Forms      []formResponse `json:"forms"`
	NextCursor *string        `json:"nextCursor"`
}

type titleRequest struct {
	Title string `json:"title"`
	// workspaceId — в каком пространстве заводим форму. Отсутствует = личное:
	// кабинет присылает его, только когда работает не в личном.
	WorkspaceID *string `json:"workspaceId"`
}

// patchRequest — тело PATCH /forms/{id}. Указатели различают «поле отсутствует»
// (nil) от «прислано». За один запрос меняется ровно одно из
// name/draftSchema/closeSettings: name — переименование с дашборда (внутреннее имя,
// не трогает публичный заголовок); draftSchema — автосейв билдера, требует updatedAt
// для оптимистичной блокировки; closeSettings — настройки закрытия (страница
// настроек).
//
// ПУБЛИЧНОГО ЗАГОЛОВКА здесь больше нет (фаза 15): он стал блоком документа и
// приезжает внутри draftSchema, а колонку forms.title сервер пишет зеркалом. Вторая
// точка записи того же значения означала бы гарантированное расхождение колонки с
// документом — какая из двух правок легла последней, столько заголовок и живёт.
type patchRequest struct {
	Name               *string            `json:"name"`
	DraftSchema        *json.RawMessage   `json:"draftSchema"`
	UpdatedAt          *time.Time         `json:"updatedAt"`
	CloseSettings      *closeSettingsBody `json:"closeSettings"`
	NotifyOnSubmission *bool              `json:"notifyOnSubmission"`
	CollectPartial     *bool              `json:"collectPartial"`
	Branding           *bool              `json:"branding"`
	Progress           *bool              `json:"progress"`
	Behavior           *behaviorBody      `json:"behavior"`
	NotifyEmail        *notifyEmailBody   `json:"notifyEmail"`
	LinkPreview        *linkPreviewBody   `json:"linkPreview"`
}

// notifyMailBody — письмо по умолчанию: два адреса, которые автору не принадлежат,
// и два текста, которые он вправе перебить (notifyEmail). Тема приезжает из самого
// шаблона письма (mail.DefaultSubject), имя отправителя и адрес — из MAIL_FROM
// контура: у всех четырёх строк один источник истины, и он на сервере.
type notifyMailBody struct {
	From     string `json:"from"`
	To       string `json:"to"`
	FromName string `json:"fromName"`
	Subject  string `json:"subject"`
}

// notifyEmailBody — настройка письма о новом ответе в контракте API. Адреса
// отправителя и получателя здесь НЕТ: первый один на сервис, второй — владелец
// аккаунта, и оба автору не принадлежат (domain.NotifyEmail).
type notifyEmailBody struct {
	FromName  string `json:"fromName"`
	ReplyTo   string `json:"replyTo"`
	Subject   string `json:"subject"`
	Body      string `json:"body"`
	AttachPDF bool   `json:"attachPdf"`
}

// toNotifyEmailBody — настройка в тело ответа; nil (не настраивали) остаётся null,
// а не превращается в объект из пустых строк: у «не настраивали» одно представление.
func toNotifyEmailBody(n *domain.NotifyEmail) *notifyEmailBody {
	if n.Empty() {
		return nil
	}
	return &notifyEmailBody{
		FromName:  n.FromName,
		ReplyTo:   n.ReplyTo,
		Subject:   n.Subject,
		Body:      n.Body,
		AttachPDF: n.AttachPDF,
	}
}

func toFormResponse(f Form) formResponse {
	resp := formResponse{
		ID:                    f.ID.String(),
		Name:                  f.Name,
		Title:                 f.Title,
		Slug:                  f.Slug,
		Status:                f.Status,
		CreatedAt:             f.CreatedAt,
		UpdatedAt:             f.UpdatedAt,
		PublishedVersion:      f.PublishedVersion,
		HasUnpublishedChanges: f.HasUnpublishedChanges,
		SubmissionCount:       f.SubmissionCount,
		VisitCount:            f.VisitCount,
		VisitSubmittedCount:   f.VisitSubmittedCount,
	}
	if f.PublishedVersionID != nil {
		id := f.PublishedVersionID.String()
		resp.PublishedVersionID = &id
	}
	return resp
}

// toFormDetailResponse — деталь формы (GET /forms/{id} и /forms/lookup): метаданные,
// черновик схемы и живые настройки закрытия (их читает страница настроек кабинета).
// formDetail собирает деталь формы вместе с адресами письма. Метод, а не функция:
// служебный адрес отправителя живёт у транспорта, а адресат требует запроса.
//
// Сбой резолва адресата НЕ роняет деталь формы: строка «Кому» покажет описание
// вместо адреса, а страница настроек откроется — редактор, «Поделиться» и прочие
// потребители детали к почте отношения не имеют вовсе.
func (h *Handler) formDetail(ctx context.Context, f Form) formDetailResponse {
	resp := toFormDetailResponse(f)
	resp.NotifyMail = h.notifyMail
	if owner, err := h.svc.SubmissionOwner(ctx, f.ID); err == nil {
		resp.NotifyMail.To = owner.Email
	} else {
		httpserver.LoggerFrom(ctx).Warn("notification recipient not resolved for form detail",
			slog.String("form_id", f.ID.String()), slog.String("error", err.Error()))
	}
	return resp
}

func toFormDetailResponse(f Form) formDetailResponse {
	// Редактор кабинета знает только текущий формат — старый черновик апгрейдится
	// до v4 на отдаче. Ошибка невозможна на валидных данных БД; на всякий случай
	// отдаём сырьё, а не пустоту (лучше отладить, чем потерять черновик).
	//
	// Здесь же заголовок переезжает из колонки в документ (фаза 15, спека §3.5):
	// у формы, собранной до фазы, блока form_title нет, и редактор дописывает его
	// первой строкой из forms.title. Служебное имя новой формы («Untitled form»)
	// в полотно не тащим — автор его не писал, и на полотне он увидит плейсхолдер,
	// как видел в поле заголовка раньше.
	title := f.Title
	if title == defaultFormTitle {
		title = ""
	}
	schema := f.DraftSchema
	if up, err := domain.CanonicalDraftV4(schema, title, f.ID.String()); err == nil {
		schema = up
	}
	return formDetailResponse{
		formResponse:       toFormResponse(f),
		DraftSchema:        schema,
		CloseAt:            f.CloseAt,
		ResponseLimit:      f.ResponseLimit,
		ClosedMessage:      f.ClosedMessage,
		ClosedTitle:        f.ClosedTitle,
		NotifyOnSubmission: f.NotifyOnSubmission,
		CollectPartial:     f.CollectPartial,
		Branding:           f.Branding,
		Progress:           f.Progress,
		AutoJump:           f.AutoJump,
		SaveLocally:        f.SaveLocally,
		NotifyEmail:        toNotifyEmailBody(f.NotifyEmail),
		LinkPreview:        toLinkPreviewBody(f.LinkPreview),
	}
}

// toLinkPreviewBody — карточка ссылки в тело ответа; nil (не настраивали) остаётся
// null, а не превращается в объект из пустых строк: «не настраивали» и «настроили
// пустым» — одно состояние, и в контракте у него одно представление.
func toLinkPreviewBody(p *domain.LinkPreview) *linkPreviewBody {
	if p.Empty() {
		return nil
	}
	return &linkPreviewBody{
		SiteName:    p.SiteName,
		Title:       p.Title,
		Description: p.Description,
		ImageKey:    p.ImageKey,
		IconKey:     p.IconKey,
	}
}

// --- Handlers ---

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}

	after, ok := parseCursor(w, r)
	if !ok {
		return
	}
	sort, err := ParseSortOrder(r.URL.Query().Get("sort"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	limit := parseLimit(r.URL.Query().Get("limit"))
	wsID, ok := parseWorkspaceQuery(w, r)
	if !ok {
		return
	}

	page, err := h.svc.List(r.Context(), userID, ListOptions{
		Search:      r.URL.Query().Get("q"),
		Sort:        sort,
		After:       after,
		Limit:       limit,
		WorkspaceID: wsID,
	})
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}

	forms := make([]formResponse, len(page.Forms))
	for i, f := range page.Forms {
		forms[i] = toFormResponse(f)
	}
	resp := listResponse{Forms: forms}
	if page.NextCursor != nil {
		enc := encodeCursor(*page.NextCursor)
		resp.NextCursor = &enc
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
}

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	req, ok := decodeTitle(w, r)
	if !ok {
		return
	}
	wsID, ok := parseWorkspaceID(w, r, req.WorkspaceID)
	if !ok {
		return
	}
	form, err := h.svc.Create(r.Context(), userID, req.Title, wsID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toFormResponse(form))
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Get(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, h.formDetail(r.Context(), form))
}

// getBySlug — тот же ответ, что get, но форма адресована slug'ом (query-параметр
// ?slug=). Пустой slug трактуем как 404, а не 500.
func (h *Handler) getBySlug(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	slug := r.URL.Query().Get("slug")
	if slug == "" {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return
	}
	form, err := h.svc.GetBySlug(r.Context(), userID, slug)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, h.formDetail(r.Context(), form))
}

func (h *Handler) update(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	req, ok := decodePatch(w, r)
	if !ok {
		return
	}

	// Ровно одно из name/title/draftSchema/closeSettings за запрос — иначе непонятно,
	// что менять.
	set := 0
	facets := []bool{
		req.Name != nil,
		req.DraftSchema != nil,
		req.CloseSettings != nil,
		req.NotifyOnSubmission != nil,
		req.CollectPartial != nil,
		req.Branding != nil,
		req.Progress != nil,
		req.Behavior != nil,
		req.NotifyEmail != nil,
		req.LinkPreview != nil,
	}
	for _, present := range facets {
		if present {
			set++
		}
	}
	if set != 1 {
		httpserver.WriteError(w, r, fmt.Errorf("%w: за один запрос меняется ровно одно из name/draftSchema/closeSettings/notifyOnSubmission/collectPartial/branding/progress/behavior/notifyEmail/linkPreview", domain.ErrValidation))
		return
	}

	var (
		form Form
		err  error
	)
	switch {
	case req.DraftSchema != nil:
		if req.UpdatedAt == nil {
			httpserver.WriteError(w, r, fmt.Errorf("%w: updatedAt обязателен при сохранении схемы", domain.ErrValidation))
			return
		}
		form, err = h.svc.UpdateDraftSchema(r.Context(), userID, formID, *req.DraftSchema, *req.UpdatedAt)
	case req.Name != nil:
		form, err = h.svc.UpdateName(r.Context(), userID, formID, *req.Name)
	case req.CloseSettings != nil:
		cs := *req.CloseSettings
		form, err = h.svc.UpdateCloseSettings(r.Context(), userID, formID, domain.CloseSettings{
			CloseAt:       cs.CloseAt,
			ResponseLimit: cs.ResponseLimit,
			ClosedMessage: cs.ClosedMessage,
			ClosedTitle:   cs.ClosedTitle,
		})
	case req.NotifyOnSubmission != nil:
		form, err = h.svc.UpdateNotifyOnSubmission(r.Context(), userID, formID, *req.NotifyOnSubmission)
	case req.CollectPartial != nil:
		form, err = h.svc.UpdateCollectPartial(r.Context(), userID, formID, *req.CollectPartial)
	case req.Branding != nil:
		form, err = h.svc.UpdateBranding(r.Context(), userID, formID, *req.Branding)
	case req.Progress != nil:
		form, err = h.svc.UpdateProgress(r.Context(), userID, formID, *req.Progress)
	case req.Behavior != nil:
		form, err = h.svc.UpdateBehavior(r.Context(), userID, formID, req.Behavior.AutoJump, req.Behavior.SaveLocally)
	case req.NotifyEmail != nil:
		ne := *req.NotifyEmail
		form, err = h.svc.UpdateNotifyEmail(r.Context(), userID, formID, &domain.NotifyEmail{
			FromName:  strings.TrimSpace(ne.FromName),
			ReplyTo:   strings.TrimSpace(ne.ReplyTo),
			Subject:   strings.TrimSpace(ne.Subject),
			Body:      ne.Body,
			AttachPDF: ne.AttachPDF,
		})
	case req.LinkPreview != nil:
		lp := *req.LinkPreview
		form, err = h.svc.UpdateLinkPreview(r.Context(), userID, formID, &domain.LinkPreview{
			SiteName:    strings.TrimSpace(lp.SiteName),
			Title:       strings.TrimSpace(lp.Title),
			Description: strings.TrimSpace(lp.Description),
			ImageKey:    strings.TrimSpace(lp.ImageKey),
			IconKey:     strings.TrimSpace(lp.IconKey),
		})
	}
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toFormResponse(form))
}

func (h *Handler) delete(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	if err := h.svc.Delete(r.Context(), userID, formID); err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// publish снимает снапшот черновика в новую версию и публикует форму. Тела нет.
func (h *Handler) publish(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Publish(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toFormResponse(form))
}

func (h *Handler) duplicate(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Duplicate(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusCreated, toFormResponse(form))
}

// unpublish закрывает форму (status='closed'). Тела нет.
func (h *Handler) unpublish(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Unpublish(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toFormResponse(form))
}

// reopen открывает закрытую форму (status='published'), НЕ публикуя новой версии.
// Тела нет. Не закрытая форма и форма без опубликованной версии → 422: открывать
// нечего, а публикация черновика — отдельное действие автора.
func (h *Handler) reopen(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	form, err := h.svc.Reopen(r.Context(), userID, formID)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, toFormResponse(form))
}

// --- Разбор запроса ---

// userID достаёт пользователя, положенного RequireAuth. Отсутствие — 401
// (защита от неверной сборки цепочки middleware).
func userID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		httpserver.WriteError(w, r, domain.ErrUnauthorized)
		return uuid.Nil, false
	}
	return u.ID, true
}

// parseFormID разбирает {id}; неразбираемый uuid → 404 (несуществующая форма,
// без раскрытия чего-либо), а не 400.
func parseFormID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		httpserver.WriteError(w, r, domain.ErrNotFound)
		return uuid.Nil, false
	}
	return id, true
}

// decodeTitle читает необязательное тело {title}. Пустое тело допустимо (создание
// формы без названия → дефолт на сервисе).
// parseWorkspaceQuery читает ?workspaceId= списка. Отсутствие — законно и
// означает личное пространство; мусор вместо uuid — ошибка ввода, а не молчаливый
// откат к личному: иначе опечатка в id показала бы чужой на вид, но свой список.
func parseWorkspaceQuery(w http.ResponseWriter, r *http.Request) (*uuid.UUID, bool) {
	raw := r.URL.Query().Get("workspaceId")
	if raw == "" {
		return nil, true
	}
	return parseWorkspaceID(w, r, &raw)
}

func parseWorkspaceID(w http.ResponseWriter, r *http.Request, raw *string) (*uuid.UUID, bool) {
	if raw == nil {
		return nil, true
	}
	id, err := uuid.Parse(*raw)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: workspaceId не uuid", domain.ErrValidation))
		return nil, false
	}
	return &id, true
}

func decodeTitle(w http.ResponseWriter, r *http.Request) (titleRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBodyBytes)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: тело запроса слишком велико", domain.ErrValidation))
		return titleRequest{}, false
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return titleRequest{}, true
	}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	var req titleRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return titleRequest{}, false
	}
	return req, true
}

// decodePatch читает тело PATCH (title и/или draftSchema + updatedAt). Пустое
// тело недопустимо (в отличие от создания) — обработчик сам решит, чего не хватает.
func decodePatch(w http.ResponseWriter, r *http.Request) (patchRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req patchRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return patchRequest{}, false
	}
	return req, true
}

func parseLimit(raw string) int {
	if raw == "" {
		return 0 // сервис подставит DefaultPageLimit
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return n
}

// parseCursor разбирает непрозрачный ?cursor. Отсутствует → первая страница;
// присутствует, но битый → 422 (клиент передал испорченный курсор).
func parseCursor(w http.ResponseWriter, r *http.Request) (*Cursor, bool) {
	raw := r.URL.Query().Get("cursor")
	if raw == "" {
		return nil, true
	}
	c, err := decodeCursor(raw)
	if err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверный курсор", domain.ErrValidation))
		return nil, false
	}
	return c, true
}

// Курсор кодируется в непрозрачную для клиента строку "unixNano:uuid" (base64url).
func encodeCursor(c Cursor) string {
	raw := fmt.Sprintf("%d:%s:%s", c.SortKey, c.ID.String(), c.Sort)
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeCursor(s string) (*Cursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, err
	}
	keyStr, rest, ok := strings.Cut(string(raw), ":")
	if !ok {
		return nil, errors.New("cursor: missing separator")
	}
	key, err := strconv.ParseInt(keyStr, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("cursor: parse sort key: %w", err)
	}
	// Третья часть (порядок) появилась в фазе 8.5 шаг 8. Курсор без неё — выданный
	// прежней версией и уже открытой у кого-то страницей: читаем как сортировку по
	// умолчанию, а не роняем листание в 422 из-за момента выкатки.
	idStr, sortStr, hasSort := strings.Cut(rest, ":")
	id, err := uuid.Parse(idStr)
	if err != nil {
		return nil, fmt.Errorf("cursor: parse id: %w", err)
	}
	sort := SortUpdated
	if hasSort {
		if sort, err = ParseSortOrder(sortStr); err != nil {
			return nil, fmt.Errorf("cursor: %w", err)
		}
	}
	return &Cursor{SortKey: key, ID: id, Sort: sort}, nil
}
