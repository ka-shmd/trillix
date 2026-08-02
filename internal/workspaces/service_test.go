package workspaces

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// fakeStore — герметичная подмена репозитория (без БД, инвариант тестов).
type fakeStore struct {
	workspaces []Workspace
	err        error
	gotUserID  uuid.UUID

	createdName     string
	createErr       error
	ownerAdded      bool
	addOwnerErr     error
	ownerUserID     uuid.UUID
	createdWSIDs    []uuid.UUID
	invitedEmail    string
	inviteErr       error
	deletedMembers  int64
	deleteMemberErr error
}

func (f *fakeStore) ListByUser(_ context.Context, _ postgres.DBTX, userID uuid.UUID) ([]Workspace, error) {
	f.gotUserID = userID
	return f.workspaces, f.err
}

// MemberRole фейку списка не нужен — права проверяет отдельный набор
// (access_test.go со своим roleStore); здесь он только чтобы удовлетворить Store.
func (f *fakeStore) MemberRole(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (string, error) {
	return string(RoleOwner), nil
}

func (f *fakeStore) GetWorkspace(_ context.Context, _ postgres.DBTX, id uuid.UUID) (Workspace, error) {
	return Workspace{ID: id, Name: "Команда"}, nil
}

func (f *fakeStore) EmailByUserID(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (string, error) {
	return "owner@example.com", nil
}

// --- InviteStore: приглашения проверяются интеграционно (нужны настоящие
// атомарный UPDATE и частичный UNIQUE), здесь фейк только удовлетворяет Store.

func (f *fakeStore) CreateInvitation(_ context.Context, _ postgres.DBTX, _ []byte, _ uuid.UUID, _, _ string, _ uuid.UUID, _ time.Time) error {
	f.invitedEmail = "" // перезаписывается ниже вызывающим тестом при надобности
	return f.inviteErr
}

func (f *fakeStore) DeletePendingInvitation(_ context.Context, _ postgres.DBTX, _ uuid.UUID, _ string) error {
	return nil
}

func (f *fakeStore) GetInvitation(_ context.Context, _ postgres.DBTX, _ []byte) (Invitation, error) {
	return Invitation{}, pgx.ErrNoRows
}

func (f *fakeStore) ConsumeInvitation(_ context.Context, _ postgres.DBTX, _ []byte) (Invitation, error) {
	return Invitation{}, pgx.ErrNoRows
}

func (f *fakeStore) AddMember(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID, _ string) error {
	return nil
}

func (f *fakeStore) UserIDByEmail(_ context.Context, _ postgres.DBTX, _ string) (uuid.UUID, error) {
	return uuid.Nil, pgx.ErrNoRows
}

func (f *fakeStore) ListMembers(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]Member, error) {
	return nil, nil
}

func (f *fakeStore) ListPendingInvites(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]PendingInvite, error) {
	return nil, nil
}

// DeleteMember отдаёт заданное число снятых строк: 0 — «нет такого или это
// владелец», и именно этот случай проверяют юниты выхода и снятия доступа.
func (f *fakeStore) DeleteMember(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (int64, error) {
	return f.deletedMembers, f.deleteMemberErr
}

func (f *fakeStore) CreateTeam(_ context.Context, _ postgres.DBTX, id uuid.UUID, name string) (Workspace, error) {
	if f.createErr != nil {
		return Workspace{}, f.createErr
	}
	f.createdName = name
	f.createdWSIDs = append(f.createdWSIDs, id)
	return Workspace{ID: id, Name: name}, nil
}

func (f *fakeStore) AddOwner(_ context.Context, _ postgres.DBTX, _, userID uuid.UUID) error {
	if f.addOwnerErr != nil {
		return f.addOwnerErr
	}
	f.ownerAdded = true
	f.ownerUserID = userID
	return nil
}

// fakeTx выполняет fn без настоящей транзакции, но помнит, что её открывали:
// пространство и его владелец обязаны создаваться одной.
type fakeTx struct{ opened bool }

func (t *fakeTx) WithTx(_ context.Context, fn func(pgx.Tx) error) error {
	t.opened = true
	return fn(nil)
}

// fakePlans — единая точка лимитов, подменённая вердиктом.
type fakePlans struct {
	allowed bool
	err     error
	gotKey  entitlements.Key
	gotUser uuid.UUID
}

func (p *fakePlans) CheckAccount(_ context.Context, userID uuid.UUID, key entitlements.Key) (entitlements.Decision, error) {
	p.gotUser = userID
	p.gotKey = key
	return entitlements.Decision{Allowed: p.allowed}, p.err
}

func (p *fakePlans) CheckWorkspace(_ context.Context, _ uuid.UUID, key entitlements.Key) (entitlements.Decision, error) {
	p.gotKey = key
	return entitlements.Decision{Allowed: p.allowed}, p.err
}

func newTestService(store *fakeStore, plans *fakePlans) (*Service, *fakeTx) {
	tx := &fakeTx{}
	return NewService(nil, tx, store, plans, nil, "https://app.example"), tx
}

// ListForUser пробрасывает userID в репозиторий и возвращает его результат.
func TestListForUser_DelegatesAndReturns(t *testing.T) {
	uid := uuid.New()
	store := &fakeStore{workspaces: []Workspace{{ID: uuid.New(), Name: "Личное пространство", IsPersonal: true}}}
	svc, _ := newTestService(store, &fakePlans{allowed: true})

	got, err := svc.ListForUser(context.Background(), uid)
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	if store.gotUserID != uid {
		t.Fatalf("userID в репозиторий = %s, ожидался %s", store.gotUserID, uid)
	}
	if len(got) != 1 || !got[0].IsPersonal {
		t.Fatalf("результат = %+v, ожидалось одно личное пространство", got)
	}
}

// Ошибка репозитория пробрасывается наверх без проглатывания.
func TestListForUser_PropagatesError(t *testing.T) {
	wantErr := errors.New("db down")
	svc, _ := newTestService(&fakeStore{err: wantErr}, &fakePlans{allowed: true})
	if _, err := svc.ListForUser(context.Background(), uuid.New()); !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, ожидался %v", err, wantErr)
	}
}

// Создание: имя обрезается, пространство и владелец пишутся ОДНОЙ транзакцией,
// владельцем становится создатель.
func TestCreate_WritesWorkspaceAndOwnerInOneTx(t *testing.T) {
	uid := uuid.New()
	store := &fakeStore{}
	plans := &fakePlans{allowed: true}
	svc, tx := newTestService(store, plans)

	ws, err := svc.Create(context.Background(), uid, "  Команда  ")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if ws.Name != "Команда" || store.createdName != "Команда" {
		t.Errorf("имя = %q (в репозиторий ушло %q), ждали обрезанное «Команда»", ws.Name, store.createdName)
	}
	if !tx.opened {
		t.Error("пространство создано вне транзакции: владелец может не записаться")
	}
	if !store.ownerAdded || store.ownerUserID != uid {
		t.Errorf("владельцем стал %s, ждали создателя %s", store.ownerUserID, uid)
	}
	if plans.gotUser != uid || plans.gotKey != entitlements.Workspaces {
		t.Errorf("гейт спрошен как (%s, %q), ждали (%s, %q)", plans.gotUser, plans.gotKey, uid, entitlements.Workspaces)
	}
}

// Гейт тарифа закрыт — пространство не создаётся ВООБЩЕ: проверка стоит до
// записи, иначе лимит считался бы после того, как его уже превысили.
func TestCreate_PlanGateBlocksBeforeWrite(t *testing.T) {
	store := &fakeStore{}
	svc, tx := newTestService(store, &fakePlans{allowed: false})

	_, err := svc.Create(context.Background(), uuid.New(), "Команда")
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("err = %v, ждали domain.ErrPlanRequired (402)", err)
	}
	if tx.opened || len(store.createdWSIDs) != 0 {
		t.Error("при закрытом гейте всё равно писали в БД")
	}
}

// Ошибка самой проверки — не «нельзя», а «спросить не удалось»: она долетает
// до вызывающего как есть, а не превращается в отказ по тарифу.
func TestCreate_PlanCheckErrorPropagates(t *testing.T) {
	wantErr := errors.New("plans down")
	svc, _ := newTestService(&fakeStore{}, &fakePlans{err: wantErr})

	_, err := svc.Create(context.Background(), uuid.New(), "Команда")
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, ждали %v", err, wantErr)
	}
	if errors.Is(err, domain.ErrPlanRequired) {
		t.Error("сбой проверки выдан за отказ по тарифу")
	}
}

func TestCreate_NameValidation(t *testing.T) {
	tests := []struct {
		name string
		in   string
	}{
		{"пустое", ""},
		{"из одних пробелов", "   \t\n"},
		{"длиннее потолка", strings.Repeat("я", MaxNameLen+1)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			svc, _ := newTestService(store, &fakePlans{allowed: true})
			_, err := svc.Create(context.Background(), uuid.New(), tc.in)
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("err = %v, ждали domain.ErrValidation", err)
			}
			if len(store.createdWSIDs) != 0 {
				t.Error("невалидное имя всё равно записано")
			}
		})
	}
}

// Ровно на потолке имя законно: граница включающая, и это видно тестом, а не
// вычитыванием знака в условии.
func TestCreate_NameAtLimitAllowed(t *testing.T) {
	svc, _ := newTestService(&fakeStore{}, &fakePlans{allowed: true})
	if _, err := svc.Create(context.Background(), uuid.New(), strings.Repeat("я", MaxNameLen)); err != nil {
		t.Fatalf("имя ровно в MaxNameLen отвергнуто: %v", err)
	}
}

// Падение на добавлении владельца возвращает ошибку наверх: транзакция
// откатится, и пространства без владельца (то есть без плана) не останется.
func TestCreate_OwnerFailureAborts(t *testing.T) {
	wantErr := errors.New("duplicate owner")
	svc, _ := newTestService(&fakeStore{addOwnerErr: wantErr}, &fakePlans{allowed: true})

	if _, err := svc.Create(context.Background(), uuid.New(), "Команда"); !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, ждали %v", err, wantErr)
	}
}
