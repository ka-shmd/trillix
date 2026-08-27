package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
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
	ListFormsPage(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, sort string, search string, after *Cursor, limit int32) ([]ListRow, error)
	UpdateFormName(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, name *string) (Form, error)
	UpdateFormCloseSettings(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, s domain.CloseSettings) (Form, error)
	UpdateFormNotifyOnSubmission(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error)
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
}

// AnswerFiles — коллаборатор из модуля answerfiles: снос файлов удаляемой формы.
// Реализация — *answerfiles.Service; связь ставится в main (обратный импорт
// невозможен — answerfiles уже зависит от forms).
type AnswerFiles interface {
	RemoveByForm(ctx context.Context, formID uuid.UUID) error
}

func NewService(db postgres.DBTX, tx Transactor, repo Store, access Access, plans Plans) *Service {
	return &Service{db: db, tx: tx, repo: repo, access: access, plans: plans}
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
	rows, err := s.repo.ListFormsPage(ctx, s.db, wsID, string(sort), escapeLike(search), opts.After, fetch)
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
	return s.formForUser(ctx, userID, formID, domain.ActionFormRead)
}

// GetBySlug возвращает форму по slug, если пользователь состоит в её воркспейсе.
// slug адресует форму в URL кабинета (редактор/ответы/шаринг), как публичный
// рендерер адресует /r/{slug}. Права даёт только членство в воркспейсе, не сам
// slug: чужая/несуществующая форма — domain.ErrNotFound (404, существование не
// раскрываем), как и в formForUser.
func (s *Service) GetBySlug(ctx context.Context, userID uuid.UUID, slug string) (Form, error) {
	return s.formForUserBySlug(ctx, userID, slug, domain.ActionFormRead)
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

	// Зеркало заголовка (фаза 15, спека §3.3): источник — блок form_title документа,
	// колонка forms.title производна от него. Документ не высказался (схема снята до
	// фазы) → nil, колонку не трогаем. Высказался пустым (автор стёр заголовок) →
	// колонка получает служебное имя: она NOT NULL, и дашборду нужно чем-то назвать
	// строку списка. Респонденту это имя не достаётся — публичный путь спрашивает
	// документ (FormTitle), а не колонку.
	var mirror *string
	if title, spoke := domain.FormTitle(parsed); spoke {
		t := strings.TrimSpace(title)
		if t == "" {
			t = defaultFormTitle
		}
		mirror = &t
	}

	updated, err := s.repo.UpdateFormDraftSchema(ctx, s.db, form.ID, form.WorkspaceID, canonical, mirror, expectedUpdatedAt)
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

// Delete удаляет форму (после проверки доступа).
func (s *Service) Delete(ctx context.Context, userID, formID uuid.UUID) error {
	form, err := s.formForUser(ctx, userID, formID, domain.ActionFormDelete)
	if err != nil {
		return err
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
	if parsed, err := domain.ValidateSchema(pf.Schema); err == nil {
		if title, spoke := domain.FormTitle(parsed); spoke {
			pf.Title = title
		}
	}
	return pf, nil
}

// ShowBadge — показывать ли бейдж «Сделано в Trillix» на публичной форме.
//
// РЕШАЕТСЯ ПРИ ОТДАЧЕ, А НЕ ПРИ ПУБЛИКАЦИИ, и это осознанно (спека §9.4). В схеме
// лежит только НАМЕРЕНИЕ автора (`design.branding: false`), а факт — намерение плюс
// разрешение тарифа. Положи мы факт в снапшот, один месяц оплаты навсегда снял бы
// бейдж со всех опубликованных в этот месяц форм: это не подписка, а разовая
// покупка. Обратная сторона того же решения — даунгрейд возвращает бейдж на уже
// опубликованную форму, в отличие от цветов, которые снапшот переживают.
//
// ЦЕНА ГЕЙТА НА ГОРЯЧЕМ ПУБЛИЧНОМ ПУТИ (тот самый вопрос спеки) оказалась нулевой
// для большинства форм: без намерения автора спрашивать нечего — бейдж стоит, и в
// БД мы не идём вовсе. Платит только форма, которая бейдж снимала, и ровно одним
// чтением по первичным ключам.
func (s *Service) ShowBadge(ctx context.Context, workspaceID uuid.UUID, design *domain.FormDesign) (bool, error) {
	if design == nil || design.Branding == nil {
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
