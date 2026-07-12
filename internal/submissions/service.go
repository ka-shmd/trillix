package submissions

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/forms"
	"github.com/ka-shmd/trierra/internal/postgres"
)

const (
	// maxMetaFieldLen — потолок длины строк меты (user_agent, referer): обрезаем, чтобы
	// раздутый заголовок не распухал JSONB. Само тело ограничено MaxBytesReader'ом,
	// но заголовки в лимит тела не входят.
	maxMetaFieldLen = 512

	// DefaultPageLimit / MaxPageLimit — размер страницы листинга ответов. Запрошенный
	// клиентом limit зажимается в [1, MaxPageLimit]; пустой → Default. Совпадает с
	// forms по значениям, но свой — модули не делят константы пагинации.
	DefaultPageLimit = 50
	MaxPageLimit     = 100
)

// Forms — коллаборатор из модуля forms: отдаёт опубликованную форму по slug (приём
// ответа) и авторизует доступ автора к форме по id (листинг). Реализация —
// *forms.Service; общение через интерфейс сервиса (не чужой repo).
type Forms interface {
	PublicForm(ctx context.Context, slug string) (forms.PublicForm, error)
	// Get проверяет членство пользователя в воркспейсе формы и возвращает её;
	// чужая или несуществующая → domain.ErrNotFound (анти-IDOR, приватное не
	// раскрывается). Листингу нужен только факт доступа, не поля формы.
	Get(ctx context.Context, userID, formID uuid.UUID) (forms.Form, error)
	// Versions авторизует доступ (как Get) и отдаёт все опубликованные версии
	// формы — их схемы нужны CSV-экспорту для объединения колонок и подписей опций.
	Versions(ctx context.Context, userID, formID uuid.UUID) ([]forms.Version, error)
}

// Store — доступ к данным submissions, объявленный на стороне потребителя.
type Store interface {
	InsertSubmission(ctx context.Context, db postgres.DBTX, id, formID, versionID uuid.UUID, answers, meta json.RawMessage) (int64, error)
	ListSubmissions(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32) ([]Submission, error)
	ListSubmissionsAfter(ctx context.Context, db postgres.DBTX, formID, cursorID uuid.UUID, limit int32) ([]Submission, error)
	CountSubmissions(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int64, error)
	DeleteSubmission(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error)
}

var _ Store = Repo{}

// Cursor — курсор листинга ответов: id последнего показанного ответа. Ответы
// иммутабельны и монотонны по id (UUIDv7), поэтому курсор одноколоночный (в отличие
// от составного у forms). Транспорт кодирует его в непрозрачную строку.
type Cursor struct {
	ID uuid.UUID
}

// Page — страница ответов, курсор на следующую (nil на последней) и общий счётчик.
type Page struct {
	Submissions []Submission
	NextCursor  *Cursor
	Total       int64
}

var _ Store = Repo{}

// Meta — необязательный контекст ответа (без IP в открытом виде, ARCHITECTURE §3.3).
type Meta struct {
	UserAgent string
	Referer   string
}

// Service — приём ответов. Валидация идёт против ОПУБЛИКОВАННОЙ версии формы, а
// submission привязывается к её id — правки схемы после отправки не искажают данные.
type Service struct {
	db    postgres.DBTX
	forms Forms
	repo  Store
}

func NewService(db postgres.DBTX, forms Forms, repo Store) *Service {
	return &Service{db: db, forms: forms, repo: repo}
}

// Submit принимает ответ на форму slug. Порядок: резолв опубликованной формы
// (черновик/закрытая/нет → 404, приватное не раскрывается) → валидация ответа против
// её схемы (нарушения → domain.AnswerErrors, транспорт кладёт карту полей в 422) →
// INSERT с привязкой к версии. Идемпотентность: повтор с тем же id (ретрай после
// сбоя сети) не создаёт второй строки и возвращается как успех.
func (s *Service) Submit(ctx context.Context, slug string, id uuid.UUID, answers map[string]json.RawMessage, meta Meta) error {
	pf, err := s.forms.PublicForm(ctx, slug)
	if err != nil {
		return err
	}

	// Опубликованная схема уже канонична и валидна (проверена при публикации);
	// разбираем её в типы для ValidateAnswers. Сбой здесь означал бы нарушенный
	// инвариант иммутабельности версии — оборачиваем как внутреннюю ошибку.
	schema, err := domain.ValidateSchema(pf.Schema)
	if err != nil {
		return fmt.Errorf("parse published schema for %s: %w", slug, err)
	}
	if err := domain.ValidateAnswers(schema, answers); err != nil {
		return err
	}

	answersJSON, err := json.Marshal(answers)
	if err != nil {
		return fmt.Errorf("marshal answers: %w", err)
	}
	metaJSON, err := json.Marshal(map[string]string{
		"user_agent": truncate(meta.UserAgent, maxMetaFieldLen),
		"referer":    truncate(meta.Referer, maxMetaFieldLen),
	})
	if err != nil {
		return fmt.Errorf("marshal meta: %w", err)
	}

	// n == 0 → конфликт по PK (тот же id уже принят): идемпотентный успех.
	if _, err := s.repo.InsertSubmission(ctx, s.db, id, pf.FormID, pf.VersionID, answersJSON, metaJSON); err != nil {
		return err
	}
	return nil
}

// ListForForm возвращает страницу ответов формы для её автора. Порядок: авторизация
// через forms.Get (чужая/нет формы → 404, приватное не раскрывается), затем чтение
// страницы. after — курсор предыдущей страницы (nil для первой). Общий счётчик
// считается всегда (кабинет показывает «N ответов»).
func (s *Service) ListForForm(ctx context.Context, userID, formID uuid.UUID, after *Cursor, limit int) (Page, error) {
	if _, err := s.forms.Get(ctx, userID, formID); err != nil {
		return Page{}, err
	}
	limit = clampLimit(limit)

	total, err := s.repo.CountSubmissions(ctx, s.db, formID)
	if err != nil {
		return Page{}, err
	}

	// limit+1: «лишняя» строка означает, что есть следующая страница; сам её в
	// ответ не отдаём, а превращаем в курсор.
	fetch := int32(limit + 1)
	var rows []Submission
	if after == nil {
		rows, err = s.repo.ListSubmissions(ctx, s.db, formID, fetch)
	} else {
		rows, err = s.repo.ListSubmissionsAfter(ctx, s.db, formID, after.ID, fetch)
	}
	if err != nil {
		return Page{}, err
	}

	page := Page{Submissions: rows, Total: total}
	if len(rows) > limit {
		last := rows[limit-1]
		page.Submissions = rows[:limit]
		page.NextCursor = &Cursor{ID: last.ID}
	}
	return page, nil
}

// exportBatch — размер порции keyset-итерации при экспорте. Память экспорта плоская
// (одна порция за раз) независимо от общего числа ответов — DoD «10k строк не растит
// память».
const exportBatch = 1000

// ExportCSV потоково выгружает все ответы формы в emit (по строке; первая — заголовок).
// Порядок: авторизация + чтение версий (чужая/нет формы → 404), сборка модели колонок
// (объединение блоков по версиям), затем keyset-итерация ответов порциями exportBatch —
// каждая строка эмитится сразу, без накопления всей выборки. Между порциями уважается
// отмена ctx (клиент закрыл соединение). emit-ошибка (обрыв записи в сеть) прерывает
// экспорт.
func (s *Service) ExportCSV(ctx context.Context, userID, formID uuid.UUID, emit func(record []string) error) error {
	versions, err := s.forms.Versions(ctx, userID, formID)
	if err != nil {
		return err
	}

	vs := make([]domain.VersionedSchema, 0, len(versions))
	for _, v := range versions {
		schema, e := domain.ValidateSchema(v.Schema)
		if e != nil {
			// Опубликованный снапшот обязан быть валиден (проверен при публикации) —
			// иначе нарушен инвариант иммутабельности версии.
			return fmt.Errorf("parse version %d schema of form %s: %w", v.Number, formID, e)
		}
		vs = append(vs, domain.VersionedSchema{Version: int(v.Number), Schema: schema})
	}

	builder := domain.NewCSVBuilder(vs)
	if err := emit(builder.Header()); err != nil {
		return err
	}

	var after *Cursor
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		var rows []Submission
		if after == nil {
			rows, err = s.repo.ListSubmissions(ctx, s.db, formID, exportBatch)
		} else {
			rows, err = s.repo.ListSubmissionsAfter(ctx, s.db, formID, after.ID, exportBatch)
		}
		if err != nil {
			return err
		}
		for i := range rows {
			var answers map[string]json.RawMessage
			if e := json.Unmarshal(rows[i].Answers, &answers); e != nil {
				return fmt.Errorf("unmarshal answers of submission %s: %w", rows[i].ID, e)
			}
			if e := emit(builder.Row(rows[i].ID.String(), rows[i].CreatedAt, int(rows[i].FormVersion), answers)); e != nil {
				return e
			}
		}
		if len(rows) < exportBatch {
			return nil
		}
		after = &Cursor{ID: rows[len(rows)-1].ID}
	}
}

// DeleteForForm удаляет один ответ формы (GDPR-гигиена). Порядок: авторизация через
// forms.Get (чужая/нет формы → 404), затем удаление в пределах формы. Отсутствие
// ответа (или он из другой формы) → domain.ErrNotFound.
func (s *Service) DeleteForForm(ctx context.Context, userID, formID, submissionID uuid.UUID) error {
	if _, err := s.forms.Get(ctx, userID, formID); err != nil {
		return err
	}
	n, err := s.repo.DeleteSubmission(ctx, s.db, submissionID, formID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
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

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
