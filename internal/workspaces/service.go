package workspaces

import (
	"context"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/postgres"
)

// Store — доступ к данным workspaces, объявленный на стороне потребителя
// (сервиса). Реализация — Repo; в тестах подменяется фейком.
type Store interface {
	ListByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]Workspace, error)
}

var _ Store = Repo{}

// Service — бизнес-логика воркспейсов. В MVP только чтение: список пространств
// текущего пользователя (крошки кабинета). Право доступа обеспечивает запрос —
// возвращаются лишь воркспейсы с членством (инвариант безопасности 1).
type Service struct {
	db   postgres.DBTX
	repo Store
}

func NewService(db postgres.DBTX, repo Store) *Service {
	return &Service{db: db, repo: repo}
}

// ListForUser возвращает воркспейсы пользователя (в MVP — один личный).
func (s *Service) ListForUser(ctx context.Context, userID uuid.UUID) ([]Workspace, error) {
	return s.repo.ListByUser(ctx, s.db, userID)
}
