package workspaces

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// MaxNameLen — потолок имени пространства в рунах. Имя видно в сайдбаре и
// крошках, длинное там всё равно обрезается многоточием.
const MaxNameLen = 60

// Store — доступ к данным workspaces, объявленный на стороне потребителя
// (сервиса). Реализация — Repo; в тестах подменяется фейком.
type Store interface {
	ListByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]Workspace, error)
	// MemberRole — роль участника; pgx.ErrNoRows означает «не участник».
	MemberRole(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (string, error)
	GetWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Workspace, error)
	EmailByUserID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (string, error)
	InviteStore
	ListMembers(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]Member, error)
	ListPendingInvites(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]PendingInvite, error)
	DeleteMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (int64, error)
	CreateTeam(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string) (Workspace, error)
	AddOwner(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) error
}

var _ Store = Repo{}

// Transactor открывает транзакцию (без знания о конкретном пуле). Реализация —
// postgres.TxRunner; в тестах — фейк, выполняющий fn без реальной БД.
type Transactor interface {
	WithTx(ctx context.Context, fn func(pgx.Tx) error) error
}

// Plans — единая точка лимитов глазами этого модуля (internal/entitlements).
// Спрашивается ПОДПИСКА АККАУНТА, а не план воркспейса: нового пространства
// ещё нет, а старое к нему отношения не имеет (ADR §10).
type Plans interface {
	CheckAccount(ctx context.Context, userID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
	// CheckWorkspace — лимит самого пространства (места), спрашивается у плана
	// его владельца.
	CheckWorkspace(ctx context.Context, workspaceID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
}

// Service — бизнес-логика пространств: список своих и создание новых.
// Право доступа к списку обеспечивает запрос — возвращаются лишь пространства
// с членством (инвариант безопасности 1).
type Service struct {
	db    postgres.DBTX // пул: чтение списка
	tx    Transactor    // пространство + владелец одной транзакцией
	repo  Store
	plans Plans
	mail  MailEnqueuer
	// appBaseURL — origin кабинета, из которого строится ссылка приглашения.
	appBaseURL string
}

func NewService(db postgres.DBTX, tx Transactor, repo Store, plans Plans, mailer MailEnqueuer, appBaseURL string) *Service {
	return &Service{db: db, tx: tx, repo: repo, plans: plans, mail: mailer, appBaseURL: appBaseURL}
}

// ListForUser возвращает пространства пользователя (личное — первым: оно старше
// любого командного, а запрос сортирует по created_at).
func (s *Service) ListForUser(ctx context.Context, userID uuid.UUID) ([]Workspace, error) {
	return s.repo.ListByUser(ctx, s.db, userID)
}

// Create заводит командное пространство и делает создателя его владельцем.
//
// Порядок обязателен: сначала гейт тарифа, потом запись. Лимит считает
// пространства, которыми аккаунт ВЛАДЕЕТ, — членство в чужих не расходует
// его место, иначе владелец Pro не смог бы позвать никого с Free.
//
// Подписка здесь НЕ создаётся: субъект тарифа — аккаунт, и она у него уже есть
// с регистрации (0016). Пространство работает по плану своего владельца.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, name string) (Workspace, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Workspace{}, fmt.Errorf("%w: имя пространства пустое", domain.ErrValidation)
	}
	if utf8.RuneCountInString(name) > MaxNameLen {
		return Workspace{}, fmt.Errorf("%w: имя пространства длиннее %d символов", domain.ErrValidation, MaxNameLen)
	}

	d, err := s.plans.CheckAccount(ctx, userID, entitlements.Workspaces)
	if err != nil {
		return Workspace{}, err
	}
	if !d.Allowed {
		return Workspace{}, domain.ErrPlanRequired
	}

	// Пространство и его владелец — одной транзакцией: пространство без
	// владельца не имеет плана, то есть неотличимо от осиротевшего (TD-53), и
	// его не видно ни в одном списке — то есть создать его молча значит создать
	// мусор.
	id := domain.NewID()
	var created Workspace
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		w, e := s.repo.CreateTeam(ctx, tx, id, name)
		if e != nil {
			return e
		}
		created = w
		return s.repo.AddOwner(ctx, tx, id, userID)
	})
	if err != nil {
		return Workspace{}, err
	}
	return created, nil
}
