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

// maxMetaFieldLen — потолок длины строк меты (user_agent, referer): обрезаем, чтобы
// раздутый заголовок не распухал JSONB. Само тело ограничено MaxBytesReader'ом,
// но заголовки в лимит тела не входят.
const maxMetaFieldLen = 512

// Forms — коллаборатор из модуля forms: отдаёт опубликованную форму по slug (её id,
// версию и схему) либо domain.ErrNotFound для черновика/закрытой/несуществующей.
// Реализация — *forms.Service; общение через интерфейс сервиса (не чужой repo).
type Forms interface {
	PublicForm(ctx context.Context, slug string) (forms.PublicForm, error)
}

// Store — доступ к данным submissions, объявленный на стороне потребителя.
type Store interface {
	InsertSubmission(ctx context.Context, db postgres.DBTX, id, formID, versionID uuid.UUID, answers, meta json.RawMessage) (int64, error)
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

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
