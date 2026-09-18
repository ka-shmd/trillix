package legal

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Store — доступ к данным, объявленный на стороне потребителя. Реализация — Repo.
type Store interface {
	Insert(ctx context.Context, db postgres.DBTX, e Edition) (bool, error)
	Get(ctx context.Context, db postgres.DBTX, kind Kind, version string) (Edition, error)
	RewriteDraft(ctx context.Context, db postgres.DBTX, e Edition) (bool, error)
	ListCurrent(ctx context.Context, db postgres.DBTX, now time.Time) ([]Edition, error)
	GetCurrent(ctx context.Context, db postgres.DBTX, kind Kind, now time.Time) (Edition, error)
	GetEffective(ctx context.Context, db postgres.DBTX, kind Kind, version string, now time.Time) (Edition, error)
	ListVersions(ctx context.Context, db postgres.DBTX, kind Kind, now time.Time) ([]VersionRef, error)
	TermsAcceptanceMissing(ctx context.Context, db postgres.DBTX, userID uuid.UUID, now time.Time) (bool, error)
	InsertEvent(ctx context.Context, db postgres.DBTX, e ConsentEvent) error
	LatestEvents(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]LatestEvent, error)
	History(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]HistoryItem, error)
}

// Transactor — транзакции сервис-слоя (реализация — postgres.TxRunner).
type Transactor interface {
	WithTx(ctx context.Context, fn func(pgx.Tx) error) error
}

// Accounts — аккаунты глазами legal. Отметка о завершении регистрации живёт в users, то
// есть в зоне auth, и ставится той же транзакцией, что и первое принятие соглашения:
// иначе сбой между ними оставил бы событие у «незавершённой» регистрации, и очистка
// упёрлась бы в RESTRICT журнала.
type Accounts interface {
	MarkSignupCompleted(ctx context.Context, db postgres.DBTX, userID uuid.UUID) error
}

var _ Store = Repo{}

type Service struct {
	db       postgres.DBTX
	tx       Transactor
	repo     Store
	accounts Accounts
	editions []Edition
	now      func() time.Time
}

// NewService принимает редакции реестра (Editions) — тесты подставляют свои.
func NewService(db postgres.DBTX, tx Transactor, repo Store, accounts Accounts, editions []Edition, now func() time.Time) *Service {
	return &Service{db: db, tx: tx, repo: repo, accounts: accounts, editions: editions, now: now}
}

// SyncResult — что сделала сверка при старте.
type SyncResult struct {
	Inserted  int
	Rewritten int
}

// Sync кладёт в базу редакции реестра, которых там нет, перезаписывает черновики и
// сверяет опубликованные. Опубликованная редакция, разошедшаяся с реестром, — ошибка, и
// API с ней не стартует: иначе исправление в файле задним числом переписало бы текст, с
// которым люди уже соглашались.
func (s *Service) Sync(ctx context.Context) (SyncResult, error) {
	var res SyncResult
	for _, want := range s.editions {
		inserted, err := s.repo.Insert(ctx, s.db, want)
		if err != nil {
			return res, err
		}
		if inserted {
			res.Inserted++
			continue
		}
		stored, err := s.repo.Get(ctx, s.db, want.Kind, want.Version)
		if err != nil {
			return res, fmt.Errorf("get legal document %s/%s: %w", want.Kind, want.Version, err)
		}
		changes := editionChanges(stored, want)
		if len(changes) == 0 {
			continue
		}
		if !stored.Draft {
			return res, fmt.Errorf(
				"legal: опубликованная редакция %s %s разошлась с реестром (%s) — новая редакция пишется новым файлом с новой датой",
				want.Kind, want.Version, strings.Join(changes, ", "))
		}
		rewritten, err := s.repo.RewriteDraft(ctx, s.db, want)
		if err != nil {
			return res, err
		}
		if !rewritten {
			// Между Get и UPDATE редакцию опубликовал соседний процесс.
			return res, fmt.Errorf("legal: черновик %s %s опубликован во время сверки", want.Kind, want.Version)
		}
		res.Rewritten++
	}
	return res, nil
}

// editionChanges — чем редакция в базе отличается от реестра, словами для сообщения.
func editionChanges(stored, want Edition) []string {
	var out []string
	if stored.SHA256 != want.SHA256 {
		out = append(out, "текст")
	}
	if stored.Title != want.Title {
		out = append(out, "заголовок")
	}
	if !stored.EffectiveAt.Equal(want.EffectiveAt) {
		out = append(out, "дата вступления в силу")
	}
	if stored.RequiresReacceptance != want.RequiresReacceptance {
		out = append(out, "повторное принятие")
	}
	if stored.Draft != want.Draft {
		out = append(out, "черновик")
	}
	return out
}

// Current — действующие редакции всех документов.
func (s *Service) Current(ctx context.Context) ([]Edition, error) {
	return s.repo.ListCurrent(ctx, s.db, s.now())
}

// Document — редакция документа и архив его редакций. Пустая версия — действующая.
// Редакция, не вступившая в силу, публично не существует.
func (s *Service) Document(ctx context.Context, kind Kind, version string) (Edition, []VersionRef, error) {
	now := s.now()
	var (
		ed  Edition
		err error
	)
	if version == "" {
		ed, err = s.repo.GetCurrent(ctx, s.db, kind, now)
	} else {
		ed, err = s.repo.GetEffective(ctx, s.db, kind, version, now)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return Edition{}, nil, fmt.Errorf("%w: документ %s %s", domain.ErrNotFound, kind, version)
	}
	if err != nil {
		return Edition{}, nil, fmt.Errorf("get legal document %s %s: %w", kind, version, err)
	}
	versions, err := s.repo.ListVersions(ctx, s.db, kind, now)
	if err != nil {
		return Edition{}, nil, err
	}
	return ed, versions, nil
}
