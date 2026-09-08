package workspaces

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// roleStore — подмена репозитория для проверок прав: отдаёт заданную роль
// либо pgx.ErrNoRows («не участник»).
type roleStore struct {
	fakeStore
	role    string
	roleErr error
}

func (r *roleStore) MemberRole(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (string, error) {
	return r.role, r.roleErr
}

// AccessContext отдаёт роль и ЛИЧНОЕ пространство: заморозка личного не
// касается, поэтому тесты матрицы проверяют ровно матрицу. Саму заморозку
// проверяет отдельный набор ниже и интеграционный тест.
func (r *roleStore) AccessContext(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (AccessContext, error) {
	return AccessContext{Role: r.role, IsPersonal: true, MemberRank: 1}, r.roleErr
}

func canService(role string, roleErr error) *Service {
	return NewService(nil, &fakeTx{}, &roleStore{role: role, roleErr: roleErr}, &fakePlans{allowed: true}, "https://app.example")
}

// Матрица «роль × действие» проверяется ПОЯЧЕЕЧНО (DoD фазы 18): таблица прав —
// это и есть продукт решения, и «протестировали пару строк» здесь не считается.
func TestCan_Matrix(t *testing.T) {
	want := map[Role]map[domain.Action]bool{
		RoleOwner: {
			domain.ActionFormRead:          true,
			domain.ActionFormWrite:         true,
			domain.ActionFormDelete:        true,
			domain.ActionSubmissionDelete:  true,
			domain.ActionBillingView:       true,
			domain.ActionMemberRead:        true,
			domain.ActionMemberManage:      true,
			domain.ActionWorkspaceManage:   true,
			domain.ActionWorkspaceDelete:   true,
			domain.ActionOwnershipTransfer: true,
		},
		RoleEditor: {
			domain.ActionFormRead:          true,
			domain.ActionFormWrite:         true,
			domain.ActionFormDelete:        true,
			domain.ActionSubmissionDelete:  true,
			domain.ActionBillingView:       false,
			domain.ActionMemberRead:        true,
			domain.ActionMemberManage:      false,
			domain.ActionWorkspaceManage:   false,
			domain.ActionWorkspaceDelete:   false,
			domain.ActionOwnershipTransfer: false,
		},
	}

	// Сторож на сам этот тест: ожидания здесь набраны отдельной рукой (в этом
	// весь смысл — сверять с матрицей независимую копию), поэтому новое действие
	// добавляется в roleActions и молча остаётся непроверенным здесь. Ячейка без
	// проверки хуже отсутствующей: она выглядит покрытой.
	for _, role := range []Role{RoleOwner, RoleEditor} {
		if len(want[role]) != len(AllActions) {
			t.Fatalf("у роли %q в ожиданиях %d ячеек, а действий %d — тест отстал от матрицы",
				role, len(want[role]), len(AllActions))
		}
	}

	for role, cells := range want {
		for action, allowed := range cells {
			t.Run(string(role)+"/"+string(action), func(t *testing.T) {
				svc := canService(string(role), nil)
				err := svc.Can(context.Background(), uuid.New(), uuid.New(), action)
				if allowed && err != nil {
					t.Fatalf("роли %q запрещено %q, а должно быть можно: %v", role, action, err)
				}
				if !allowed && !errors.Is(err, domain.ErrForbidden) {
					t.Fatalf("роли %q разрешено %q (err=%v), ждали domain.ErrForbidden", role, action, err)
				}
			})
		}
	}
}

// Каждая роль обязана называть КАЖДОЕ действие: молчание матрицы не должно
// значить ни «можно», ни «нельзя» — оно обязано краснеть. Тот же сторож, что
// TestPlansCoverCatalog у тарифов, и по той же причине: «забыли ячейку» иначе
// однажды раздаст права молча.
func TestMatrixCoversAllActions(t *testing.T) {
	for _, role := range []Role{RoleOwner, RoleEditor} {
		cells, ok := roleActions[role]
		if !ok {
			t.Fatalf("роль %q отсутствует в матрице", role)
		}
		for _, action := range AllActions {
			if _, named := cells[action]; !named {
				t.Errorf("роль %q не называет действие %q", role, action)
			}
		}
		if len(cells) != len(AllActions) {
			t.Errorf("у роли %q %d ячеек, а действий %d — матрица и список разошлись",
				role, len(cells), len(AllActions))
		}
	}
}

// Не участник получает 404, а не 403: существование чужого пространства не
// раскрывается (инвариант 5). Разница видна снаружи, поэтому проверяется.
func TestCan_NotMemberIsNotFound(t *testing.T) {
	svc := canService("", pgx.ErrNoRows)
	err := svc.Can(context.Background(), uuid.New(), uuid.New(), domain.ActionFormRead)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, ждали domain.ErrNotFound", err)
	}
	if errors.Is(err, domain.ErrForbidden) {
		t.Error("не участник получил 403 — это сообщает, что пространство существует")
	}
}

// Неизвестная роль — внутренняя ошибка (500), а не «нельзя»: молчание спрятало
// бы поломку конфигурации, и однажды спрятало бы разрешение.
func TestCan_UnknownRoleIsError(t *testing.T) {
	svc := canService("superadmin", nil)
	err := svc.Can(context.Background(), uuid.New(), uuid.New(), domain.ActionFormRead)
	if err == nil {
		t.Fatal("неизвестная роль обслужена молча")
	}
	if errors.Is(err, domain.ErrForbidden) || errors.Is(err, domain.ErrNotFound) {
		t.Errorf("неизвестная роль выдана за отказ по правам: %v", err)
	}
}

// Ошибка чтения роли долетает как есть: «спросить не удалось» — не «нельзя».
func TestCan_StoreErrorPropagates(t *testing.T) {
	wantErr := errors.New("db down")
	svc := canService("", wantErr)
	if err := svc.Can(context.Background(), uuid.New(), uuid.New(), domain.ActionFormRead); !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, ждали %v", err, wantErr)
	}
}

// AllowedActions отдаёт кабинету ровно разрешённое: редактор не получает ни
// тарифа, ни управления участниками, ни управления пространством.
func TestAllowedActions_Editor(t *testing.T) {
	svc := canService(string(RoleEditor), nil)
	got, err := svc.AllowedActions(context.Background(), uuid.New(), uuid.New())
	if err != nil {
		t.Fatalf("AllowedActions: %v", err)
	}
	has := map[domain.Action]bool{}
	for _, a := range got {
		has[a] = true
	}
	for _, a := range []domain.Action{domain.ActionBillingView, domain.ActionMemberManage} {
		if has[a] {
			t.Errorf("редактору отдано %q", a)
		}
	}
	for _, a := range []domain.Action{domain.ActionFormRead, domain.ActionFormWrite, domain.ActionFormDelete} {
		if !has[a] {
			t.Errorf("редактору не отдано %q", a)
		}
	}
}

// frozenStore — неличное пространство заданного ранга: проверяет решение о
// заморозке, а не матрицу прав.
type frozenStore struct {
	fakeStore
	rank int64
}

func (f *frozenStore) AccessContext(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (AccessContext, error) {
	return AccessContext{Role: string(RoleOwner), IsPersonal: false, TeamRank: f.rank, MemberRank: 1}, nil
}

func frozenService(rank int64, limit *int64) *Service {
	plans := &limitPlans{limit: limit}
	return NewService(nil, &fakeTx{}, &frozenStore{rank: rank}, plans, "https://app.example")
}

type limitPlans struct {
	limit *int64 // лимит пространств (CheckAccount)
	seats *int64 // лимит мест (CheckWorkspace)
	asked int    // сколько раз спросили места — сторож экономии на владельце
	// askedAccount — сколько раз спросили лимит пространств. Сторож памятки по
	// владельцам в списке: лимит у одного владельца один на все его пространства.
	askedAccount int
	err          error
}

func (p *limitPlans) CheckAccount(_ context.Context, _ uuid.UUID, _ entitlements.Key) (entitlements.Decision, error) {
	p.askedAccount++
	return entitlements.Decision{Allowed: true, Limit: p.limit}, p.err
}

func (p *limitPlans) CheckWorkspace(_ context.Context, _ uuid.UUID, _ entitlements.Key) (entitlements.Decision, error) {
	p.asked++
	return entitlements.Decision{Allowed: true, Limit: p.seats}, nil
}

// seatStore — участник заданного ранга в личном пространстве: проверяет
// заморозку ЛИШНИХ УЧАСТНИКОВ отдельно от заморозки пространств.
type seatStore struct {
	fakeStore
	rank int64
}

func (f *seatStore) AccessContext(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (AccessContext, error) {
	role := RoleEditor
	if f.rank == 1 {
		role = RoleOwner
	}
	return AccessContext{Role: string(role), IsPersonal: true, MemberRank: f.rank}, nil
}

// Лишние УЧАСТНИКИ замерзают, а пространство — нет: владелец от своих форм не
// отрезается, людей никто не выгоняет, возврат тарифа возвращает всех разом.
// Без этой проверки лимит мест действовал бы только в момент приглашения:
// набрал команду на Pro, ушёл на Free — и все работают бесплатно навсегда.
func TestCan_ExtraMembersFreeze(t *testing.T) {
	two := int64(2)
	tests := []struct {
		name   string
		rank   int64
		seats  *int64
		frozen bool
	}{
		{"владелец не мёрзнет никогда", 1, &two, false},
		{"первый приглашённый в лимите", 2, &two, false},
		{"третий — лишний", 3, &two, true},
		{"безлимит мест — не мёрзнет никто", 9, nil, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			plans := &limitPlans{seats: tc.seats}
			svc := NewService(nil, &fakeTx{}, &seatStore{rank: tc.rank}, plans, "https://app.example")
			err := svc.Can(context.Background(), uuid.New(), uuid.New(), domain.ActionFormRead)
			if tc.frozen && !errors.Is(err, domain.ErrWorkspaceFrozen) {
				t.Fatalf("err = %v, ждали ErrWorkspaceFrozen", err)
			}
			if !tc.frozen && err != nil {
				t.Fatalf("участник в лимите закрыт: %v", err)
			}
			// Экономия названа вслух и проверена: у владельца — самого частого
			// спрашивающего — второй поездки в БД за лимитом мест не будет.
			if tc.rank == 1 && plans.asked != 0 {
				t.Errorf("для владельца спросили места %d раз, ждали 0", plans.asked)
			}
		})
	}
}

// Заморозка при даунгрейде: лимит считает ВСЕ пространства владельца, включая
// личное, поэтому на остальные приходится Limit-1 мест.
func TestCan_FrozenWhenOwnerPlanShrank(t *testing.T) {
	one, two := int64(1), int64(2)
	tests := []struct {
		name   string
		rank   int64
		limit  *int64
		frozen bool
	}{
		{"безлимит — не мёрзнет никто", 5, nil, false},
		{"лимит 1: личное занимает единственное место", 1, &one, true},
		{"лимит 2: первое дополнительное живо", 1, &two, false},
		{"лимит 2: второе дополнительное заморожено", 2, &two, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := frozenService(tc.rank, tc.limit).
				Can(context.Background(), uuid.New(), uuid.New(), domain.ActionFormRead)
			if tc.frozen && !errors.Is(err, domain.ErrWorkspaceFrozen) {
				t.Fatalf("err = %v, ждали ErrWorkspaceFrozen", err)
			}
			if !tc.frozen && err != nil {
				t.Fatalf("живое пространство закрыто: %v", err)
			}
		})
	}
}

// Личное пространство не замораживается никогда — даже когда лимит нулевой:
// иначе человек теряет доступ к собственным формам.
func TestCan_PersonalNeverFrozen(t *testing.T) {
	zero := int64(0)
	svc := NewService(nil, &fakeTx{}, &roleStore{role: string(RoleOwner)},
		&limitPlans{limit: &zero}, "https://app.example")
	if err := svc.Can(context.Background(), uuid.New(), uuid.New(), domain.ActionFormRead); err != nil {
		t.Fatalf("личное пространство заморожено: %v", err)
	}
}

// bothStore — ОДНО И ТО ЖЕ пространство, увиденное двумя способами: контекстом
// доступа (горячий путь прав) и строкой списка (вывеска кабинета).
type bothStore struct {
	fakeStore
	isPersonal bool
	teamRank   int64
	memberRank int64
}

func (s *bothStore) AccessContext(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (AccessContext, error) {
	role := RoleOwner
	if s.memberRank > 1 {
		role = RoleEditor
	}
	return AccessContext{
		Role: string(role), IsPersonal: s.isPersonal,
		TeamRank: s.teamRank, MemberRank: s.memberRank,
	}, nil
}

func (s *bothStore) ListByUser(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]WorkspaceAccess, error) {
	return []WorkspaceAccess{{
		Workspace:  Workspace{ID: uuid.New(), Name: "Пространство", IsPersonal: s.isPersonal},
		OwnerID:    uuid.New(),
		TeamRank:   s.teamRank,
		MemberRank: s.memberRank,
	}}, nil
}

// ГЛАВНЫЙ СТОРОЖ ЗАМОРОЗКИ: запрет и пометка обязаны говорить одно и то же.
//
// Спрашивающих о заморозке двое — checkFrozen (не пускает к операции) и
// frozenForList (рисует пометку в кабинете), и порядок веток с ленивостью запросов
// у них разный: у первого горячий путь прав, у второго список на каждый экран.
// Разъехавшись, они дадут худшее из состояний: интерфейс показывает пространство
// рабочим, а первое же действие отвечает 402 без объяснения. Поэтому проверяется не
// каждый по отдельности, а ИХ СОВПАДЕНИЕ на одних и тех же входах.
func TestFrozen_ListAgreesWithAccessCheck(t *testing.T) {
	one, two := int64(1), int64(2)
	tests := []struct {
		name       string
		isPersonal bool
		teamRank   int64
		memberRank int64
		limit      *int64
		seats      *int64
	}{
		{"личное владельца", true, 0, 1, &one, &two},
		{"личное с лишним участником", true, 0, 3, &one, &two},
		{"личное с участником в лимите", true, 0, 2, &one, &two},
		{"первое дополнительное в лимите", false, 1, 1, &two, &two},
		{"второе дополнительное сверх лимита", false, 2, 1, &two, &two},
		{"дополнительное при лимите 1", false, 1, 1, &one, &two},
		{"безлимит пространств", false, 9, 1, nil, &two},
		{"безлимит мест", true, 0, 9, &one, nil},
		{"лишний участник дополнительного", false, 1, 3, &two, &two},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			store := &bothStore{isPersonal: tc.isPersonal, teamRank: tc.teamRank, memberRank: tc.memberRank}
			plans := &limitPlans{limit: tc.limit, seats: tc.seats}
			svc := NewService(nil, &fakeTx{}, store, plans, "https://app.example")

			err := svc.Can(context.Background(), uuid.New(), uuid.New(), domain.ActionFormRead)
			blocked := errors.Is(err, domain.ErrWorkspaceFrozen)
			if err != nil && !blocked {
				t.Fatalf("Can вернул неожиданную ошибку: %v", err)
			}

			list, err := svc.ListForUser(context.Background(), uuid.New())
			if err != nil {
				t.Fatalf("ListForUser: %v", err)
			}
			if list[0].Frozen != blocked {
				t.Fatalf("пометка = %v, а операция закрыта = %v — вывеска разошлась с запретом",
					list[0].Frozen, blocked)
			}
		})
	}
}

// Отказ тарифа НЕ роняет список: заморозка — вывеска, а настоящий запрет всё равно
// стоит на каждой операции. Уронить единственный запрос, на котором держится вся
// навигация кабинета, ради пометки — обмен не в ту сторону.
func TestListForUser_PlanFailureLeavesListUsable(t *testing.T) {
	two := int64(2)
	store := &bothStore{isPersonal: false, teamRank: 5, memberRank: 1}
	plans := &limitPlans{limit: &two, err: errors.New("тариф недоступен")}
	svc := NewService(nil, &fakeTx{}, store, plans, "https://app.example")

	list, err := svc.ListForUser(context.Background(), uuid.New())
	if err != nil {
		t.Fatalf("список упал из-за пометки: %v", err)
	}
	if len(list) != 1 || list[0].Frozen {
		t.Fatalf("пометка = %+v, ждали список без пометки", list)
	}
}

// manyStore — два дополнительных пространства ОДНОГО владельца: сторож памятки.
type manyStore struct {
	fakeStore
	ownerID uuid.UUID
}

func (s *manyStore) ListByUser(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]WorkspaceAccess, error) {
	return []WorkspaceAccess{
		{Workspace: Workspace{ID: uuid.New(), IsPersonal: true}, OwnerID: s.ownerID, MemberRank: 1},
		{Workspace: Workspace{ID: uuid.New()}, OwnerID: s.ownerID, TeamRank: 1, MemberRank: 1},
		{Workspace: Workspace{ID: uuid.New()}, OwnerID: s.ownerID, TeamRank: 2, MemberRank: 1},
	}, nil
}

// Лимит спрашивается ПО ВЛАДЕЛЬЦАМ, а не по пространствам: список читается на
// каждом экране кабинета, и построчный вопрос к тарифу был бы N+1 ради вывески.
// Личное при этом не спрашивает вовсе — оно не замораживается никогда.
func TestListForUser_AsksPlanOncePerOwner(t *testing.T) {
	two := int64(2)
	plans := &limitPlans{limit: &two}
	svc := NewService(nil, &fakeTx{}, &manyStore{ownerID: uuid.New()}, plans, "https://app.example")

	list, err := svc.ListForUser(context.Background(), uuid.New())
	if err != nil {
		t.Fatalf("ListForUser: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("длина списка = %d, ждали 3", len(list))
	}
	if plans.askedAccount != 1 {
		t.Errorf("лимит пространств спросили %d раз, ждали 1 на владельца", plans.askedAccount)
	}
	// Все трое — владельца, поэтому места не спрашиваются ни разу.
	if plans.asked != 0 {
		t.Errorf("места спросили %d раз, ждали 0", plans.asked)
	}
	// Лимит 2: личное занимает место, первое дополнительное живо, второе замёрзло.
	if list[0].Frozen || list[1].Frozen || !list[2].Frozen {
		t.Errorf("пометки = %v/%v/%v, ждали false/false/true",
			list[0].Frozen, list[1].Frozen, list[2].Frozen)
	}
}
