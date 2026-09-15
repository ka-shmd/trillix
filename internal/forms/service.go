package forms

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/postgres"
)

const (
	// defaultFormTitle — форма создаётся с этим названием, пользователь
	// переименовывает инлайн на дашборде. С фазы 15 оно же — значение колонки-
	// зеркала, когда автор стёр заголовок в документе: колонка NOT NULL, а
	// респондент этого имени не видит (публичный путь спрашивает документ).
	defaultFormTitle = "Untitled form"
	// maxTitleLen — потолок названия формы в РУНАХ (до фазы 15 считался в байтах,
	// и кириллица обрезалась вдвое раньше латиницы). Зеркалит domain.MaxFormTitleLen:
	// заголовок из документа уезжает в эту же колонку, и разные потолки означали бы,
	// что зеркало не может повторить документ.
	maxTitleLen = 200

	// DefaultPageLimit / MaxPageLimit — размер страницы списка форм. Запрошенный
	// клиентом limit зажимается в [1, MaxPageLimit]; пустой → Default.
	DefaultPageLimit = 50
	MaxPageLimit     = 100

	// MaxSearchLen — потолок строки поиска. Названия форм ограничены 200 символами
	// (maxTitleLen), поэтому запрос длиннее не может ничего найти по определению.
	// Проверка не «на всякий случай»: query-строку не стережёт MaxBytesReader (он
	// про тело), и без этого лимита в ILIKE уезжал шаблон в десятки килобайт —
	// инвариант 3 требует валидировать любой пользовательский ввод на бэке.
	MaxSearchLen = maxTitleLen
)

// Access — права в пространстве глазами этого модуля (internal/workspaces).
// Спрашивается ДЕЙСТВИЕ, а не роль (ADR §10): персональные исключения тогда
// приедут внутрь Can, не тронув ни одной точки вызова здесь.
//
// Can сам различает два отказа: не участник → ErrNotFound (404, существование
// чужого не раскрывается), участник без права → ErrForbidden (403).
type Access interface {
	Can(ctx context.Context, workspaceID, userID uuid.UUID, action domain.Action) error
}

// Plans — тарифы глазами этого модуля: узкий интерфейс на стороне потребителя, как
// у submissions и visits. Формам нужен ровно один вопрос — «можно ли воркспейсу
// такую возможность»; счётчики расхода и расчётный период их не касаются.
type Plans interface {
	CheckWorkspace(ctx context.Context, workspaceID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
	// ConsumeAIGeneration списывает одну генерацию формы (фаза 26) в периоде,
	// который вернула проверка: два чтения часов расходятся на границе месяца.
	ConsumeAIGeneration(ctx context.Context, workspaceID uuid.UUID, period time.Time) error
}

// Store — доступ к данным forms, объявленный на стороне потребителя (сервиса).
// Реализация — Repo; в тестах подменяется фейком. Методы принимают исполнителя
// (postgres.DBTX: пул или транзакция).
type Store interface {
	GetPersonalWorkspace(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (uuid.UUID, error)
	CreateForm(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, title, slug string) (Form, error)
	CreateFormWithSchema(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, title, slug string, name *string, schema json.RawMessage) (Form, error)
	ListFormNames(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]FormName, error)
	GetForm(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Form, error)
	GetFormBySlug(ctx context.Context, db postgres.DBTX, slug string) (Form, error)
	ListFormsPage(ctx context.Context, db postgres.DBTX, q ListPageQuery) ([]ListRow, error)
	SearchForms(ctx context.Context, db postgres.DBTX, userID uuid.UUID, search string, limit int32) ([]SearchHit, error)
	UpdateFormName(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, name *string) (Form, error)
	UpdateFormCloseSettings(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, s domain.CloseSettings) (Form, error)
	UpdateFormNotifyOnSubmission(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error)
	UpdateBranding(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, show bool) (Form, error)
	UpdateProgress(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, show bool) (Form, error)
	UpdateFormNotifyEmail(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, n *domain.NotifyEmail) (Form, error)
	UpdateFormNotifyRespondent(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error)
	UpdateFormRespondentEmail(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, r *domain.RespondentEmail) (Form, error)
	UpdateFormPassword(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, sealed []byte) (Form, error)
	// UpdateFormSchedule — расписание записи у формы (фаза 27), живая колонка.
	UpdateFormSchedule(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, scheduleID *uuid.UUID) (Form, error)
	// ScheduleInWorkspace — принадлежит ли расписание пространству формы: id
	// приезжает телом запроса и правом доступа не является.
	ScheduleInWorkspace(ctx context.Context, db postgres.DBTX, scheduleID, workspaceID uuid.UUID) (bool, error)
	GetFormPasswordBySlug(ctx context.Context, db postgres.DBTX, slug string) (uuid.UUID, []byte, error)
	SetFormReopened(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (Form, error)
	UpdateFormBehavior(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, autoJump, saveLocally, allowBack bool) (Form, error)
	UpdateCollectPartial(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error)
	UpdateFormLinkPreview(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, p *domain.LinkPreview) (Form, error)
	GetSubmissionOwner(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (Owner, error)
	UpdateFormDraftSchema(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, schema json.RawMessage, mirrorTitle *string, expectedUpdatedAt time.Time) (Form, error)
	DeleteForm(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (int64, error)
	NextFormVersion(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int32, error)
	InsertFormVersion(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, version int32, schema json.RawMessage) (uuid.UUID, error)
	SetFormPublished(ctx context.Context, db postgres.DBTX, id, workspaceID, versionID uuid.UUID) (Form, error)
	SetFormClosed(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (Form, error)
	GetPublicFormBySlug(ctx context.Context, db postgres.DBTX, slug string) (PublicForm, error)
	GetPublicFormRefBySlug(ctx context.Context, db postgres.DBTX, slug string) (PublicFormRef, error)
	ListFormVersions(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]Version, error)
}

var _ Store = Repo{}

// Transactor открывает транзакцию (без знания о конкретном пуле). Реализация —
// postgres.TxRunner; в юнит-тестах — фейк, выполняющий fn без реальной БД.
// Публикация обязана быть атомарной: снапшот версии + published_version_id одной
// транзакцией (инвариант internal/CLAUDE.md).
type Transactor interface {
	WithTx(ctx context.Context, fn func(pgx.Tx) error) error
}

// SortOrder — порядок списка форм (фаза 8.5 шаг 8). Значения совпадают с тем, что
// приходит в query-параметре sort и уходит в CASE запроса: белый список, чужое
// значение отвергается транспортом (422), в SQL произвольная строка не попадает.
type SortOrder string

const (
	SortUpdated   SortOrder = "updated"   // по последней правке (умолчание)
	SortCreated   SortOrder = "created"   // по дате создания
	SortResponses SortOrder = "responses" // по числу ответов
)

// ParseSortOrder разбирает значение query-параметра. Пусто → умолчание; всё
// остальное вне белого списка — ошибка (не «молча умолчание»: клиент, приславший
// sort=updatd, должен узнать об опечатке, а не получить не тот порядок).
func ParseSortOrder(raw string) (SortOrder, error) {
	switch SortOrder(raw) {
	case "":
		return SortUpdated, nil
	case SortUpdated, SortCreated, SortResponses:
		return SortOrder(raw), nil
	default:
		return "", fmt.Errorf("%w: неизвестная сортировка", domain.ErrValidation)
	}
}

// StatusFilter — фильтр списка по статусу формы (сегменты «Черновики /
// Опубликованные / Закрытые» над списком). Пусто = все статусы; остальные значения
// совпадают с колонкой forms.status (domain.FormStatus*): белый список, чужое
// значение отвергается транспортом (422), в SQL произвольная строка не попадает.
type StatusFilter string

// ParseStatusFilter разбирает значение query-параметра status. Пусто → «все»; всё
// остальное вне белого списка — ошибка, а не молчаливое «все»: клиент, приславший
// status=drafts, должен узнать об опечатке, а не получить всю выдачу и решить, что
// фильтр не работает.
func ParseStatusFilter(raw string) (StatusFilter, error) {
	switch raw {
	case "":
		return "", nil
	case domain.FormStatusDraft, domain.FormStatusPublished, domain.FormStatusClosed:
		return StatusFilter(raw), nil
	default:
		return "", fmt.Errorf("%w: неизвестный статус", domain.ErrValidation)
	}
}

// Cursor — курсор списка форм: пара (ключ сортировки, id), однозначно указывающая
// на последнюю показанную форму, плюс порядок, в котором курсор выдан. Транспорт
// кодирует его в непрозрачную строку.
//
// Sort входит в курсор, потому что ключ у разных порядков означает разное
// (наносекунды против числа ответов): курсор, выданный одним порядком и применённый
// к другому, дал бы не ошибку, а тихо перемешанную выдачу с пропусками.
type Cursor struct {
	SortKey int64
	ID      uuid.UUID
	Sort    SortOrder
}

// ListOptions — параметры страницы списка: поиск по отображаемому имени, порядок,
// курсор и размер страницы.
type ListOptions struct {
	Search string
	Sort   SortOrder
	// Status — показывать только формы этого статуса; пусто = все. В курсор НЕ
	// входит (в отличие от Sort): фильтр не меняет смысл ключа сортировки, он
	// сужает выборку. Смена фильтра — листание с первой страницы, как и смена
	// поиска.
	Status StatusFilter
	After  *Cursor
	Limit  int
	// WorkspaceID — в каком пространстве смотрим. nil = личное (пространство по
	// умолчанию): так сохраняются живые ссылки кабинета, не знающие про
	// параметр. Чужое пространство неотличимо от несуществующего — 404.
	WorkspaceID *uuid.UUID
}

// Page — страница списка форм и курсор на следующую (nil, если страница последняя).
type Page struct {
	Forms      []Form
	NextCursor *Cursor
}

// Service — бизнес-логика форм. Каждый метод по ресурсу начинается с проверки
// права доступа: id формы из URL не доказывает членство в её воркспейсе
// (ARCHITECTURE §4.3, инвариант безопасности 1).
type Service struct {
	db     postgres.DBTX // пул: нетранзакционные операции (чтение, одиночные записи)
	tx     Transactor    // для атомарной публикации (версия + published_version_id)
	repo   Store
	access Access // права в пространстве: спрашиваются по действию, не по роли
	plans  Plans  // тариф: спрашивается на публикации, не на сохранении
	// files — файлы в ответах (фаза 24). Нужны ровно одному действию — удалению
	// формы, — поэтому подключаются сеттером, а не шестым позиционным аргументом.
	// nil = «модуля файлов в этой сборке нет» (юнит-тесты): удаление формы тогда
	// работает как раньше.
	files AnswerFiles
	// bookingGuard — стоп-кран удаления формы с живыми будущими записями (фаза 27);
	// nil = записи на контуре нет.
	bookingGuard BookingGuard
	// secret — секрет токена формы (FORM_TOKEN_SECRET). Из него выводятся ключ
	// шифрования пароля формы и секрет подписи токенов разблокировки (0047).
	// Подключается сеттером, как files: конструктор зовут из полусотни тестов, и
	// шестой позиционный аргумент к ним всем — правка ради одного применения.
	//
	// Пустой секрет = ОТКАЗ, а не работа без защиты: поставить пароль нельзя
	// (errNoSecret), а уже стоящий не пускает никого — форма молчит, но не
	// открывается. Молча пускать было бы ровно тем, от чего пароль ставили.
	secret []byte
	now    func() time.Time // срок токена разблокировки; подменяется в тестах
	// ai — модель, собирающая план формы (фаза 26). Подключается сеттером по тому
	// же доводу, что files и secret. nil = генерации на контуре нет: ручка
	// отвечает 404, остальной модуль работает как раньше.
	ai Generator
}

// AnswerFiles — коллаборатор из модуля answerfiles: снос файлов удаляемой формы.
// Реализация — *answerfiles.Service; связь ставится в main (обратный импорт
// невозможен — answerfiles уже зависит от forms).
type AnswerFiles interface {
	RemoveByForm(ctx context.Context, formID uuid.UUID) error
}

func NewService(db postgres.DBTX, tx Transactor, repo Store, access Access, plans Plans) *Service {
	return &Service{db: db, tx: tx, repo: repo, access: access, plans: plans, now: time.Now}
}

// WithSecret подключает секрет токена формы: из него выводятся ключ шифрования
// пароля формы и подпись токенов разблокировки (0047).
func (s *Service) WithSecret(secret []byte) *Service {
	s.secret = secret
	return s
}

// WithFiles подключает модуль файлов ответов (тот же приём, что WithFiles у
// submissions): без него удаление формы оставило бы её файлы в бакете навсегда.
func (s *Service) WithFiles(f AnswerFiles) *Service {
	s.files = f
	return s
}

// resolveWorkspace превращает «в каком пространстве работаем» в id и проверяет
// право на него.
//
// nil означает личное пространство — это сохраняет поведение ссылок, не знающих
// про параметр, и права на него не спрашивают: оно и есть пространство
// спрашивающего. Явно названное ПРОВЕРЯЕТСЯ на право названного действия: id из
// запроса правом доступа не является (инвариант 1).
func (s *Service) resolveWorkspace(ctx context.Context, userID uuid.UUID, explicit *uuid.UUID, action domain.Action) (uuid.UUID, error) {
	if explicit == nil {
		wsID, err := s.repo.GetPersonalWorkspace(ctx, s.db, userID)
		if err != nil {
			return uuid.Nil, fmt.Errorf("resolve workspace: %w", err)
		}
		return wsID, nil
	}
	if err := s.access.Can(ctx, *explicit, userID, action); err != nil {
		return uuid.Nil, err
	}
	return *explicit, nil
}

// Create создаёт форму в указанном пространстве (nil = личное) с пустым
// черновиком.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, title string, workspaceID *uuid.UUID) (Form, error) {
	title = normalizeCreateTitle(title)
	if err := validateTitleLen(title); err != nil {
		return Form{}, err
	}
	wsID, err := s.resolveWorkspace(ctx, userID, workspaceID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	form, err := s.repo.CreateForm(ctx, s.db, domain.NewID(), wsID, title, domain.NewSlug())
	if err != nil {
		return Form{}, err
	}
	return form, nil
}

// CreateFromSchema создаёт форму сразу с документом — путь создания из шаблона
// (internal/templates). Одним запросом, а не «создать пустую и дописать
// схему»: сорвись второй запрос прежней пары, автор получал бы на дашборде
// пустую форму вместо заготовки.
//
// title — запасное имя: колонка forms.title зеркалит блок form_title документа
// (спека §3.3), и звать переданное имя приходится только тогда, когда документ
// о заголовке не высказался вовсе.
func (s *Service) CreateFromSchema(ctx context.Context, userID uuid.UUID, workspaceID *uuid.UUID, title string, rawSchema json.RawMessage) (Form, error) {
	parsed, err := domain.ValidateSchema(rawSchema)
	if err != nil {
		return Form{}, err
	}
	canonical, err := json.Marshal(parsed)
	if err != nil {
		return Form{}, fmt.Errorf("marshal schema: %w", err)
	}
	if docTitle, spoke := domain.FormTitle(parsed); spoke {
		title = docTitle
	}
	title = normalizeCreateTitle(title)
	if err := validateTitleLen(title); err != nil {
		return Form{}, err
	}
	wsID, err := s.resolveWorkspace(ctx, userID, workspaceID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	return s.repo.CreateFormWithSchema(ctx, s.db, domain.NewID(), wsID, title, domain.NewSlug(), nil, canonical)
}

// Duplicate создаёт копию формы в том же воркспейсе: копирует черновик схемы и
// ПУБЛИЧНЫЙ заголовок (title) как есть, а внутреннему имени (name) даёт «{база}
// (копия N)» — N подбирается без коллизий по соседям воркспейса (см. nextCopyName).
// Так суффикс копии виден только в кабинете, публичный заголовок остаётся чистым.
// Копия всегда draft (публикация не переносится). Доступ проверяется как везде.
func (s *Service) Duplicate(ctx context.Context, userID, formID uuid.UUID) (Form, error) {
	src, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	siblings, err := s.repo.ListFormNames(ctx, s.db, src.WorkspaceID)
	if err != nil {
		return Form{}, err
	}
	name := nextCopyName(displayName(src.Name, src.Title), siblings)
	form, err := s.repo.CreateFormWithSchema(
		ctx, s.db, domain.NewID(), src.WorkspaceID, src.Title, domain.NewSlug(), &name, src.DraftSchema,
	)
	if err != nil {
		return Form{}, err
	}
	return form, nil
}

// UpdateName задаёт внутреннее имя формы (переименование на дашборде). Пустая строка
// после trim → сбрасываем имя в NULL (кабинет вернётся к показу публичного заголовка).
// Публичного заголовка (title) не касается. Доступ — как везде (инвариант 1).
func (s *Service) UpdateName(ctx context.Context, userID, formID uuid.UUID, name string) (Form, error) {
	name = strings.TrimSpace(name)
	if err := validateTitleLen(name); err != nil {
		return Form{}, err
	}
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	var namePtr *string
	if name != "" {
		namePtr = &name
	}
	updated, err := s.repo.UpdateFormName(ctx, s.db, form.ID, form.WorkspaceID, namePtr)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// List возвращает страницу форм личного воркспейса: поиск по отображаемому имени,
// порядок и курсор предыдущей страницы (nil для первой). Limit зажимается в
// допустимые границы, пустой Sort — умолчание.
func (s *Service) List(ctx context.Context, userID uuid.UUID, opts ListOptions) (Page, error) {
	limit := clampLimit(opts.Limit)
	sort := opts.Sort
	if sort == "" {
		sort = SortUpdated
	}
	// Курсор от другого порядка — ошибка ввода, а не повод молча пересортировать:
	// его ключ измеряет другую величину (см. Cursor).
	if opts.After != nil && opts.After.Sort != sort {
		return Page{}, fmt.Errorf("%w: курсор выдан для другой сортировки", domain.ErrValidation)
	}

	search := strings.TrimSpace(opts.Search)
	if utf8.RuneCountInString(search) > MaxSearchLen {
		return Page{}, fmt.Errorf("%w: строка поиска длиннее %d символов", domain.ErrValidation, MaxSearchLen)
	}

	wsID, err := s.resolveWorkspace(ctx, userID, opts.WorkspaceID, domain.ActionFormRead)
	if err != nil {
		return Page{}, err
	}

	// limit+1: «лишняя» строка означает, что есть следующая страница; сам её в
	// ответ не отдаём, а превращаем в курсор.
	fetch := int32(limit + 1)
	rows, err := s.repo.ListFormsPage(ctx, s.db, ListPageQuery{
		WorkspaceID: wsID,
		Sort:        string(sort),
		Search:      escapeLike(search),
		Status:      string(opts.Status),
		After:       opts.After,
		Limit:       fetch,
	})
	if err != nil {
		return Page{}, err
	}

	forms := make([]Form, len(rows))
	for i, r := range rows {
		forms[i] = r.Form
	}

	page := Page{Forms: forms}
	if len(rows) > limit {
		last := rows[limit-1]
		page.Forms = forms[:limit]
		page.NextCursor = &Cursor{SortKey: last.SortKey, ID: last.ID, Sort: sort}
	}
	return page, nil
}

// MaxSearchResults — потолок выдачи поиска по всем пространствам. Не постранично:
// поиск отвечает на «где эта форма», и человек, пролиставший двадцать несовпадений,
// уточнит запрос, а не нажмёт «ещё». Потолок здесь же и защищает от «а» одной
// буквой на аккаунте с сотней форм.
const MaxSearchResults = 20

// Search — формы по всем пространствам, где человек состоит.
//
// Отдельная операция, а не режим List: список живёт внутри ОДНОГО пространства и
// потому спрашивает право на него (`Can`), а поиск пространства не называет — их
// много. Право здесь держит сам запрос: соединение по членству физически не пускает
// в выдачу чужую форму (инвариант 1).
//
// Пустой запрос — ПУСТОЙ ОТВЕТ, а не отказ: строка поиска пуста ровно до первой
// набранной буквы, и 422 на этом состоянии был бы ошибкой на ровном месте.
func (s *Service) Search(ctx context.Context, userID uuid.UUID, query string) ([]SearchHit, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(q) > MaxSearchLen {
		return nil, fmt.Errorf("%w: строка поиска длиннее %d символов", domain.ErrValidation, MaxSearchLen)
	}
	return s.repo.SearchForms(ctx, s.db, userID, escapeLike(q), int32(MaxSearchResults))
}

// escapeLike обезвреживает спецсимволы шаблона LIKE в пользовательской строке
// поиска: без этого «50%» находит любую форму, а «_» — любой символ. Экранирующий
// символ — обратный слэш (умолчание LIKE в Postgres). Replacer идёт по строке
// одним проходом и не перечитывает то, что сам подставил, — поэтому слэши,
// добавленные к «%», не удваиваются повторно.
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// GetForAction — форма плюс проверка НАЗВАННОГО права на неё. Нужна соседним
// модулям (удаление ответа), которым мало права «прочитать форму»: у их
// действия своё право, и спрашивать надо именно его — иначе снятая ячейка
// матрицы молча не действует.
func (s *Service) GetForAction(ctx context.Context, userID, formID uuid.UUID, action domain.Action) (Form, error) {
	return s.formForUser(ctx, userID, formID, action)
}

// Get возвращает форму по id, если пользователь состоит в её воркспейсе.
func (s *Service) Get(ctx context.Context, userID, formID uuid.UUID) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormRead)
	if err != nil {
		return Form{}, err
	}
	return s.withPassword(ctx, form), nil
}

// GetBySlug возвращает форму по slug, если пользователь состоит в её воркспейсе.
// slug адресует форму в URL кабинета (редактор/ответы/шаринг), как публичный
// рендерер адресует /r/{slug}. Права даёт только членство в воркспейсе, не сам
// slug: чужая/несуществующая форма — domain.ErrNotFound (404, существование не
// раскрываем), как и в formForUser.
func (s *Service) GetBySlug(ctx context.Context, userID uuid.UUID, slug string) (Form, error) {
	form, err := s.formForUserBySlug(ctx, userID, slug, domain.ActionFormRead)
	if err != nil {
		return Form{}, err
	}
	return s.withPassword(ctx, form), nil
}

// UpdateCloseSettings заменяет настройки закрытия формы (дата/лимит/текст «приём
// закрыт»). Порядок как у UpdateTitle: валидация ввода (мусор → ErrValidation/422),
// проверка доступа (чужая/нет формы → 404), затем UPDATE. Настройки — живые колонки
// (не схема): применяются немедленно, публикации не требуют (ADR §10).
func (s *Service) UpdateCloseSettings(ctx context.Context, userID, formID uuid.UUID, settings domain.CloseSettings) (Form, error) {
	if err := domain.ValidateCloseSettings(settings); err != nil {
		return Form{}, err
	}
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	updated, err := s.repo.UpdateFormCloseSettings(ctx, s.db, form.ID, form.WorkspaceID, settings)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdateNotifyOnSubmission переключает уведомление владельцу о новом ответе (слайс
// D). Порядок как у UpdateCloseSettings: проверка доступа (чужая/нет формы → 404),
// затем UPDATE. Живая колонка — применяется немедленно, публикации не требует.
func (s *Service) UpdateNotifyOnSubmission(ctx context.Context, userID, formID uuid.UUID, enabled bool) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	updated, err := s.repo.UpdateFormNotifyOnSubmission(ctx, s.db, form.ID, form.WorkspaceID, enabled)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdateBranding переключает бейдж «Сделано в Trillix» (ADR §10, миграция 0038).
//
// ТАРИФ ЗДЕСЬ НЕ СПРАШИВАЕТСЯ, и это не забывчивость — тот же порядок, что у
// карточки ссылки: право стоит при ОТДАЧЕ публичной формы (ShowBadge), поэтому
// намерение сохраняется на любом плане и оживает сразу после апгрейда, а даунгрейд
// возвращает бейдж, ничего не стирая. Контрол при этом кабинет держит сам (EMBED
// §10): на бесплатном тарифе тумблер не выключается, а открывает разговор о тарифе.
func (s *Service) UpdateBranding(ctx context.Context, userID, formID uuid.UUID, show bool) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	updated, err := s.repo.UpdateBranding(ctx, s.db, form.ID, form.WorkspaceID, show)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdateBehavior заменяет раздел «Поведение» (0044, третья настройка — 0055):
// автопереход, хранение ответов в браузере респондента и ход назад по страницам.
// Тарифа ни у одной из трёх нет — ни здесь, ни на отдаче.
func (s *Service) UpdateBehavior(ctx context.Context, userID, formID uuid.UUID, autoJump, saveLocally, allowBack bool) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	updated, err := s.repo.UpdateFormBehavior(ctx, s.db, form.ID, form.WorkspaceID, autoJump, saveLocally, allowBack)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdateProgress переключает шкалу прогресса — индикатор шагов многостраничной
// формы (миграция 0040).
//
// Живая колонка, как бейдж: намерение доезжает до респондента без перепубликации.
// Тарифа у шкалы нет НИ ЗДЕСЬ, НИ НА ОТДАЧЕ — она открыта всем планам, поэтому
// публичный путь берёт намерение как есть, без «факта» поверх него.
func (s *Service) UpdateProgress(ctx context.Context, userID, formID uuid.UUID, show bool) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	updated, err := s.repo.UpdateProgress(ctx, s.db, form.ID, form.WorkspaceID, show)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdateCollectPartial переключает сбор незавершённых ответов (спека §10.0).
//
// ЕДИНСТВЕННОЕ МЕСТО В ПРОДУКТЕ, ГДЕ ТАРИФ ГЕЙТИТ СБОР, А НЕ ПОКАЗ (ADR §10):
// черновик — содержимое чужого ответа, и собирать его для владельца, который его не
// увидит, значит платить приватностью респондента без всякой выгоды.
//
// Право спрашивается только при ВКЛЮЧЕНИИ. Выключить обязан мочь кто угодно и
// когда угодно: запрет остановить сбор данных о людях был бы дефектом, а не гейтом.
func (s *Service) UpdateCollectPartial(ctx context.Context, userID, formID uuid.UUID, enabled bool) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	if enabled {
		d, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.SubmissionsPartial)
		if err != nil {
			return Form{}, err
		}
		if !d.Allowed {
			return Form{}, domain.ErrPlanRequired
		}
	}
	updated, err := s.repo.UpdateCollectPartial(ctx, s.db, form.ID, form.WorkspaceID, enabled)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdateNotifyEmail заменяет настройку письма о новом ответе (имя отправителя,
// Reply-To, тема, текст; миграция 0042). Порядок как у остальных живых настроек:
// валидация ввода, доступ (чужая/нет формы → 404), тариф, UPDATE.
//
// ТАРИФ СПРАШИВАЕТСЯ ЗДЕСЬ, в отличие от карточки ссылки: контрол держит кабинет
// (решение владельца 2026-08-29 — «менять может только платный»), и сохранение
// правки, которую интерфейс не даёт сделать, означало бы 402 в единственном месте,
// куда он всё-таки доедет, — в чужом клиенте. Второй раз право спрашивается при
// ОТПРАВКЕ письма (NotifyEmailFor): даунгрейд возвращает дефолтный шаблон сам.
//
// Снятие настройки (пустые поля) тариф НЕ спрашивает: вернуться к дефолтному письму
// вправе любой план — иначе даунгрейд запирал бы автора в чужой настройке.
func (s *Service) UpdateNotifyEmail(ctx context.Context, userID, formID uuid.UUID, n *domain.NotifyEmail) (Form, error) {
	if err := domain.ValidateNotifyEmail(n); err != nil {
		return Form{}, err
	}
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	if !n.Empty() {
		d, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.FormNotifyEmail)
		if err != nil {
			return Form{}, err
		}
		if !d.Allowed {
			return Form{}, domain.ErrPlanRequired
		}
	}
	updated, err := s.repo.UpdateFormNotifyEmail(ctx, s.db, form.ID, form.WorkspaceID, n)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// NotifyEmailFor — настройка письма, действующая для этого воркспейса ПРЯМО СЕЙЧАС:
// nil значит «слать дефолтным шаблоном». Спрашивается на отправке, а не берётся из
// колонки напрямую, ровно затем, чтобы даунгрейд возвращал дефолтное письмо сам.
//
// Сбой опроса тарифа даёт дефолтный шаблон, а не отказ: письмо обязано уйти, а
// «не тем текстом» дешевле, чем «никаким».
func (s *Service) NotifyEmailFor(ctx context.Context, workspaceID uuid.UUID, n *domain.NotifyEmail) (*domain.NotifyEmail, error) {
	if n.Empty() {
		return nil, nil
	}
	d, err := s.plans.CheckWorkspace(ctx, workspaceID, entitlements.FormNotifyEmail)
	if err != nil {
		return nil, err
	}
	if !d.Allowed {
		return nil, nil
	}
	return n, nil
}

// UpdateNotifyRespondent переключает письмо респонденту (0046).
//
// ТАРИФ СПРАШИВАЕТСЯ ТОЛЬКО НА ВКЛЮЧЕНИИ, и гейт здесь тяжелее, чем у письма
// владельцу: там платной является перебивка текста, здесь — сама отправка. Выключить
// вправе любой план: даунгрейд не имеет права запирать автора в рассылке, которую он
// уже не может остановить.
//
// Второй раз право спрашивается ПРИ ОТПРАВКЕ каждого письма (submissions): тумблер,
// включённый на платном тарифе, обязан замолчать сам, ничего не стирая.
func (s *Service) UpdateNotifyRespondent(ctx context.Context, userID, formID uuid.UUID, enabled bool) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	if enabled {
		d, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.FormRespondentEmail)
		if err != nil {
			return Form{}, err
		}
		if !d.Allowed {
			return Form{}, domain.ErrPlanRequired
		}
	}
	updated, err := s.repo.UpdateFormNotifyRespondent(ctx, s.db, form.ID, form.WorkspaceID, enabled)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdateRespondentEmail заменяет бланк письма респонденту (0046). Порядок тот же,
// что у UpdateNotifyEmail: валидация ввода, доступ, тариф, UPDATE.
//
// Существование вопроса-источника здесь НЕ проверяется (domain.RespondentEmail):
// схему правят на другом экране, и 422 за удалённый вопрос ронял бы сохранение
// настроек за чужую правку полотна.
func (s *Service) UpdateRespondentEmail(ctx context.Context, userID, formID uuid.UUID, r *domain.RespondentEmail) (Form, error) {
	if err := domain.ValidateRespondentEmail(r); err != nil {
		return Form{}, err
	}
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	if !r.Empty() {
		d, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.FormRespondentEmail)
		if err != nil {
			return Form{}, err
		}
		if !d.Allowed {
			return Form{}, domain.ErrPlanRequired
		}
	}
	updated, err := s.repo.UpdateFormRespondentEmail(ctx, s.db, form.ID, form.WorkspaceID, r)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdateLinkPreview заменяет карточку ссылки формы (имя площадки, заголовок,
// описание, картинка, иконка). Порядок как у UpdateCloseSettings: валидация ввода,
// проверка доступа (чужая/нет формы → 404), затем UPDATE.
//
// ТАРИФ ЗДЕСЬ НЕ СПРАШИВАЕТСЯ, и это не забывчивость. Гейт стоит при отдаче
// публичной страницы (LinkPreviewFor ниже) — так автор на любом плане может
// настроить карточку и увидеть предпросмотр, то есть узнать, за что ему предлагают
// платить. Отказ на сохранении означал бы покупку вслепую; кроме того, апгрейд
// обязан оживлять уже сохранённое, а не требовать набрать всё заново.
func (s *Service) UpdateLinkPreview(ctx context.Context, userID, formID uuid.UUID, p *domain.LinkPreview) (Form, error) {
	if err := domain.ValidateLinkPreview(p); err != nil {
		return Form{}, err
	}
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	updated, err := s.repo.UpdateFormLinkPreview(ctx, s.db, form.ID, form.WorkspaceID, p)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// LinkPreviewFor — карточка ссылки, действующая для ЭТОЙ формы прямо сейчас: nil
// значит «показывать дефолты» (имя сервиса, заголовок формы, общий слоган, брендовая
// картинка).
//
// Решается ПРИ ОТДАЧЕ, а не при сохранении, и это тот же приём, что у бейджа
// (ShowBadge) и сбора черновиков (CollectPartial): в колонке лежит НАМЕРЕНИЕ
// автора, а факт — намерение плюс разрешение тарифа. Даунгрейд возвращает
// дефолтную карточку немедленно, апгрейд оживляет сохранённую без единой правки.
//
// Цена на публичном пути нулевая для большинства форм: карточку не настраивали —
// спрашивать нечего, в БД не идём вовсе. Платит только форма со своей карточкой, и
// ровно одним чтением по первичным ключам.
func (s *Service) LinkPreviewFor(ctx context.Context, workspaceID uuid.UUID, p *domain.LinkPreview) (*domain.LinkPreview, error) {
	if p.Empty() {
		return nil, nil
	}
	d, err := s.plans.CheckWorkspace(ctx, workspaceID, entitlements.FormLinkPreview)
	if err != nil {
		// «Спросить не удалось» — не «можно» (BILLING.md §9). Форма отдаётся с
		// дефолтной карточкой: сбой тарифов не имеет права ронять публичную
		// страницу, а дефолтное превью у платящего — меньшее из зол, чем платная
		// возможность, розданная по ошибке.
		return nil, err
	}
	if !d.Allowed {
		return nil, nil
	}
	return p, nil
}

// CollectPartial — собирать ли черновики у ЭТОЙ публичной формы прямо сейчас.
//
// Решается ПРИ ОТДАЧЕ, а не только при включении тумблера, и это тот же приём, что
// у бейджа (ShowBadge выше): в колонке лежит НАМЕРЕНИЕ автора, а факт — намерение
// плюс разрешение тарифа. Даунгрейд обязан останавливать сбор чужих данных
// немедленно, не дожидаясь, пока владелец вспомнит про тумблер.
//
// Цена на горячем публичном пути нулевая для большинства форм: тумблер выключен —
// спрашивать нечего, в БД не идём вовсе.
func (s *Service) CollectPartial(ctx context.Context, workspaceID uuid.UUID, intent bool) (bool, error) {
	if !intent {
		return false, nil
	}
	d, err := s.plans.CheckWorkspace(ctx, workspaceID, entitlements.SubmissionsPartial)
	if err != nil {
		// «Спросить не удалось» — не «можно» (BILLING.md §9). Сбор чужих данных при
		// сбое тарифов не начинается: лишний невзятый черновик дешевле, чем
		// собранный без права.
		return false, err
	}
	return d.Allowed, nil
}

// SubmissionOwner отдаёт адресата уведомления о новом ответе (email владельца +
// имя формы). Вызывается модулем submissions в приёме ответа — форма уже резолвнута
// по slug, поэтому проверки членства нет (это адресат, а не доступ пользователя).
func (s *Service) SubmissionOwner(ctx context.Context, formID uuid.UUID) (Owner, error) {
	return s.repo.GetSubmissionOwner(ctx, s.db, formID)
}

// UpdateDraftSchema сохраняет черновик схемы формы (автосейв билдера). Порядок:
// строгая валидация документа (мусор → ErrValidation/422), проверка доступа
// (чужая/нет формы → 404), затем условный UPDATE с оптимистичной блокировкой по
// expectedUpdatedAt (расхождение → ErrConflict/409). В БД пишется канонизированная
// схема (перемаршалённый результат ValidateSchema), а не сырые байты клиента.
func (s *Service) UpdateDraftSchema(ctx context.Context, userID, formID uuid.UUID, rawSchema json.RawMessage, expectedUpdatedAt time.Time) (Form, error) {
	parsed, err := domain.ValidateSchema(rawSchema)
	if err != nil {
		return Form{}, err
	}
	canonical, err := json.Marshal(parsed)
	if err != nil {
		return Form{}, fmt.Errorf("marshal schema: %w", err)
	}

	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}

	updated, err := s.repo.UpdateFormDraftSchema(ctx, s.db, form.ID, form.WorkspaceID, canonical, titleMirror(parsed), expectedUpdatedAt)
	if err != nil {
		// Доступ уже подтверждён выше — 0 строк означает, что updated_at сдвинули
		// параллельно (другая вкладка), а не отсутствие/чужую форму.
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrConflict
		}
		return Form{}, err
	}
	return updated, nil
}

// DiscardDraft возвращает черновик к опубликованной версии (плашка «Есть изменения»
// в шапке редактора): схема снапшота переписывает draft_schema с той же
// оптимистичной блокировкой, что у автосейва, — расхождение updated_at → ErrConflict.
// Форма без опубликованной версии → ErrValidation. Зеркало заголовка двигается вместе
// со схемой, как в UpdateDraftSchema.
//
// Возвращает форму, перечитанную целиком: RETURNING обновления не несёт настроек
// формы, и кабинет, положив такой ответ в кэш детали, затёр бы их.
func (s *Service) DiscardDraft(ctx context.Context, userID, formID uuid.UUID, expectedUpdatedAt time.Time) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	if form.PublishedVersion == nil {
		return Form{}, fmt.Errorf("%w: у формы нет опубликованной версии", domain.ErrValidation)
	}

	versions, err := s.repo.ListFormVersions(ctx, s.db, form.ID)
	if err != nil {
		return Form{}, err
	}
	var snapshot json.RawMessage
	for _, v := range versions {
		if v.Number == *form.PublishedVersion {
			snapshot = v.Schema
			break
		}
	}
	if snapshot == nil {
		return Form{}, fmt.Errorf("discard draft of form %s: published version %d not found", form.ID, *form.PublishedVersion)
	}
	parsed, err := domain.ValidateSchema(snapshot)
	if err != nil {
		return Form{}, err
	}

	if _, err := s.repo.UpdateFormDraftSchema(ctx, s.db, form.ID, form.WorkspaceID, snapshot, titleMirror(parsed), expectedUpdatedAt); err != nil {
		// Доступ подтверждён выше — 0 строк означает сдвинутый updated_at: автосейв,
		// другая вкладка или публикация между чтением версии и записью.
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrConflict
		}
		return Form{}, err
	}
	return s.Get(ctx, userID, formID)
}

// titleMirror — зеркало заголовка (фаза 15, спека §3.3): источник — блок form_title
// документа, колонка forms.title производна от него. Документ не высказался (схема
// снята до фазы) → nil, колонку не трогаем. Высказался пустым (автор стёр заголовок) →
// колонка получает служебное имя: она NOT NULL, и дашборду нужно чем-то назвать
// строку списка. Респонденту это имя не достаётся — публичный путь спрашивает
// документ (FormTitle), а не колонку.
func titleMirror(parsed domain.FormSchema) *string {
	title, spoke := domain.FormTitle(parsed)
	if !spoke {
		return nil
	}
	t := strings.TrimSpace(title)
	if t == "" {
		t = defaultFormTitle
	}
	return &t
}

// BookingGuard — сколько живых будущих записей держит форма (фаза 27). Реализация —
// *booking.Guard; nil = записи на контуре нет, и стоп-кран не спрашивается.
type BookingGuard interface {
	FutureOfForm(ctx context.Context, formID uuid.UUID) (int64, error)
}

// WithBookingGuard подключает стоп-кран удаления.
func (s *Service) WithBookingGuard(g BookingGuard) *Service {
	s.bookingGuard = g
	return s
}

// Delete удаляет форму (после проверки доступа).
func (s *Service) Delete(ctx context.Context, userID, formID uuid.UUID) error {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormDelete)
	if err != nil {
		return err
	}
	// СТОП-КРАН ЗАПИСИ (ADR §10): у формы есть живые будущие встречи. Молча снести
	// чужие договорённости нельзя — сначала отмена, и это тот шаг, на котором
	// записавшимся уходит письмо. Прошлые записи удалению не мешают.
	if s.bookingGuard != nil {
		n, err := s.bookingGuard.FutureOfForm(ctx, form.ID)
		if err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: у формы %s — сначала отмените их в расписании",
				domain.ErrConflict, domain.Plural(n, "будущая запись", "будущие записи", "будущих записей"))
		}
	}
	// Файлы ответов — ПЕРЕД строкой формы: каскад унесёт строки загрузок вместе с
	// ключами объектов, и найти оставшееся в бакете будет уже нечем. Сбой
	// останавливает удаление: лучше отказать автору (он повторит), чем оставить в
	// хранилище чужие персональные данные без единой записи о них.
	if s.files != nil {
		if err := s.files.RemoveByForm(ctx, form.ID); err != nil {
			return err
		}
	}
	n, err := s.repo.DeleteForm(ctx, s.db, form.ID, form.WorkspaceID)
	if err != nil {
		return err
	}
	if n == 0 {
		// Форму успели удалить между проверкой и удалением — для клиента её нет.
		return domain.ErrNotFound
	}
	return nil
}

// Publish публикует форму: снимает иммутабельный снапшот текущего черновика в новую
// версию (version = max+1) и переводит форму в published, привязывая эту версию —
// одной транзакцией (инвариант «версия + published_version_id атомарны»). Черновик
// перед снапшотом валидируется (ValidateSchema): в БД он и так канонизирован, но
// публикация — «точка невозврата», проверяем ещё раз. Повторная публикация (в т.ч.
// после закрытия) даёт следующий номер версии.
func (s *Service) Publish(ctx context.Context, userID, formID uuid.UUID) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}

	parsed, err := domain.ValidateSchema(form.DraftSchema)
	if err != nil {
		return Form{}, err
	}

	// ГЕЙТ ЗАПИСИ НА ВРЕМЯ: блок «Запись» есть, а расписание не выбрано (фаза 27,
	// решение владельца 2026-09-03). Здесь, а не на сохранении, и по тому же доводу,
	// что у гейта оформления: черновик в промежуточном состоянии обязан сохраняться,
	// иначе автосейв отвечает 422 посреди работы.
	//
	// Молча опубликовать такую форму нельзя: респондент увидел бы вопрос о времени,
	// который ничего не предлагает, — то есть форму, которая обещает распорядок и не
	// имеет его. Обратный перекос (расписание выбрано, блока нет) публикацию не
	// держит: это законное состояние, о нём предупреждает экран настроек.
	if form.ScheduleID == nil && domain.HasSlot(parsed) {
		return Form{}, fmt.Errorf("%w: в форме есть вопрос о записи, но расписание не выбрано — выберите его в блоке «Онлайн-запись»",
			domain.ErrValidation)
	}

	// ВТОРАЯ ПОЛОВИНА ТОГО ЖЕ ГЕЙТА: запись есть, а обязательного вопроса о почте нет
	// (отчёт владельца 2026-09-04). Письмо о записи — единственный носитель ССЫЛКИ
	// ОТМЕНЫ, и без адреса оно молча не уходит: человек не может отказаться, а место
	// стоит занятым до самого приёма. Молчание тут хуже отказа — автор узнаёт о нём
	// не на публикации, а от клиента, который не пришёл.
	if domain.SlotNeedsEmail(parsed) {
		return Form{}, fmt.Errorf("%w: в форме есть вопрос о записи — добавьте обязательный вопрос «Email», иначе записавшемуся некуда прислать ссылку отмены",
			domain.ErrValidation)
	}

	// ГЕЙТ ОФОРМЛЕНИЯ — ЗДЕСЬ, А НЕ НА СОХРАНЕНИИ (спека design/theme.md §9.3).
	// Автосейв не имеет права вернуть 402 посреди набора: промежуточное состояние
	// документа обязано сохраняться — тот же довод, по которому фаза 21 отказалась
	// от кросс-блочной валидации. Черновик со своими цветами на бесплатном тарифе
	// живёт и сохраняется; стена встаёт ровно на публикации.
	//
	// Порядок проверок обязателен: авторизация уже прошла выше (formForUser), тариф
	// спрашивается только после неё — иначе код ответа рассказывал бы постороннему о
	// существовании чужой формы и о плане чужого воркспейса (BILLING.md §8).
	//
	// Даунгрейд ничего не замораживает: опубликованный снапшот иммутабелен, форма
	// продолжает выглядеть как выглядела — за неё платили тогда. Стена встаёт на
	// СЛЕДУЮЩЕЙ публикации.
	if paid := domain.DesignPaidFeatures(parsed.Design); len(paid) > 0 {
		d, e := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.FormDesignCustom)
		if e != nil {
			return Form{}, e
		}
		if !d.Allowed {
			return Form{}, fmt.Errorf("%w: своё оформление доступно на платном тарифе — мешает: %s",
				domain.ErrPlanRequired, strings.Join(paid, ", "))
		}
	}

	// СВОЙ CSS — ОТДЕЛЬНЫЙ КЛЮЧ И ОТДЕЛЬНАЯ ПРОВЕРКА, а не строка в списке платных
	// настроек выше: это не настройка, а доступ к вёрстке, и стоит он дороже (спека
	// §9.1). Слить их в один ключ значило бы навсегда лишить себя возможности продать
	// цвета дешевле CSS — а именно так тариф и раскладывается.
	//
	// Спрашивается вторым: у автора, которому не хватает обоих, первым в отказе
	// назовётся оформление — то, что он трогал руками в панели, а не поле для CSS.
	if parsed.Design != nil && strings.TrimSpace(parsed.Design.CSS) != "" {
		d, e := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.FormCustomCSS)
		if e != nil {
			return Form{}, e
		}
		if !d.Allowed {
			return Form{}, fmt.Errorf("%w: свой CSS доступен на платном тарифе", domain.ErrPlanRequired)
		}
	}

	snapshot, err := json.Marshal(parsed)
	if err != nil {
		return Form{}, fmt.Errorf("marshal schema: %w", err)
	}

	var published Form
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		version, e := s.repo.NextFormVersion(ctx, tx, form.ID)
		if e != nil {
			return e
		}
		versionID, e := s.repo.InsertFormVersion(ctx, tx, domain.NewID(), form.ID, version, snapshot)
		if e != nil {
			return e
		}
		published, e = s.repo.SetFormPublished(ctx, tx, form.ID, form.WorkspaceID, versionID)
		if e != nil {
			// Доступ подтверждён выше — 0 строк значит форму удалили параллельно.
			if errors.Is(e, pgx.ErrNoRows) {
				return domain.ErrNotFound
			}
			return e
		}
		// SetFormPublished номер версии не выбирает (см. queries.sql) — проставляем
		// только что вставленный.
		published.PublishedVersion = &version
		return nil
	})
	if err != nil {
		return Form{}, err
	}
	return published, nil
}

// Reopen открывает закрытую форму: status='published', БЕЗ новой версии.
// Респонденты видят ту же версию, что до закрытия (published_version_id закрытие
// сохраняло).
//
// Публикацией это делать нельзя, хотя она дала бы тот же статус: публикация поднимет
// номер версии, не изменив ни строчки документа, — а номер версии в продукте значит
// «что именно видели респонденты», и накрутить его тумблером значит соврать. По той
// же причине черновик открыть нечем: публиковать его — отдельное осознанное действие
// автора, а не побочный эффект переключателя.
func (s *Service) Reopen(ctx context.Context, userID, formID uuid.UUID) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	if form.Status != domain.FormStatusClosed {
		return Form{}, fmt.Errorf("%w: открыть можно только закрытую форму", domain.ErrValidation)
	}
	if form.PublishedVersionID == nil {
		return Form{}, fmt.Errorf("%w: у формы нет опубликованной версии", domain.ErrValidation)
	}
	reopened, err := s.repo.SetFormReopened(ctx, s.db, form.ID, form.WorkspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return reopened, nil
}

// Unpublish снимает форму с публикации: status='closed'. published_version_id и его
// номер сохраняются (кабинет покажет «Закрыта · была версия N»). Одиночный UPDATE —
// транзакция не нужна.
func (s *Service) Unpublish(ctx context.Context, userID, formID uuid.UUID) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	closed, err := s.repo.SetFormClosed(ctx, s.db, form.ID, form.WorkspaceID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	// SetFormClosed номер версии не выбирает — переносим из прочитанной формы (закрытие
	// published_version_id не меняет).
	closed.PublishedVersion = form.PublishedVersion
	return closed, nil
}

// PublicForm возвращает публичную форму по slug для рендерера и приёма ответа —
// вместе со статусом и настройками закрытия. Без проверки воркспейса (форма
// публична). Черновик и несуществующая → domain.ErrNotFound (404, приватное не
// раскрывается). Закрытую (снятую вручную ИЛИ по дате/лимиту) ОТДАЁТ: вызывающий
// вычисляет domain.FormClosed и показывает «приём закрыт» вместо 404 — форма была
// публичной (инвариант 5 распространяется только на черновик; ADR §10, шаг 4).
func (s *Service) PublicForm(ctx context.Context, slug string) (PublicForm, error) {
	pf, err := s.repo.GetPublicFormBySlug(ctx, s.db, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PublicForm{}, domain.ErrNotFound
		}
		return PublicForm{}, err
	}
	// Заголовок публикуется вместе со схемой (фаза 15, решение владельца): у
	// опубликованной версии он берётся из ЕЁ документа, а не из живой колонки —
	// как и всё остальное на полотне. Колонка остаётся фолбэком навсегда: версии,
	// снятые до фазы, блока form_title не несут, и заголовок у них только там.
	//
	// Разрешаем в одном месте на всех потребителей (страница с OG-метой, JSON
	// рендерера, тело 410): резолвинг в каждом хендлере по отдельности — это три
	// шанса разойтись в трактовке «пусто».
	//
	// Разбор ОСТАЁТСЯ в строке (pf.Parsed/pf.ParseErr), а не выбрасывается: те же
	// байты нужны приёму ответа, автосохранению, слоту файла и отдаче тела, и
	// каждый из них разбирал их во второй раз (TD-77). Отказ разбора не возвращается
	// ошибкой — вызывающие расходятся в отношении к битой схеме, и оба отношения
	// законны (см. PublicForm.ParseErr).
	return WithDocument(pf), nil
}

// WithDocument разбирает документ формы и разрешает по нему заголовок — единственное
// место, где это делается. Экспортирована не ради переиспользования в проде (зовёт её
// только PublicForm выше), а ради ЧУЖИХ ТЕСТОВ: фейки submissions, answerfiles,
// booking и visits собирают PublicForm литералом, и без этой функции у них Parsed
// остался бы пустым при непустой Schema. Тест тогда проверял бы форму без вопросов
// там, где сервис отдаёт форму с вопросами, — и молча зеленел бы.
func WithDocument(pf PublicForm) PublicForm {
	pf.Parsed, pf.ParseErr = domain.ValidateSchema(pf.Schema)
	if pf.ParseErr == nil {
		if title, spoke := domain.FormTitle(pf.Parsed); spoke {
			pf.Title = title
		}
	}
	return pf
}

// PublicFormRef — публичная форма БЕЗ документа: для путей, которым схема не нужна
// вовсе (бикон визита, свободное время, холд). Отказ «формы нет» — тот же 404, что у
// PublicForm, и по тем же причинам: черновик, осиротевшее пространство, удалённый
// владелец.
//
// Заголовка здесь нет и быть не может: он живёт в документе. Понадобился заголовок —
// значит, нужен и документ, и звать надо PublicForm.
func (s *Service) PublicFormRef(ctx context.Context, slug string) (PublicFormRef, error) {
	ref, err := s.repo.GetPublicFormRefBySlug(ctx, s.db, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PublicFormRef{}, domain.ErrNotFound
		}
		return PublicFormRef{}, err
	}
	return ref, nil
}

// MaxFormPasswordLen — потолок пароля формы в рунах. Минимума нет намеренно: это
// не пароль аккаунта, а общий секрет для своих, и требовать от автора «восемь
// символов и цифру» для опроса среди коллег незачем. Пустая строка сюда не доходит
// вовсе — она означает «снять пароль» (nil).
const MaxFormPasswordLen = 128

// UpdateSchedule ставит или снимает расписание записи у формы (фаза 27). Живая
// колонка: смена действует со следующего же ответа, без перепубликации.
//
// РАСПИСАНИЕ ОБЯЗАНО БЫТЬ ИЗ ТОГО ЖЕ ПРОСТРАНСТВА, и проверяет это сервис: id
// приезжает из тела запроса и правом доступа не является (инвариант 1). Без проверки
// форма ссылалась бы на чужое расписание по угаданному id, а публичная выдача
// показывала бы чужую занятость.
func (s *Service) UpdateSchedule(ctx context.Context, userID, formID uuid.UUID, scheduleID *uuid.UUID) (Form, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	if scheduleID != nil {
		ok, err := s.repo.ScheduleInWorkspace(ctx, s.db, *scheduleID, form.WorkspaceID)
		if err != nil {
			return Form{}, err
		}
		if !ok {
			// 404, а не 403: чужое расписание для этой формы неотличимо от
			// несуществующего — существование чужого не раскрывается (инвариант 5).
			return Form{}, domain.ErrNotFound
		}
	}
	updated, err := s.repo.UpdateFormSchedule(ctx, s.db, form.ID, form.WorkspaceID, scheduleID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// UpdatePassword ставит или снимает пароль формы (0047). nil = снять.
//
// Тарифа здесь НЕТ вовсе: пароль бесплатен на всех планах (решение владельца
// 2026-09-01, design/form-password.md §2.2) — он про приватность, а не про объём.
// Живая колонка: и постановка, и снятие действуют без перепубликации.
func (s *Service) UpdatePassword(ctx context.Context, userID, formID uuid.UUID, password *string) (Form, error) {
	var sealed []byte
	if password != nil {
		// Пробелы НЕ тримятся: пароль — это ровно та строка, которую автор разослал
		// участникам, и молча отрезать от неё край значило бы, что скопированный из
		// настроек пароль не подходит к собственной форме.
		if *password == "" {
			return Form{}, fmt.Errorf("%w: пароль не может быть пустым", domain.ErrValidation)
		}
		if utf8.RuneCountInString(*password) > MaxFormPasswordLen {
			return Form{}, fmt.Errorf("%w: пароль длиннее %d символов", domain.ErrValidation, MaxFormPasswordLen)
		}
	}
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormWrite)
	if err != nil {
		return Form{}, err
	}
	if password != nil {
		// Шифруем ДО UPDATE: ненастроенный секрет обязан отказать, а не записать
		// пустоту, которую следующий читатель примет за «пароля нет».
		sealed, err = sealPassword(s.secret, *password)
		if err != nil {
			return Form{}, fmt.Errorf("seal form password %s: %w", form.ID, err)
		}
	}
	updated, err := s.repo.UpdateFormPassword(ctx, s.db, form.ID, form.WorkspaceID, sealed)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
}

// withPassword дополняет форму расшифрованным паролем — для экрана настроек: автор
// свой пароль видит и копирует (design/form-password.md §2.1).
//
// Сбой расшифровки НЕ роняет экран настроек: он означает ровно одно — секрет
// приложения сменили, и старый шифротекст больше не читается (ротация
// FORM_TOKEN_SECRET, S3.md-раннбук). Автору в этом случае честнее увидеть форму с
// включённым паролем и пустым полем — то есть «пароль стоит, но показать его нечем»,
// — чем пятисотку на странице настроек.
func (s *Service) withPassword(ctx context.Context, form Form) Form {
	if len(form.PasswordSealed) == 0 {
		return form
	}
	plain, err := openPassword(s.secret, form.PasswordSealed)
	if err != nil {
		httpserver.LoggerFrom(ctx).Error("расшифровка пароля формы",
			slog.String("form_id", form.ID.String()), slog.String("error", err.Error()))
		return form
	}
	form.Password = &plain
	return form
}

// Unlock сверяет пароль, названный респондентом, и выдаёт токен разблокировки на
// сутки. Неверный пароль и форма без пароля неотличимы снаружи (ErrFormLocked):
// подбирающему незачем узнавать, на какую форму пароль вообще стоит.
//
// СРАВНЕНИЕ — ПОСТОЯННОЕ ПО ВРЕМЕНИ: строки приходят от того, кого мы не знаем, и
// побайтовое сравнение с ранним выходом мерило бы длину общего префикса.
//
// Лимит попыток стоит ПЕРЕД этим вызовом, в транспорте (ведро по паре «IP + slug»),
// и списывается до сравнения — иначе верный пароль обходил бы исчерпанный лимит и
// подбор стоил бы ровно столько же.
func (s *Service) Unlock(ctx context.Context, slug, password string) (string, time.Time, error) {
	formID, sealed, err := s.repo.GetFormPasswordBySlug(ctx, s.db, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", time.Time{}, domain.ErrNotFound
		}
		return "", time.Time{}, err
	}
	if len(sealed) == 0 {
		// Пароля на форме нет — открывать нечего. 401, а не 200 с токеном: токен
		// «ни от чего» пришлось бы потом отличать от настоящего.
		return "", time.Time{}, domain.ErrFormLocked
	}
	plain, err := openPassword(s.secret, sealed)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("open form password %s: %w", formID, err)
	}
	if subtle.ConstantTimeCompare([]byte(plain), []byte(password)) != 1 {
		return "", time.Time{}, domain.ErrFormLocked
	}
	expiry := s.now().UTC().Add(unlockTTL)
	return issueUnlockToken(deriveUnlockSecret(s.secret), formID, sealed, expiry), expiry, nil
}

// VerifyUnlock — пускать ли этот запрос к содержимому формы. sealed — шифротекст
// пароля, лежащий в колонке ПРЯМО СЕЙЧАС: пустой означает «пароля нет», и тогда
// пропускаем всегда.
//
// Шифротекст, а не признак «пароль есть», ровно затем, чтобы СМЕНА ПАРОЛЯ ГАСИЛА
// выданные токены: он подмешан в подпись, и токен, выпущенный под прежний пароль,
// перестаёт сходиться в тот же момент, когда автор сохранил новый. Без этого автор,
// сменивший утёкший пароль, ещё сутки не мог бы никого отсечь.
//
// Живёт в forms, а не у каждого потребителя, по той же причине, что ShowBadge и
// CollectPartial: это решение о форме, и секрет подписи обязан лежать в одном месте.
// Зовут его четыре публичных входа — отдача формы, приём ответа, автосохранение и
// выдача слота файла (design/form-password.md §3.3).
func (s *Service) VerifyUnlock(formID uuid.UUID, sealed []byte, tok string) error {
	if len(sealed) == 0 {
		return nil
	}
	if validUnlockToken(deriveUnlockSecret(s.secret), tok, formID, sealed, s.now().UTC()) {
		return nil
	}
	return domain.ErrFormLocked
}

// ShowBadge — показывать ли бейдж «Сделано в Trillix» на публичной форме.
//
// РЕШАЕТСЯ ПРИ ЗАХОДЕ НА ФОРМУ — и намерение, и право. Намерение приезжает живой
// колонкой forms.branding (intent: true = показывать), а не полем схемы: бейдж не
// часть документа, как вопрос или заголовок, и снимать его перепубликацией формы
// автор не обязан (ADR §10, миграция 0038).
//
// Факт — намерение плюс разрешение тарифа. Положи мы факт в снапшот, один месяц
// оплаты навсегда снял бы бейдж со всех опубликованных в этот месяц форм: это не
// подписка, а разовая покупка. Обратная сторона того же решения — даунгрейд
// возвращает бейдж на уже опубликованную форму, в отличие от цветов, которые
// снапшот переживают.
//
// ЦЕНА ГЕЙТА НА ГОРЯЧЕМ ПУБЛИЧНОМ ПУТИ оказалась нулевой для большинства форм: без
// намерения автора спрашивать нечего — бейдж стоит, и в БД мы не идём вовсе. Платит
// только форма, которая бейдж снимала, и ровно одним чтением по первичным ключам.
func (s *Service) ShowBadge(ctx context.Context, workspaceID uuid.UUID, intent bool) (bool, error) {
	if intent {
		return true, nil
	}
	d, err := s.plans.CheckWorkspace(ctx, workspaceID, entitlements.FormBranding)
	if err != nil {
		// «Спросить не удалось» — не «можно» (BILLING.md §9). Бейдж остаётся:
		// публичная форма из-за сбоя тарифов упасть не имеет права, а лишний бейдж
		// у платящего — меньшее из зол, чем снятый у неплатящего.
		return true, err
	}
	return !d.Allowed, nil
}

// MetrikaFor — номер счётчика Яндекс Метрики, уезжающий на публичную форму:
// подключённый и включённый номер (приезжает строкой формы) плюс разрешение тарифа
// (ключ form_counters). nil — счётчика на странице нет.
//
// Природа бейджа: решается при заходе на форму, поэтому даунгрейд снимает счётчик
// сам, а апгрейд возвращает сохранённый. Без номера тариф не спрашивается вовсе —
// у подавляющего большинства форм счётчика нет, и платить поездкой в БД им нечем.
func (s *Service) MetrikaFor(ctx context.Context, workspaceID uuid.UUID, counter *string) (*string, error) {
	if counter == nil {
		return nil, nil
	}
	d, err := s.plans.CheckWorkspace(ctx, workspaceID, entitlements.FormCounters)
	if err != nil {
		// «Спросить не удалось» — не «можно» (BILLING.md §9): счётчика нет. Невзятая
		// статистика дешевле, чем чужой скрипт на странице без права.
		return nil, err
	}
	if !d.Allowed {
		return nil, nil
	}
	return counter, nil
}

// Versions возвращает все опубликованные версии формы (снапшоты схем) для её автора.
// Авторизация как у остальных операций по ресурсу (чужая/нет формы → 404). Пустой
// срез — форму ещё не публиковали. Нужен CSV-экспорту (модуль submissions).
// PublishedVersions отдаёт снапшоты версий формы БЕЗ проверки прав.
//
// ⚠ Единственный законный вызывающий — фоновая доставка (internal/integrations,
// фаза 25): там нет пользователя, чьё право можно спросить, а id формы взят не
// из URL, а из СВОЕЙ строки form_integrations, которую завёл человек с правом.
// Из обработчика приватного API этот метод не зовут — там есть Versions, и она
// авторизует (инвариант 1: id из запроса правом доступа не является).
func (s *Service) PublishedVersions(ctx context.Context, formID uuid.UUID) ([]Version, error) {
	return s.repo.ListFormVersions(ctx, s.db, formID)
}

func (s *Service) Versions(ctx context.Context, userID, formID uuid.UUID) ([]Version, error) {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormRead)
	if err != nil {
		return nil, err
	}
	return s.repo.ListFormVersions(ctx, s.db, form.ID)
}

// formForUser загружает форму и проверяет ПРАВО пользователя на названное
// действие в её пространстве. Действие передаётся вызывающим, а не
// подразумевается: «прочитать» и «удалить» — разные права, и место, где это
// видно, должно быть местом вызова.
//
// Отсутствие формы даёт ErrNotFound; отказ в праве разбирает Can (не участник →
// 404, участник без права → 403).
func (s *Service) formForUser(ctx context.Context, userID, formID uuid.UUID, action domain.Action) (Form, error) {
	form, err := s.repo.GetForm(ctx, s.db, formID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, action); err != nil {
		return Form{}, err
	}
	return form, nil
}

// formForUserBySlug — как formForUser, но грузит форму по slug.
func (s *Service) formForUserBySlug(ctx context.Context, userID uuid.UUID, slug string, action domain.Action) (Form, error) {
	form, err := s.repo.GetFormBySlug(ctx, s.db, slug)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, action); err != nil {
		return Form{}, err
	}
	return form, nil
}

func normalizeCreateTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return defaultFormTitle
	}
	return title
}

// displayName — отображаемое имя формы в кабинете: name, если задано, иначе title
// (фолбэк, ADR §10). Тем же правилом кабинет выбирает подпись карточки.
func displayName(name *string, title string) string {
	if name != nil && strings.TrimSpace(*name) != "" {
		return *name
	}
	return title
}

// copySuffixRe разбирает хвост «(копия)» / «(копия N)» отображаемого имени: группа 1 —
// база (имя без суффикса), группа 2 — номер (пусто для «(копия)»).
var copySuffixRe = regexp.MustCompile(`^(.*?)\s*\(копия(?:\s+(\d+))?\)$`)

// nextCopyName строит имя копии «{база} (копия N)». База — исходное имя без хвоста
// «(копия…)» (чтобы копия копии не стекала суффиксы). N — минимальный свободный: на
// 1 больше максимального среди уже существующих в воркспейсе копий той же базы (и
// самой базы, если она есть) — так дубли не дают одинаковых имён. Длинную базу
// обрезаем по рунам, чтобы суффикс влез в maxTitleLen.
func nextCopyName(srcDisplay string, siblings []FormName) string {
	base := stripCopySuffix(srcDisplay)
	maxN := 0
	for _, s := range siblings {
		if n, ok := copyIndex(base, displayName(s.Name, s.Title)); ok && n > maxN {
			maxN = n
		}
	}
	return copyName(base, maxN+1)
}

// stripCopySuffix отрезает хвост «(копия)» / «(копия N)», возвращая базу.
func stripCopySuffix(s string) string {
	if m := copySuffixRe.FindStringSubmatch(s); m != nil {
		return strings.TrimSpace(m[1])
	}
	return strings.TrimSpace(s)
}

// copyIndex возвращает «копийный индекс» имени s относительно base: 0 — само base,
// 1 — «base (копия)», N — «base (копия N)»; ok=false, если s к base не относится.
func copyIndex(base, s string) (int, bool) {
	if strings.TrimSpace(s) == base {
		return 0, true
	}
	m := copySuffixRe.FindStringSubmatch(s)
	if m == nil || strings.TrimSpace(m[1]) != base {
		return 0, false
	}
	if m[2] == "" {
		return 1, true
	}
	n, err := strconv.Atoi(m[2])
	if err != nil {
		return 0, false
	}
	return n, true
}

// copyName собирает «{база} (копия)» (n=1) или «{база} (копия N)» (n≥2), обрезая
// базу под maxTitleLen. Считаем руны — теми же единицами, что validateTitleLen.
func copyName(base string, n int) string {
	suffix := " (копия)"
	if n >= 2 {
		suffix = " (копия " + strconv.Itoa(n) + ")"
	}
	sufLen := utf8.RuneCountInString(suffix)
	if r := []rune(base); len(r)+sufLen > maxTitleLen {
		base = string(r[:maxTitleLen-sufLen])
	}
	return base + suffix
}

// validateTitleLen — потолок названия на СОЗДАНИИ формы (POST /forms {title}).
// Правка заголовка идёт только через документ (блок form_title, фаза 15), а
// создание остаётся законным входом для колонки: блоков у формы в этот момент нет.
// Считаем РУНЫ — как все лимиты схемы: до фазы 15 здесь были байты, и русское
// название обрезалось вдвое раньше латинского.
func validateTitleLen(title string) error {
	if utf8.RuneCountInString(title) > maxTitleLen {
		return fmt.Errorf("%w: название формы длиннее %d символов", domain.ErrValidation, maxTitleLen)
	}
	return nil
}

func clampLimit(limit int) int {
	switch {
	case limit <= 0:
		return DefaultPageLimit
	case limit > MaxPageLimit:
		return MaxPageLimit
	default:
		return limit
	}
}
