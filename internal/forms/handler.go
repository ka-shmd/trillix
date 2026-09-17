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

// maxChatBodyBytes — потолок тела ручки чата. Больше общего, потому что тело здесь
// СОСТАВНОЕ: тот же документ формы плюс до десяти реплик разговора плюс сообщение
// автора. На форме у потолка блоков десятая реплика переваливала за 64 КБ, и ручка
// отвечала «неверное тело запроса» — то есть указывала на формат там, где дело в
// размере, и чат на большой форме просто переставал работать.
const maxChatBodyBytes = 256 << 10

// Middleware — HTTP-обёртка (RequireAuth/RequireCSRF из auth), инжектируемая в
// composition root: forms не завязан на конкретный тип auth.Handler.
type Middleware = func(http.Handler) http.Handler

// formsService — интерфейс сервиса, нужный транспорту (реализация — *Service).
type formsService interface {
	Create(ctx context.Context, userID uuid.UUID, title string, workspaceID *uuid.UUID) (Form, error)
	// Generate собирает черновик формы по описанию автора (фаза 26).
	Generate(ctx context.Context, userID uuid.UUID, prompt string, workspaceID *uuid.UUID) (Form, error)
	// Chat — одна реплика разговора с ассистентом над формой (фаза 26, слайс E).
	Chat(ctx context.Context, userID, formID uuid.UUID, message string, history []ChatTurn, schema json.RawMessage) (ChatResult, error)
	Duplicate(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	List(ctx context.Context, userID uuid.UUID, opts ListOptions) (Page, error)
	Search(ctx context.Context, userID uuid.UUID, query string) ([]SearchHit, error)
	Get(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	// SubmissionOwner — адресат письма о новом ответе. Прав НЕ проверяет (это
	// адресат, а не доступ), поэтому зовётся только ПОСЛЕ Get/GetBySlug, которые
	// членство уже проверили.
	SubmissionOwner(ctx context.Context, formID uuid.UUID) (Owner, error)
	GetBySlug(ctx context.Context, userID uuid.UUID, slug string) (Form, error)
	UpdateName(ctx context.Context, userID, formID uuid.UUID, name string) (Form, error)
	UpdateCloseSettings(ctx context.Context, userID, formID uuid.UUID, settings domain.CloseSettings) (Form, error)
	UpdateNotifyOnSubmission(ctx context.Context, userID, formID uuid.UUID, enabled bool) (Form, error)
	UpdateNotifyRespondent(ctx context.Context, userID, formID uuid.UUID, enabled bool) (Form, error)
	// UpdatePassword ставит пароль на форму или снимает его (nil = снять, 0047).
	UpdatePassword(ctx context.Context, userID, formID uuid.UUID, password *string) (Form, error)
	UpdateSchedule(ctx context.Context, userID, formID uuid.UUID, scheduleID *uuid.UUID) (Form, error)
	UpdateRespondentEmail(ctx context.Context, userID, formID uuid.UUID, r *domain.RespondentEmail) (Form, error)
	UpdateCollectPartial(ctx context.Context, userID, formID uuid.UUID, enabled bool) (Form, error)
	UpdateBranding(ctx context.Context, userID, formID uuid.UUID, show bool) (Form, error)
	UpdateProgress(ctx context.Context, userID, formID uuid.UUID, show bool) (Form, error)
	UpdateBehavior(ctx context.Context, userID, formID uuid.UUID, autoJump, saveLocally, allowBack bool) (Form, error)
	UpdateNotifyEmail(ctx context.Context, userID, formID uuid.UUID, n *domain.NotifyEmail) (Form, error)
	UpdateLinkPreview(ctx context.Context, userID, formID uuid.UUID, p *domain.LinkPreview) (Form, error)
	UpdateDraftSchema(ctx context.Context, userID, formID uuid.UUID, rawSchema json.RawMessage, expectedUpdatedAt time.Time) (Form, error)
	DiscardDraft(ctx context.Context, userID, formID uuid.UUID, expectedUpdatedAt time.Time) (Form, error)
	Delete(ctx context.Context, userID, formID uuid.UUID) error
	Publish(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	Unpublish(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	Reopen(ctx context.Context, userID, formID uuid.UUID) (Form, error)
	// Согласие на обработку персональных данных (0069).
	Consent(ctx context.Context, userID, formID uuid.UUID) (ConsentState, error)
	SaveConsent(ctx context.Context, userID, formID uuid.UUID, enabled bool, settings domain.ConsentSettings) (ConsentState, error)
	ConsentPreview(ctx context.Context, userID, formID uuid.UUID, settings domain.ConsentSettings) (consent, policy domain.ConsentDocument, err error)
	ConsentOperators(ctx context.Context, userID, workspaceID uuid.UUID) ([]ConsentOperatorItem, error)
	DeleteConsentOperator(ctx context.Context, userID, operatorID uuid.UUID) error
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
	// respondentMail — то же для письма РЕСПОНДЕНТУ (0046). Своя строка, а не общая
	// с notifyMail: тема у писем разная, и бланк обязан показывать ту, которая
	// действительно уйдёт. Адресата здесь нет вовсе — он приезжает ответом.
	respondentMail notifyMailBody
	// aiLimiter — ведро обращений к модели, общее у сборки формы и чата. Ключ —
	// АККАУНТ, а не адрес: вызов стоит денег, и защищать надо от своего же цикла в
	// кабинете, а не только от чужого перебора. Одно ведро на обе ручки, потому что
	// защищает оно один и тот же кошелёк. Не подключено (юнит-тесты) = ограничения
	// нет: инвариант 6 требует инжектировать пермиссивную реализацию, а не ослаблять
	// боевую.
	aiLimiter RateLimiter
}

// RateLimiter — ведро запросов, нужное транспорту форм. Реализация —
// ratelimit.TokenBucket; в тестах инжектируется пермиссивная (инвариант 6).
type RateLimiter interface {
	Allow(key string) bool
}

// WithAILimiter подключает ведро обращений к модели. Отдельным сеттером, а не
// аргументом конструктора: конструктор зовут из десятков тестов, которым ведро
// безразлично.
func (h *Handler) WithAILimiter(l RateLimiter) *Handler {
	h.aiLimiter = l
	return h
}

// WithNotifyMail сообщает транспорту, как выглядит письмо о новом ответе без правок
// автора. Отдельным сеттером, а не аргументом конструктора: к формам это отношения
// не имеет, нужно ровно одному бланку в настройках.
func (h *Handler) WithNotifyMail(from, fromName, subject string) *Handler {
	h.notifyMail = notifyMailBody{From: from, FromName: fromName, Subject: subject}
	return h
}

// WithRespondentMail — то же для письма респонденту: тем же сеттером и по той же
// причине. Адрес отправителя общий (домен один на сервис), тема своя.
func (h *Handler) WithRespondentMail(from, fromName, subject string) *Handler {
	h.respondentMail = notifyMailBody{From: from, FromName: fromName, Subject: subject}
	return h
}

func NewHandler(svc formsService, requireAuth, requireCSRF Middleware) *Handler {
	return &Handler{svc: svc, requireAuth: requireAuth, requireCSRF: requireCSRF}
}

// Routes регистрирует эндпоинты forms на общем mux.
func (h *Handler) Routes(mux *http.ServeMux) {
	mux.Handle("GET /api/v1/forms", h.requireAuth(http.HandlerFunc(h.list)))
	mux.Handle("POST /api/v1/forms", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.create))))
	// Литеральный сегмент специфичнее /forms/{id}, коллизии в mux нет (тот же
	// довод, что у /forms/lookup).
	mux.Handle("POST /api/v1/forms/generate", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.generate))))
	mux.Handle("POST /api/v1/forms/{id}/ai/chat", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.chat))))
	mux.Handle("GET /api/v1/forms/{id}", h.requireAuth(http.HandlerFunc(h.get)))
	// Резолв формы по slug (кабинет адресует форму slug'ом в URL редактора/ответов/
	// шаринга, как рендерер — /r/{slug}). slug — в query, а не в пути: путь
	// /forms/by-slug/{slug} конфликтовал бы в net/http-mux с /forms/{id}/submissions
	// (оба матчат /forms/by-slug/submissions, ни один не специфичнее). Литеральный
	// сегмент /forms/lookup специфичнее /forms/{id} — коллизии нет.
	mux.Handle("GET /api/v1/forms/lookup", h.requireAuth(http.HandlerFunc(h.getBySlug)))
	// Поиск по всем пространствам. Литеральный сегмент специфичнее /forms/{id} —
	// тот же довод, что у /forms/lookup и /forms/generate.
	mux.Handle("GET /api/v1/forms/search", h.requireAuth(http.HandlerFunc(h.search)))
	mux.Handle("PATCH /api/v1/forms/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.update))))
	mux.Handle("DELETE /api/v1/forms/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.delete))))
	mux.Handle("POST /api/v1/forms/{id}/duplicate", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.duplicate))))
	// Раздел «Персональные данные» (0069): согласие под кнопкой отправки.
	mux.Handle("GET /api/v1/forms/{id}/consent", h.requireAuth(http.HandlerFunc(h.getConsent)))
	mux.Handle("PUT /api/v1/forms/{id}/consent", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.putConsent))))
	mux.Handle("POST /api/v1/forms/{id}/consent/preview", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.previewConsent))))
	// Список реквизитов принадлежит пространству, а строка адресуется своим id —
	// пространство сервер резолвит сам (как у расписаний записи).
	mux.Handle("GET /api/v1/workspaces/{id}/consent-operators", h.requireAuth(http.HandlerFunc(h.consentOperators)))
	mux.Handle("DELETE /api/v1/consent-operators/{id}", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.deleteConsentOperator))))
	mux.Handle("POST /api/v1/forms/{id}/publish", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.publish))))
	mux.Handle("POST /api/v1/forms/{id}/unpublish", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.unpublish))))
	mux.Handle("POST /api/v1/forms/{id}/reopen", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.reopen))))
	mux.Handle("POST /api/v1/forms/{id}/discard-draft", h.requireAuth(h.requireCSRF(http.HandlerFunc(h.discardDraft))))
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
	// lastSubmissionAt — когда пришёл последний ответ (колонка «Последний ответ» в
	// списке форм); null = ответов не было ни одного. Точен там же, где счётчик
	// рядом: на GET/списке, у ответов мутаций всегда null.
	LastSubmissionAt *time.Time `json:"lastSubmissionAt"`
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
	// Behavior — раздел «Поведение» (0044, третий тумблер — 0055). Та же мина, что у
	// Branding: только в детали формы.
	AutoJump    bool `json:"autoJump"`
	SaveLocally bool `json:"saveLocally"`
	AllowBack   bool `json:"allowBack"`
	// NotifyEmail — настройка письма о новом ответе; null = не настраивали, письмо
	// уходит дефолтным шаблоном. Отдаётся НЕЗАВИСИМО от тарифа, как и карточка
	// ссылки: кабинет показывает сохранённое всем, а применяет настройку отправка
	// письма (гейт стоит там же и при сохранении).
	NotifyEmail *notifyEmailBody `json:"notifyEmail"`
	// NotifyRespondent и RespondentEmail — тумблер и бланк письма респонденту
	// (0046). Та же мина, что у Branding: только в детали формы. Бланк отдаётся
	// независимо от тарифа, как и notifyEmail, — кабинет показывает сохранённое
	// всем, а гейт стоит на сохранении и на отправке.
	NotifyRespondent bool                 `json:"notifyRespondent"`
	RespondentEmail  *respondentEmailBody `json:"respondentEmail"`
	// RespondentMail — письмо респонденту БЕЗ авторских правок, как notifyMail для
	// письма владельцу. Поле To здесь всегда пустое: адресат приезжает ответом, и
	// строку «Кому» бланк рисует описанием выбранного вопроса.
	RespondentMail notifyMailBody `json:"respondentMail"`
	// Password — пароль на форму (null = пароля нет). Отдаётся ОТКРЫТЫМ ТЕКСТОМ и
	// только в детали формы: автор свой пароль видит и копирует, потому что это не
	// учётная запись, а общий секрет, который он рассылает участникам (решение
	// владельца 2026-09-01, design/form-password.md §2.1). Право читать деталь формы
	// уже проверено (членство в воркспейсе), новой утечки нет.
	//
	// null при включённом пароле возможен и означает ровно одно: секрет приложения
	// сменили, и старый шифротекст больше не читается (service.withPassword).
	Password *string `json:"password"`
	// WorkspaceID — пространство формы. Кабинету нужно, чтобы спросить расписания
	// ЭТОГО пространства (фаза 27): до сих пор он выводил контекст из адреса
	// (`?w=`), и прямая ссылка без параметра читалась как личное пространство —
	// TD-69. Здесь дефект закрыт для того, кто спрашивает деталь формы; крошка и
	// подсветка сайдбара по-прежнему читают адрес.
	WorkspaceID string `json:"workspaceId"`
	// WorkspaceSlug — короткий ключ пространства: им кабинет адресует пространство
	// в своих URL. Нужен попапу блока «Запись», чтобы увести автора в расписания
	// ЕГО пространства.
	WorkspaceSlug string `json:"workspaceSlug"`
	// ScheduleID — расписание записи на время (0050); null = у формы нет записи.
	// Кабинету нужен, чтобы попап блока «Запись» показал выбранное расписание и
	// красную строку, когда его нет.
	ScheduleID *string `json:"scheduleId"`
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

// behaviorBody — фасет behavior в PATCH: раздел «Поведение» целиком (0044, третий
// тумблер — 0055). Набором, а не по тумблеру: это один экранный раздел, и кабинет
// сохраняет его одной кнопкой.
type behaviorBody struct {
	AutoJump    bool `json:"autoJump"`
	SaveLocally bool `json:"saveLocally"`
	AllowBack   bool `json:"allowBack"`
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
	Name               *string              `json:"name"`
	DraftSchema        *json.RawMessage     `json:"draftSchema"`
	UpdatedAt          *time.Time           `json:"updatedAt"`
	CloseSettings      *closeSettingsBody   `json:"closeSettings"`
	NotifyOnSubmission *bool                `json:"notifyOnSubmission"`
	CollectPartial     *bool                `json:"collectPartial"`
	Branding           *bool                `json:"branding"`
	Progress           *bool                `json:"progress"`
	Behavior           *behaviorBody        `json:"behavior"`
	NotifyEmail        *notifyEmailBody     `json:"notifyEmail"`
	NotifyRespondent   *bool                `json:"notifyRespondent"`
	RespondentEmail    *respondentEmailBody `json:"respondentEmail"`
	LinkPreview        *linkPreviewBody     `json:"linkPreview"`
	Password           *passwordBody        `json:"password"`
	// Schedule — расписание записи на время (фаза 27). Обёртка, как у пароля, и по
	// той же причине: `null` внутри значит «снять», а отсутствие поля — «не трогать»,
	// и один указатель эти два случая не различает.
	Schedule *scheduleBody `json:"schedule"`
}

// scheduleBody — id расписания либо null (снять запись у формы).
type scheduleBody struct {
	Value *string `json:"value"`
}

// passwordBody — фасет пароля на форму. Обёртка вокруг одного поля, а не голый
// *string, ровно затем, чтобы «снять пароль» отличалось от «не трогать»: у *string
// отсутствующее поле и явный null дают один и тот же nil, и фасет было бы не
// отличить от его отсутствия. {"password":{"value":null}} — снять,
// {"password":{"value":"…"}} — поставить.
type passwordBody struct {
	Value *string `json:"value"`
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
	FromName string `json:"fromName"`
	ReplyTo  string `json:"replyTo"`
	// Subject и Body — спаны, а не строки (mentions.md §10): в них живёт подстановка
	// ответа, и без массива её негде хранить. Доменный тип берётся как есть — свой
	// зеркальный был бы вторым описанием одного формата.
	Subject   []domain.Span `json:"subject"`
	Body      []domain.Span `json:"body"`
	AttachPDF bool          `json:"attachPdf"`
}

// respondentEmailBody — бланк письма респонденту в контракте API. От
// notifyEmailBody отличается одним полем: sourceBlockId — вопрос, из ответа на
// который берётся адрес получателя. Адреса получателя здесь нет и быть не может —
// он приезжает ответом, а не настройкой (иначе форма стала бы рассыльщиком).
type respondentEmailBody struct {
	SourceBlockID string        `json:"sourceBlockId"`
	FromName      string        `json:"fromName"`
	ReplyTo       string        `json:"replyTo"`
	Subject       []domain.Span `json:"subject"`
	Body          []domain.Span `json:"body"`
	AttachPDF     bool          `json:"attachPdf"`
}

// toRespondentEmailBody — бланк в тело ответа; nil остаётся null, как у письма
// владельцу: у «не настраивали» одно представление.
func toRespondentEmailBody(r *domain.RespondentEmail) *respondentEmailBody {
	if r.Empty() {
		return nil
	}
	return &respondentEmailBody{
		SourceBlockID: r.SourceBlockID,
		FromName:      r.FromName,
		ReplyTo:       r.ReplyTo,
		Subject:       r.Subject,
		Body:          r.Body,
		AttachPDF:     r.AttachPDF,
	}
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
		LastSubmissionAt:      f.LastSubmissionAt,
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
	resp.RespondentMail = h.respondentMail
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
		NotifyRespondent:   f.NotifyRespondent,
		RespondentEmail:    toRespondentEmailBody(f.RespondentEmail),
		CollectPartial:     f.CollectPartial,
		Branding:           f.Branding,
		Progress:           f.Progress,
		AutoJump:           f.AutoJump,
		SaveLocally:        f.SaveLocally,
		AllowBack:          f.AllowBack,
		NotifyEmail:        toNotifyEmailBody(f.NotifyEmail),
		LinkPreview:        toLinkPreviewBody(f.LinkPreview),
		Password:           f.Password,
		WorkspaceID:        f.WorkspaceID.String(),
		WorkspaceSlug:      f.WorkspaceSlug,
		ScheduleID:         uuidStr(f.ScheduleID),
	}
}

// uuidStr — id наружу строкой; nil остаётся null.
func uuidStr(id *uuid.UUID) *string {
	if id == nil {
		return nil
	}
	s := id.String()
	return &s
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
	status, err := ParseStatusFilter(r.URL.Query().Get("status"))
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
		Status:      status,
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

// allowAI — пускает ли ведро ещё один вызов модели этим аккаунтом.
func (h *Handler) allowAI(userID uuid.UUID) bool {
	return h.aiLimiter == nil || h.aiLimiter.Allow(userID.String())
}

// chat — реплика разговора с ассистентом над формой (фаза 26, слайс E).
//
// Документ приходит В ТЕЛЕ и возвращается правленым, но в базу здесь не пишется:
// черновик сохраняет автосейв полотна своим путём с оптимистичной блокировкой, и
// второй писатель означал бы гонку с ним на ровном месте.
func (h *Handler) chat(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	if !h.allowAI(userID) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком часто, подождите немного", domain.ErrRateLimited))
		return
	}
	req, ok := decodeChat(w, r)
	if !ok {
		return
	}

	// Дедлайн записи продлевается по тому же поводу, что у сборки формы: общий
	// WriteTimeout сервера короче, чем модель вправе думать.
	ctx, cancel := context.WithTimeout(r.Context(), generateTimeout)
	defer cancel()
	httpserver.ExtendWriteDeadline(w, httpserver.LoggerFrom(r.Context()), generateTimeout+5*time.Second)

	res, err := h.svc.Chat(ctx, userID, formID, req.Message, req.turns(), req.Schema)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	// Преобразованием, а не сборкой по полям: состав у результата сервиса и у DTO
	// сегодня совпадает, и в день, когда разойдётся, эта строка перестанет
	// компилироваться — то есть заметит расхождение за нас.
	httpserver.WriteJSON(w, r, http.StatusOK, chatResponse(res))
}

// generate — форма по описанию автора (фаза 26). Ответ тот же, что у создания:
// кабинет уходит в редактор по id, и знать, чем форма собрана, ему не нужно.
func (h *Handler) generate(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	if !h.allowAI(userID) {
		httpserver.WriteError(w, r, fmt.Errorf("%w: слишком часто, подождите немного", domain.ErrRateLimited))
		return
	}
	req, ok := decodeGenerate(w, r)
	if !ok {
		return
	}
	wsID, ok := parseWorkspaceID(w, r, req.WorkspaceID)
	if !ok {
		return
	}
	// ДЕДЛАЙН ЗАПИСИ ПРОДЛЕВАЕТСЯ, иначе ручка не работает вовсе: общий WriteTimeout
	// сервера — 10 секунд, а модель отвечает единицами секунд и вправе задержаться.
	// Соединение рвалось бы посреди ожидания, и кабинет (через прокси vite) видел
	// бы 502 вместо ответа. Тот же приём и та же причина, что у печати PDF и
	// стриминга CSV (TD-4).
	//
	// Потолок на всю операцию — generateTimeout: он же ограничивает и клиента
	// модели вместе с его повтором, потому что контекст запроса едет в него насквозь.
	ctx, cancel := context.WithTimeout(r.Context(), generateTimeout)
	defer cancel()
	httpserver.ExtendWriteDeadline(w, httpserver.LoggerFrom(r.Context()), generateTimeout+5*time.Second)

	form, err := h.svc.Generate(ctx, userID, req.Prompt, wsID)
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

// searchHitResponse — строка выдачи поиска по всем пространствам. Своё DTO, а не
// formResponse: у найденной формы нет ни счётчиков, ни версии, и нули в этих полях
// врали бы. Зато есть то, чего нет у списка, — ГДЕ она лежит.
type searchHitResponse struct {
	ID    string  `json:"id"`
	Slug  string  `json:"slug"`
	Name  *string `json:"name"`
	Title string  `json:"title"`
	// status — строка результата ведёт черновик в редактор, а розданную форму на
	// ответы: то же правило, что у карточки списка.
	Status string `json:"status"`
	// workspaceSlug — им кабинет строит ссылку в редактор (он адресуется через
	// пространство); workspaceName — подпись «где это лежит».
	WorkspaceSlug string `json:"workspaceSlug"`
	WorkspaceName string `json:"workspaceName"`
}

type searchResponse struct {
	Forms []searchHitResponse `json:"forms"`
}

// search — формы по всем пространствам, где состоит спрашивающий. Пространство в
// запросе не называется: смысл ручки ровно в том, что человек не помнит, в каком
// из них форма (`GET /forms` для этого не годится — он живёт внутри одного).
//
// Пустой `q` отвечает пустым списком, а не 422: строка поиска пуста до первой
// набранной буквы.
func (h *Handler) search(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	hits, err := h.svc.Search(r.Context(), userID, r.URL.Query().Get("q"))
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	resp := searchResponse{Forms: make([]searchHitResponse, len(hits))}
	for i, f := range hits {
		resp.Forms[i] = searchHitResponse{
			ID: f.ID.String(), Slug: f.Slug, Name: f.Name, Title: f.Title, Status: f.Status,
			WorkspaceSlug: f.WorkspaceSlug, WorkspaceName: f.WorkspaceName,
		}
	}
	httpserver.WriteJSON(w, r, http.StatusOK, resp)
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
		req.NotifyRespondent != nil,
		req.RespondentEmail != nil,
		req.LinkPreview != nil,
		req.Password != nil,
		req.Schedule != nil,
	}
	for _, present := range facets {
		if present {
			set++
		}
	}
	if set != 1 {
		httpserver.WriteError(w, r, fmt.Errorf("%w: за один запрос меняется ровно одно из name/draftSchema/closeSettings/notifyOnSubmission/collectPartial/branding/progress/behavior/notifyEmail/notifyRespondent/respondentEmail/linkPreview/password/schedule", domain.ErrValidation))
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
	case req.NotifyRespondent != nil:
		form, err = h.svc.UpdateNotifyRespondent(r.Context(), userID, formID, *req.NotifyRespondent)
	case req.Password != nil:
		form, err = h.svc.UpdatePassword(r.Context(), userID, formID, req.Password.Value)
	case req.Schedule != nil:
		var scheduleID *uuid.UUID
		if v := req.Schedule.Value; v != nil {
			parsed, e := uuid.Parse(*v)
			if e != nil {
				httpserver.WriteError(w, r, fmt.Errorf("%w: расписание указано неверно", domain.ErrValidation))
				return
			}
			scheduleID = &parsed
		}
		form, err = h.svc.UpdateSchedule(r.Context(), userID, formID, scheduleID)
	case req.RespondentEmail != nil:
		re := *req.RespondentEmail
		form, err = h.svc.UpdateRespondentEmail(r.Context(), userID, formID, &domain.RespondentEmail{
			SourceBlockID: re.SourceBlockID,
			FromName:      re.FromName,
			ReplyTo:       re.ReplyTo,
			Subject:       re.Subject,
			Body:          re.Body,
			AttachPDF:     re.AttachPDF,
		})
	case req.CollectPartial != nil:
		form, err = h.svc.UpdateCollectPartial(r.Context(), userID, formID, *req.CollectPartial)
	case req.Branding != nil:
		form, err = h.svc.UpdateBranding(r.Context(), userID, formID, *req.Branding)
	case req.Progress != nil:
		form, err = h.svc.UpdateProgress(r.Context(), userID, formID, *req.Progress)
	case req.Behavior != nil:
		form, err = h.svc.UpdateBehavior(r.Context(), userID, formID, req.Behavior.AutoJump, req.Behavior.SaveLocally, req.Behavior.AllowBack)
	case req.NotifyEmail != nil:
		ne := *req.NotifyEmail
		// Тема и текст НЕ тримятся: пробел в спанах — кусок текста, за который
		// отвечает редактор (он же ставит пробел за чипом), и обрезать его здесь
		// значило бы менять документ мимо автора. Тримятся только два ярлыка.
		form, err = h.svc.UpdateNotifyEmail(r.Context(), userID, formID, &domain.NotifyEmail{
			FromName:  strings.TrimSpace(ne.FromName),
			ReplyTo:   strings.TrimSpace(ne.ReplyTo),
			Subject:   ne.Subject,
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

// discardDraft возвращает черновик к опубликованной версии. Тело — {"updatedAt"}:
// токен той же оптимистичной блокировки, что у автосейва. Ответ — деталь целиком, как
// у GET: у кабинета нет опубликованной схемы, чтобы собрать черновик самому.
func (h *Handler) discardDraft(w http.ResponseWriter, r *http.Request) {
	userID, ok := userID(w, r)
	if !ok {
		return
	}
	formID, ok := parseFormID(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req struct {
		UpdatedAt *time.Time `json:"updatedAt"`
	}
	if err := dec.Decode(&req); err != nil || req.UpdatedAt == nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: нужен updatedAt черновика", domain.ErrValidation))
		return
	}
	form, err := h.svc.DiscardDraft(r.Context(), userID, formID, *req.UpdatedAt)
	if err != nil {
		httpserver.WriteError(w, r, err)
		return
	}
	httpserver.WriteJSON(w, r, http.StatusOK, h.formDetail(r.Context(), form))
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

// generateTimeout — потолок на всю сборку формы: два вызова модели (второй —
// починка) с запасом. Человек ждёт ответа на экране, и минута ожидания отказа —
// предел терпимого; типичный ответ приходит за единицы секунд.
const generateTimeout = 60 * time.Second

// chatRequest — реплика автора, история разговора и документ, который он сейчас
// видит. История приезжает с клиента (ADR §10): сервер чата состояния не держит.
type chatRequest struct {
	Message string          `json:"message"`
	History []chatTurnDTO   `json:"history"`
	Schema  json.RawMessage `json:"schema"`
}

// chatTurnDTO — реплика разговора. Роль строкой, как у совместимого входа: «кто
// сказал» на клиенте и на сервере обязано называться одинаково.
type chatTurnDTO struct {
	Role string `json:"role"`
	Text string `json:"text"`
}

const chatRoleAssistant = "assistant"

func (r chatRequest) turns() []ChatTurn {
	out := make([]ChatTurn, 0, len(r.History))
	for _, t := range r.History {
		out = append(out, ChatTurn{Assistant: t.Role == chatRoleAssistant, Text: t.Text})
	}
	return out
}

// chatResponse — что ассистент сказал и, если правил, новый документ формы.
// Пустая схема означает «ничего не менял»: класть в ответ нетронутый документ
// значило бы заставлять кабинет сравнивать его с тем, что у него уже есть.
type chatResponse struct {
	Reply  string          `json:"reply"`
	Schema json.RawMessage `json:"schema,omitempty"`
	// PlanRequired — часть просьбы не выполнена из-за тарифа: кабинет предлагает
	// разговор о тарифе тем же оверлеем, что и остальные платные возможности.
	PlanRequired bool `json:"planRequired,omitempty"`
}

func decodeChat(w http.ResponseWriter, r *http.Request) (chatRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxChatBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req chatRequest
	if err := dec.Decode(&req); err != nil {
		// Размер отделён от формата: «неверное тело» на слишком большом теле — отказ,
		// который нечем починить, потому что он называет не ту причину.
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpserver.WriteError(w, r, fmt.Errorf("%w: тело больше %d байт", domain.ErrTooLarge, maxChatBodyBytes))
			return chatRequest{}, false
		}
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return chatRequest{}, false
	}
	return req, true
}

// generateRequest — описание формы словами и (необязательно) пространство, в
// котором её создать.
type generateRequest struct {
	Prompt      string  `json:"prompt"`
	WorkspaceID *string `json:"workspaceId"`
}

func decodeGenerate(w http.ResponseWriter, r *http.Request) (generateRequest, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxFormBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req generateRequest
	if err := dec.Decode(&req); err != nil {
		httpserver.WriteError(w, r, fmt.Errorf("%w: неверное тело запроса", domain.ErrValidation))
		return generateRequest{}, false
	}
	return req, true
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
