package forms

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/postgres"
)

const (
	// defaultFormTitle — форма создаётся с этим названием, пользователь
	// переименовывает инлайн на дашборде.
	defaultFormTitle = "Untitled form"
	maxTitleLen      = 200

	// DefaultPageLimit / MaxPageLimit — размер страницы списка форм. Запрошенный
	// клиентом limit зажимается в [1, MaxPageLimit]; пустой → Default.
	DefaultPageLimit = 50
	MaxPageLimit     = 100
)

// Store — доступ к данным forms, объявленный на стороне потребителя (сервиса).
// Реализация — Repo; в тестах подменяется фейком. Методы принимают исполнителя
// (postgres.DBTX: пул или транзакция).
type Store interface {
	GetPersonalWorkspace(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (uuid.UUID, error)
	IsWorkspaceMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (bool, error)
	CreateForm(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, title, slug string) (Form, error)
	GetForm(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Form, error)
	ListForms(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, limit int32) ([]Form, error)
	ListFormsAfter(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, cursorUpdatedAt time.Time, cursorID uuid.UUID, limit int32) ([]Form, error)
	UpdateFormTitle(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, title string) (Form, error)
	UpdateFormDraftSchema(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, schema json.RawMessage, expectedUpdatedAt time.Time) (Form, error)
	DeleteForm(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (int64, error)
	NextFormVersion(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int32, error)
	InsertFormVersion(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, version int32, schema json.RawMessage) (uuid.UUID, error)
	SetFormPublished(ctx context.Context, db postgres.DBTX, id, workspaceID, versionID uuid.UUID) (Form, error)
	SetFormClosed(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (Form, error)
}

var _ Store = Repo{}

// Transactor открывает транзакцию (без знания о конкретном пуле). Реализация —
// postgres.TxRunner; в юнит-тестах — фейк, выполняющий fn без реальной БД.
// Публикация обязана быть атомарной: снапшот версии + published_version_id одной
// транзакцией (инвариант internal/CLAUDE.md).
type Transactor interface {
	WithTx(ctx context.Context, fn func(pgx.Tx) error) error
}

// Cursor — курсор списка форм: пара (updatedAt, id), однозначно указывающая на
// последнюю показанную форму. Транспорт кодирует его в непрозрачную строку.
type Cursor struct {
	UpdatedAt time.Time
	ID        uuid.UUID
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
	db   postgres.DBTX // пул: нетранзакционные операции (чтение, одиночные записи)
	tx   Transactor    // для атомарной публикации (версия + published_version_id)
	repo Store
}

func NewService(db postgres.DBTX, tx Transactor, repo Store) *Service {
	return &Service{db: db, tx: tx, repo: repo}
}

// Create создаёт форму в личном воркспейсе пользователя с пустым черновиком.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, title string) (Form, error) {
	title = normalizeCreateTitle(title)
	if err := validateTitleLen(title); err != nil {
		return Form{}, err
	}
	wsID, err := s.repo.GetPersonalWorkspace(ctx, s.db, userID)
	if err != nil {
		return Form{}, fmt.Errorf("resolve workspace: %w", err)
	}
	form, err := s.repo.CreateForm(ctx, s.db, domain.NewID(), wsID, title, domain.NewSlug())
	if err != nil {
		return Form{}, err
	}
	return form, nil
}

// List возвращает страницу форм личного воркспейса. after — курсор предыдущей
// страницы (nil для первой). limit зажимается в допустимые границы.
func (s *Service) List(ctx context.Context, userID uuid.UUID, after *Cursor, limit int) (Page, error) {
	limit = clampLimit(limit)
	wsID, err := s.repo.GetPersonalWorkspace(ctx, s.db, userID)
	if err != nil {
		return Page{}, fmt.Errorf("resolve workspace: %w", err)
	}

	// limit+1: «лишняя» строка означает, что есть следующая страница; сам её в
	// ответ не отдаём, а превращаем в курсор.
	fetch := int32(limit + 1)
	var rows []Form
	if after == nil {
		rows, err = s.repo.ListForms(ctx, s.db, wsID, fetch)
	} else {
		rows, err = s.repo.ListFormsAfter(ctx, s.db, wsID, after.UpdatedAt, after.ID, fetch)
	}
	if err != nil {
		return Page{}, err
	}

	page := Page{Forms: rows}
	if len(rows) > limit {
		last := rows[limit-1]
		page.Forms = rows[:limit]
		page.NextCursor = &Cursor{UpdatedAt: last.UpdatedAt, ID: last.ID}
	}
	return page, nil
}

// Get возвращает форму по id, если пользователь состоит в её воркспейсе.
func (s *Service) Get(ctx context.Context, userID, formID uuid.UUID) (Form, error) {
	return s.formForUser(ctx, userID, formID)
}

// UpdateTitle переименовывает форму (после проверки доступа).
func (s *Service) UpdateTitle(ctx context.Context, userID, formID uuid.UUID, title string) (Form, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return Form{}, fmt.Errorf("%w: название формы не может быть пустым", domain.ErrValidation)
	}
	if err := validateTitleLen(title); err != nil {
		return Form{}, err
	}
	form, err := s.formForUser(ctx, userID, formID)
	if err != nil {
		return Form{}, err
	}
	updated, err := s.repo.UpdateFormTitle(ctx, s.db, form.ID, form.WorkspaceID, title)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	return updated, nil
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

	form, err := s.formForUser(ctx, userID, formID)
	if err != nil {
		return Form{}, err
	}

	updated, err := s.repo.UpdateFormDraftSchema(ctx, s.db, form.ID, form.WorkspaceID, canonical, expectedUpdatedAt)
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
	form, err := s.formForUser(ctx, userID, formID)
	if err != nil {
		return err
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
	form, err := s.formForUser(ctx, userID, formID)
	if err != nil {
		return Form{}, err
	}

	parsed, err := domain.ValidateSchema(form.DraftSchema)
	if err != nil {
		return Form{}, err
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
	form, err := s.formForUser(ctx, userID, formID)
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

// formForUser загружает форму и проверяет членство пользователя в её воркспейсе.
// И отсутствие формы, и отсутствие членства дают domain.ErrNotFound — существование
// чужой формы не раскрывается (404, не 403).
func (s *Service) formForUser(ctx context.Context, userID, formID uuid.UUID) (Form, error) {
	form, err := s.repo.GetForm(ctx, s.db, formID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Form{}, domain.ErrNotFound
		}
		return Form{}, err
	}
	member, err := s.repo.IsWorkspaceMember(ctx, s.db, form.WorkspaceID, userID)
	if err != nil {
		return Form{}, err
	}
	if !member {
		return Form{}, domain.ErrNotFound
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

func validateTitleLen(title string) error {
	if len(title) > maxTitleLen {
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
