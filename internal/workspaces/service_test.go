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
	renamedName     string
	renameErr       error
	deletedWS       int64
	deleteWSRows    int64
	deleteWSErr     error
	ownerAdded      bool
	addOwnerErr     error
	ownerUserID     uuid.UUID
	createdWSIDs    []uuid.UUID
	inviteErr       error
	deletedMembers  int64
	deleteMemberErr error
	ownedTeams      []string
}

func (f *fakeStore) ListByUser(_ context.Context, _ postgres.DBTX, userID uuid.UUID) ([]Workspace, error) {
	f.gotUserID = userID
	return f.workspaces, f.err
}

func (f *fakeStore) Rename(_ context.Context, _ postgres.DBTX, id uuid.UUID, name string) (Workspace, error) {
	f.renamedName = name
	return Workspace{ID: id, Name: name}, f.renameErr
}

func (f *fakeStore) Delete(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (int64, error) {
	f.deletedWS++
	return f.deleteWSRows, f.deleteWSErr
}

// MemberRole фейку списка не нужен — права проверяет отдельный набор
// (access_test.go со своим roleStore); здесь он только чтобы удовлетворить Store.
func (f *fakeStore) MemberRole(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (string, error) {
	return string(RoleOwner), nil
}

// AccessContext по умолчанию — личное пространство владельца: заморозка не
// касается, и юниты создания/списка проверяют своё.
func (f *fakeStore) AccessContext(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (AccessContext, error) {
	return AccessContext{Role: string(RoleOwner), IsPersonal: true, MemberRank: 1}, nil
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

func (f *fakeStore) PurgeExpiredInvitations(_ context.Context, _ postgres.DBTX) (int64, error) {
	return 0, nil
}

func (f *fakeStore) UserIDByEmail(_ context.Context, _ postgres.DBTX, _ string) (uuid.UUID, error) {
	return uuid.Nil, pgx.ErrNoRows
}

func (f *fakeStore) ListMembers(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]Member, error) {
	return nil, nil
}

func (f *fakeStore) ListOwnedTeamsWithMembers(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]string, error) {
	return f.ownedTeams, nil
}

func (f *fakeStore) ListPendingInvites(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]PendingInvite, error) {
	return nil, nil
}

// DeleteMember отдаёт заданное число снятых строк: 0 — «нет такого или это
// владелец», и именно этот случай проверяют юниты выхода и снятия доступа.
func (f *fakeStore) DeleteMember(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (int64, error) {
	return f.deletedMembers, f.deleteMemberErr
}

func (f *fakeStore) Create(_ context.Context, _ postgres.DBTX, id uuid.UUID, name string) (Workspace, error) {
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

// Переименование спрашивает право ДО записи: id пространства в адресе правом не
// является (инвариант безопасности 1). Роль без workspace.manage не должна
// доехать до репозитория вовсе.
func TestRename_ForbiddenRoleDoesNotWrite(t *testing.T) {
	store := &roleStore{role: string(RoleEditor)}
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, nil, "https://app.example")

	_, err := svc.Rename(context.Background(), uuid.New(), uuid.New(), "Новое имя")
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("err = %v, ждали domain.ErrForbidden", err)
	}
	if store.renamedName != "" {
		t.Errorf("в репозиторий ушло имя %q, хотя права нет", store.renamedName)
	}
}

// Имя проверяется тем же кодом, что у создания: разъехавшись, две проверки
// дадут пространство, которое нельзя завести, но можно получить
// переименованием.
func TestRename_NameValidation(t *testing.T) {
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
			store := &roleStore{role: string(RoleOwner)}
			svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, nil, "https://app.example")
			_, err := svc.Rename(context.Background(), uuid.New(), uuid.New(), tc.in)
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("err = %v, ждали domain.ErrValidation", err)
			}
			if store.renamedName != "" {
				t.Errorf("невалидное имя %q всё равно записано", store.renamedName)
			}
		})
	}
}

// Пробелы по краям срезаются, как и при создании.
func TestRename_TrimsName(t *testing.T) {
	store := &roleStore{role: string(RoleOwner)}
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, nil, "https://app.example")

	ws, err := svc.Rename(context.Background(), uuid.New(), uuid.New(), "  Отдел маркетинга  ")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if ws.Name != "Отдел маркетинга" || store.renamedName != "Отдел маркетинга" {
		t.Errorf("имя = %q (в репозиторий ушло %q), ждали обрезанное", ws.Name, store.renamedName)
	}
}

// fakeFiles — снос объектов ответов глазами удаления пространства.
type fakeFiles struct {
	calls int
	err   error
}

func (f *fakeFiles) RemoveByWorkspace(_ context.Context, _ uuid.UUID) error {
	f.calls++
	return f.err
}

// Порядок сноса обязателен: файлы уходят ДО строк. Каскад БД уносит записи о
// загрузках вместе с ключами объектов, и оставшееся в бакете не найдёт никто.
func TestDelete_RemovesFilesBeforeRows(t *testing.T) {
	store := &roleStore{role: string(RoleOwner)}
	store.deleteWSRows = 1
	files := &fakeFiles{}
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, nil, "https://app.example").
		WithFiles(files)

	if err := svc.Delete(context.Background(), uuid.New(), uuid.New()); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if files.calls != 1 {
		t.Errorf("снос файлов вызван %d раз, ждали 1", files.calls)
	}
	if store.deletedWS != 1 {
		t.Errorf("удалений строки = %d, ждали 1", store.deletedWS)
	}
}

// Сбой сноса объектов ОСТАНАВЛИВАЕТ удаление: лучше отказать владельцу, чем
// оставить в бакете файлы респондентов без единой записи о них.
func TestDelete_FileFailureAbortsRowDelete(t *testing.T) {
	wantErr := errors.New("bucket down")
	store := &roleStore{role: string(RoleOwner)}
	store.deleteWSRows = 1
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, nil, "https://app.example").
		WithFiles(&fakeFiles{err: wantErr})

	if err := svc.Delete(context.Background(), uuid.New(), uuid.New()); !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, ждали %v", err, wantErr)
	}
	if store.deletedWS != 0 {
		t.Error("строку пространства снесли, хотя файлы удалить не удалось")
	}
}

// Роль без workspace.delete не доходит ни до файлов, ни до строк.
func TestDelete_ForbiddenRoleTouchesNothing(t *testing.T) {
	store := &roleStore{role: string(RoleEditor)}
	files := &fakeFiles{}
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, nil, "https://app.example").
		WithFiles(files)

	err := svc.Delete(context.Background(), uuid.New(), uuid.New())
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("err = %v, ждали domain.ErrForbidden", err)
	}
	if files.calls != 0 || store.deletedWS != 0 {
		t.Error("без права всё равно пошли удалять")
	}
}

// Личное не удаляется: сторож стоит в SQL (ноль строк), и сервис обязан назвать
// этот исход ошибкой, а не молча ответить «удалено».
func TestDelete_PersonalRefused(t *testing.T) {
	store := &roleStore{role: string(RoleOwner)}
	store.deleteWSRows = 0
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, nil, "https://app.example").
		WithFiles(&fakeFiles{})

	if err := svc.Delete(context.Background(), uuid.New(), uuid.New()); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, ждали domain.ErrValidation", err)
	}
}
