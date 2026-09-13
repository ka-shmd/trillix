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
	workspaces []WorkspaceAccess
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
	createdSlugs    []string
	createdWSIDs    []uuid.UUID
	createLinkErr   error
	createdToken    string
	createdExpiry   time.Time
	revoked         int
	revokedRows     int64
	linkByToken     JoinLink
	linkByTokenErr  error
	addedMember     uuid.UUID
	addedRole       string
	deletedMembers  int64
	deleteMemberErr error
	ownedTeams      []string
	demotedRows     int64
	promotedRows    int64
	demotedUserID   uuid.UUID
	promotedUserID  uuid.UUID
	wsPersonal      bool
	memberRoleErr   error
	members         []Member
	listMembersErr  error
}

func (f *fakeStore) ListByUser(_ context.Context, _ postgres.DBTX, userID uuid.UUID) ([]WorkspaceAccess, error) {
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
	if f.memberRoleErr != nil {
		return "", f.memberRoleErr
	}
	return string(RoleOwner), nil
}

// AccessContext по умолчанию — личное пространство владельца: заморозка не
// касается, и юниты создания/списка проверяют своё.
func (f *fakeStore) AccessContext(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (AccessContext, error) {
	return AccessContext{Role: string(RoleOwner), IsPersonal: true, MemberRank: 1}, nil
}

func (f *fakeStore) GetWorkspace(_ context.Context, _ postgres.DBTX, id uuid.UUID) (Workspace, error) {
	return Workspace{ID: id, Name: "Команда", IsPersonal: f.wsPersonal}, nil
}

// --- JoinLinkStore: ссылки проверяются интеграционно (нужны настоящие частичный
// UNIQUE и транзакция «отозвать + выписать»), здесь фейк удовлетворяет Store и
// помнит выписанное — тем, кому нужно большее, отдают joinStore ниже.

func (f *fakeStore) CreateJoinLink(_ context.Context, _ postgres.DBTX, token string, _ uuid.UUID, _ string, _ uuid.UUID, expiresAt time.Time) error {
	f.createdToken = token
	f.createdExpiry = expiresAt
	return f.createLinkErr
}

func (f *fakeStore) RevokeJoinLink(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (int64, error) {
	f.revoked++
	return f.revokedRows, nil
}

func (f *fakeStore) ActiveJoinLink(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (JoinLink, error) {
	return JoinLink{}, pgx.ErrNoRows
}

func (f *fakeStore) JoinLinkByToken(_ context.Context, _ postgres.DBTX, _ string) (JoinLink, error) {
	return f.linkByToken, f.linkByTokenErr
}

func (f *fakeStore) AddMember(_ context.Context, _ postgres.DBTX, _, userID uuid.UUID, role string) error {
	f.addedMember = userID
	f.addedRole = role
	return nil
}

func (f *fakeStore) PurgeExpiredJoinLinks(_ context.Context, _ postgres.DBTX) (int64, error) {
	return 0, nil
}

func (f *fakeStore) ListMembers(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]Member, error) {
	return f.members, f.listMembersErr
}

func (f *fakeStore) ListOwnedTeamsWithMembers(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]string, error) {
	return f.ownedTeams, nil
}

// DeleteMember отдаёт заданное число снятых строк: 0 — «нет такого или это
// владелец», и именно этот случай проверяют юниты выхода и снятия доступа.
func (f *fakeStore) DeleteMember(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (int64, error) {
	return f.deletedMembers, f.deleteMemberErr
}

// DemoteOwner/PromoteToOwner запоминают, КОГО понизили и КОГО повысили: порядок
// половин передачи владения держит уникальный индекс, а вот «понизили не того»
// база не заметит — обе строки для неё законны.
func (f *fakeStore) DemoteOwner(_ context.Context, _ postgres.DBTX, _, userID uuid.UUID) (int64, error) {
	f.demotedUserID = userID
	return f.demotedRows, nil
}

func (f *fakeStore) PromoteToOwner(_ context.Context, _ postgres.DBTX, _, userID uuid.UUID) (int64, error) {
	f.promotedUserID = userID
	return f.promotedRows, nil
}

func (f *fakeStore) Create(_ context.Context, _ postgres.DBTX, id uuid.UUID, slug, name string) (Workspace, error) {
	if f.createErr != nil {
		return Workspace{}, f.createErr
	}
	f.createdName = name
	f.createdSlugs = append(f.createdSlugs, slug)
	f.createdWSIDs = append(f.createdWSIDs, id)
	return Workspace{ID: id, Slug: slug, Name: name}, nil
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
	return NewService(nil, tx, store, plans, "https://app.example"), tx
}

// ListForUser пробрасывает userID в репозиторий и возвращает его результат.
func TestListForUser_DelegatesAndReturns(t *testing.T) {
	uid := uuid.New()
	store := &fakeStore{workspaces: []WorkspaceAccess{{
		Workspace:  Workspace{ID: uuid.New(), Name: "Личное пространство", IsPersonal: true},
		MemberRank: 1,
	}}}
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

// Пустой slug — не абстрактная придирка: колонка UNIQUE (0035), поэтому первое
// пространство с пустым ключом запишется, а второе упадёт на дубле. Компилятор
// такую дыру не видит (незаполненное поле параметров — валидный нулевой string),
// поэтому её сторожит тест.
func TestCreate_GeneratesUniqueSlug(t *testing.T) {
	uid := uuid.New()
	store := &fakeStore{}
	svc, _ := newTestService(store, &fakePlans{allowed: true})

	first, err := svc.Create(context.Background(), uid, "Первое")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	second, err := svc.Create(context.Background(), uid, "Второе")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	for i, got := range store.createdSlugs {
		if len(got) != domain.SlugLen {
			t.Errorf("в репозиторий ушёл slug %q длиной %d, ждали %d", got, len(got), domain.SlugLen)
		}
		if i > 0 && got == store.createdSlugs[i-1] {
			t.Errorf("два пространства подряд получили один slug %q — UNIQUE отвергнет второе", got)
		}
	}
	if first.Slug == "" || second.Slug == "" {
		t.Errorf("наружу отдан пустой slug: %q и %q", first.Slug, second.Slug)
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
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example")

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
			svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example")
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
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example")

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
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example").
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
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example").
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
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example").
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
	svc := NewService(nil, &fakeTx{}, store, &fakePlans{allowed: true}, "https://app.example").
		WithFiles(&fakeFiles{})

	if err := svc.Delete(context.Background(), uuid.New(), uuid.New()); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, ждали domain.ErrValidation", err)
	}
}

// Передача владения: обе половины идут ОДНОЙ транзакцией, понижают отдающего и
// повышают получателя — именно в эту сторону. Порядок операторов держит индекс
// в БД, а вот «понизили не того» база не заметит: обе строки для неё законны.
func TestTransferOwnership_SwapsTheRightPeople(t *testing.T) {
	store := &fakeStore{demotedRows: 1, promotedRows: 1}
	plans := &fakePlans{allowed: true}
	svc, tx := newTestService(store, plans)

	actor, newOwner := uuid.New(), uuid.New()
	if err := svc.TransferOwnership(context.Background(), actor, uuid.New(), newOwner); err != nil {
		t.Fatalf("передача владения: %v", err)
	}
	if !tx.opened {
		t.Error("половины передачи прошли вне транзакции")
	}
	if store.demotedUserID != actor {
		t.Errorf("понижен %s, а отдавал %s", store.demotedUserID, actor)
	}
	if store.promotedUserID != newOwner {
		t.Errorf("повышен %s, а получателем был %s", store.promotedUserID, newOwner)
	}
	// Тариф спрашивается у ПОЛУЧАТЕЛЯ: пространство работает по плану владельца,
	// и после передачи владелец — он.
	if plans.gotUser != newOwner {
		t.Errorf("тариф спрошен у %s, а получателем был %s", plans.gotUser, newOwner)
	}
	if plans.gotKey != entitlements.Workspaces {
		t.Errorf("спрошен ключ %q, ожидался %q", plans.gotKey, entitlements.Workspaces)
	}
}

func TestTransferOwnership_Refusals(t *testing.T) {
	actor := uuid.New()
	cases := []struct {
		name     string
		store    *fakeStore
		plans    *fakePlans
		newOwner uuid.UUID
		want     error
	}{
		{
			name:     "себе передавать нечего",
			store:    &fakeStore{demotedRows: 1, promotedRows: 1},
			plans:    &fakePlans{allowed: true},
			newOwner: actor,
			want:     domain.ErrValidation,
		},
		{
			// «Личное» помечено колонкой, а не ролью: передача развела бы два
			// факта — прежний хозяин видел бы пространство своим, не владея им.
			name:     "личное пространство",
			store:    &fakeStore{wsPersonal: true, demotedRows: 1, promotedRows: 1},
			plans:    &fakePlans{allowed: true},
			newOwner: uuid.New(),
			want:     domain.ErrValidation,
		},
		{
			name:     "получатель не участник",
			store:    &fakeStore{memberRoleErr: pgx.ErrNoRows, demotedRows: 1, promotedRows: 1},
			plans:    &fakePlans{allowed: true},
			newOwner: uuid.New(),
			want:     domain.ErrValidation,
		},
		{
			// Иначе пространство замёрзло бы для ВСЕХ сразу после успешного
			// действия, включая получателя, который об этом не просил.
			name:     "тариф получателя не покрывает",
			store:    &fakeStore{demotedRows: 1, promotedRows: 1},
			plans:    &fakePlans{allowed: false},
			newOwner: uuid.New(),
			want:     domain.ErrPlanRequired,
		},
		{
			// Владение уехало между проверкой права и записью.
			name:     "отдающий уже не владелец",
			store:    &fakeStore{demotedRows: 0, promotedRows: 1},
			plans:    &fakePlans{allowed: true},
			newOwner: uuid.New(),
			want:     domain.ErrValidation,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := newTestService(tc.store, tc.plans)
			err := svc.TransferOwnership(context.Background(), actor, uuid.New(), tc.newOwner)
			if !errors.Is(err, tc.want) {
				t.Fatalf("ошибка = %v, ожидалась %v", err, tc.want)
			}
			// Ни один отказ не повышает никого: последний из них ловится уже
			// внутри транзакции, но ДО второй половины, и откатывает первую.
			if tc.store.promotedUserID != uuid.Nil {
				t.Errorf("при отказе кого-то всё же повысили: %s", tc.store.promotedUserID)
			}
		})
	}
}
