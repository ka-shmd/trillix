package templates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/postgres"
)

const (
	// maxTitleLen / maxDescriptionLen — потолки в РУНАХ. Название зеркалит потолок
	// формы (domain.MaxFormTitleLen через forms): шаблон называется так же, как
	// назовётся форма из него. Описание — строка под названием в галерее, ему
	// хватает абзаца.
	maxTitleLen       = 200
	maxDescriptionLen = 500
)

// Access — права в пространстве глазами этого модуля (internal/workspaces).
// Спрашивается ДЕЙСТВИЕ, а не роль: см. internal/CLAUDE.md.
type Access interface {
	Can(ctx context.Context, workspaceID, userID uuid.UUID, action domain.Action) error
}

// Forms — формы глазами этого модуля. Узкий интерфейс на стороне потребителя,
// как у media и answerfiles.
//
// Оба метода САМИ проверяют право: чтение формы — членство в её пространстве,
// создание — право писать в целевом. Проверять здесь второй раз нечего, и
// делать этого нельзя: точка решения обязана быть одна.
type Forms interface {
	Get(ctx context.Context, userID, formID uuid.UUID) (forms.Form, error)
	CreateFromSchema(ctx context.Context, userID uuid.UUID, workspaceID *uuid.UUID, title string, schema json.RawMessage) (forms.Form, error)
}

// Admins — «этот человек администратор сервиса?». Флаг живёт у users, то есть в
// зоне auth, и спрашивается через сервис, а не чтением чужой таблицы.
type Admins interface {
	IsAdmin(ctx context.Context, userID uuid.UUID) (bool, error)
}

// Store — доступ к данным, объявленный на стороне потребителя. Реализация — Repo.
type Store interface {
	ListByWorkspace(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]Template, error)
	ListPublic(ctx context.Context, db postgres.DBTX) ([]Template, error)
	Get(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Template, error)
	Create(ctx context.Context, db postgres.DBTX, t Template) (Template, error)
	DeleteInWorkspace(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (int64, error)
}

var _ Store = Repo{}

type Service struct {
	db     postgres.DBTX
	repo   Store
	access Access
	forms  Forms
	admins Admins
}

func NewService(db postgres.DBTX, repo Store, access Access, formsSvc Forms, admins Admins) *Service {
	return &Service{db: db, repo: repo, access: access, forms: formsSvc, admins: admins}
}

// List отдаёт галерею одним ответом: публичные плюс — если пространство названо
// и спрашивающий в нём состоит — его собственные.
//
// Одной ручкой, а не двумя, потому что галерея всегда рисует обе вкладки разом:
// два запроса означали бы два состояния загрузки на одном экране и вторую
// причину, по которой он может показаться наполовину.
func (s *Service) List(ctx context.Context, userID uuid.UUID, workspaceID *uuid.UUID) ([]Template, error) {
	out, err := s.repo.ListPublic(ctx, s.db)
	if err != nil {
		return nil, err
	}
	if workspaceID == nil {
		return out, nil
	}
	if err := s.access.Can(ctx, *workspaceID, userID, domain.ActionFormRead); err != nil {
		return nil, err
	}
	own, err := s.repo.ListByWorkspace(ctx, s.db, *workspaceID)
	if err != nil {
		return nil, err
	}
	return append(own, out...), nil
}

// SaveFromForm сохраняет черновик формы как шаблон ЕЁ пространства.
//
// Переносится документ и только он: блоки, оформление, обложка, логотип. Пароль,
// лимит ответов, уведомления, интеграции и расписание записи живут колонками
// формы, а не документом, и в шаблон не едут — ровно как при «Дублировать».
func (s *Service) SaveFromForm(ctx context.Context, userID, formID uuid.UUID, title, description string) (Template, error) {
	title, description, err := normalize(title, description)
	if err != nil {
		return Template{}, err
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return Template{}, err
	}
	// Читать форму мог и тот, кому нельзя писать в пространство. Шаблон — новая
	// сущность пространства, поэтому право спрашивается своё.
	if err := s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return Template{}, err
	}
	if title == "" {
		title = form.Title
	}
	// Документ проверяется на входе в шаблон, а не на выходе из него: битую
	// схему (её могла оставить только правка мимо продукта) честнее не пустить
	// в витрину, чем однажды отдать создателю формы 422 на чужой ошибке.
	if _, err := domain.ValidateSchema(form.DraftSchema); err != nil {
		return Template{}, err
	}
	return s.repo.Create(ctx, s.db, Template{
		ID:          domain.NewID(),
		WorkspaceID: form.WorkspaceID,
		AuthorID:    userID,
		Title:       title,
		Description: description,
		Schema:      form.DraftSchema,
		Visibility:  VisibilityPrivate,
	})
}

// PublishSchema заводит ПУБЛИЧНЫЙ шаблон из готового документа. Единственный
// путь пополнить витрину; экрана у него пока нет — вызывается curl'ом
// администратора, которым залиты и шесть прежних встроенных шаблонов.
//
// Документ приходит телом, а не берётся из формы, намеренно: шаблон витрины не
// обязан иметь форму-прародителя в чьём-то пространстве, а заготовки продукта
// живут в репозитории файлами, а не в чьём-то кабинете.
func (s *Service) PublishSchema(ctx context.Context, userID uuid.UUID, title, description string, rawSchema json.RawMessage) (Template, error) {
	admin, err := s.admins.IsAdmin(ctx, userID)
	if err != nil {
		return Template{}, err
	}
	if !admin {
		// 404, а не 403: обычному пользователю ручки администратора не
		// существует вовсе (инвариант 5 — приватное не раскрывается).
		return Template{}, domain.ErrNotFound
	}
	title, description, err = normalize(title, description)
	if err != nil {
		return Template{}, err
	}
	if title == "" {
		return Template{}, fmt.Errorf("%w: у шаблона нет названия", domain.ErrValidation)
	}
	if _, err := domain.ValidateSchema(rawSchema); err != nil {
		return Template{}, err
	}
	return s.repo.Create(ctx, s.db, Template{
		ID:          domain.NewID(),
		AuthorID:    userID,
		Title:       title,
		Description: description,
		Schema:      rawSchema,
		Visibility:  VisibilityPublic,
	})
}

// Use создаёт форму из шаблона в названном пространстве (nil = личное).
//
// Одним запросом, а не «создать пустую и дописать схему»: сорвись второй запрос
// прежней пары, автор получал бы на дашборде пустую форму вместо заготовки.
func (s *Service) Use(ctx context.Context, userID, templateID uuid.UUID, workspaceID *uuid.UUID) (forms.Form, error) {
	t, err := s.readable(ctx, userID, templateID)
	if err != nil {
		return forms.Form{}, err
	}
	parsed, err := domain.ValidateSchema(t.Schema)
	if err != nil {
		return forms.Form{}, err
	}
	// Свежие id — несущее, а не гигиена: без них две формы из одного шаблона
	// ссылались бы на одни и те же строки в ответах, воронке и логике.
	doc, err := json.Marshal(domain.NewSchemaIDs(parsed))
	if err != nil {
		return forms.Form{}, fmt.Errorf("marshal template schema %s: %w", templateID, err)
	}
	return s.forms.CreateFromSchema(ctx, userID, workspaceID, t.Title, doc)
}

// Delete удаляет СВОЙ шаблон пространства. Публичный этим путём не удаляется:
// витрина правится там же, где наполняется, — руками администратора.
func (s *Service) Delete(ctx context.Context, userID, templateID uuid.UUID) error {
	t, err := s.readable(ctx, userID, templateID)
	if err != nil {
		return err
	}
	if t.Visibility != VisibilityPrivate {
		return domain.ErrForbidden
	}
	if err := s.access.Can(ctx, t.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return err
	}
	n, err := s.repo.DeleteInWorkspace(ctx, s.db, templateID, t.WorkspaceID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// readable — шаблон, который спрашивающему дозволено видеть: публичный виден
// всем, приватный — участникам своего пространства. Чужой приватный неотличим
// от несуществующего (Can отдаёт 404 не-участнику).
func (s *Service) readable(ctx context.Context, userID, templateID uuid.UUID) (Template, error) {
	t, err := s.repo.Get(ctx, s.db, templateID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Template{}, domain.ErrNotFound
		}
		return Template{}, err
	}
	if t.Visibility == VisibilityPrivate {
		if err := s.access.Can(ctx, t.WorkspaceID, userID, domain.ActionFormRead); err != nil {
			return Template{}, err
		}
	}
	return t, nil
}

// normalize чистит и меряет подписи. Потолки — в рунах: в байтах кириллица
// обрезалась бы вдвое раньше латиницы (тот же довод, что у названия формы).
func normalize(title, description string) (string, string, error) {
	title = strings.TrimSpace(title)
	description = strings.TrimSpace(description)
	if utf8.RuneCountInString(title) > maxTitleLen {
		return "", "", fmt.Errorf("%w: название длиннее %d символов", domain.ErrValidation, maxTitleLen)
	}
	if utf8.RuneCountInString(description) > maxDescriptionLen {
		return "", "", fmt.Errorf("%w: описание длиннее %d символов", domain.ErrValidation, maxDescriptionLen)
	}
	return title, description, nil
}
