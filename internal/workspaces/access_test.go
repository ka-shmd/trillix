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
	return AccessContext{Role: r.role, IsPersonal: true}, r.roleErr
}

func canService(role string, roleErr error) *Service {
	return NewService(nil, &fakeTx{}, &roleStore{role: role, roleErr: roleErr}, &fakePlans{allowed: true}, nil, "https://app.example")
}

// Матрица «роль × действие» проверяется ПОЯЧЕЕЧНО (DoD фазы 18): таблица прав —
// это и есть продукт решения, и «протестировали пару строк» здесь не считается.
func TestCan_Matrix(t *testing.T) {
	want := map[Role]map[domain.Action]bool{
		RoleOwner: {
			domain.ActionFormRead:         true,
			domain.ActionFormWrite:        true,
			domain.ActionFormDelete:       true,
			domain.ActionSubmissionDelete: true,
			domain.ActionBillingView:      true,
			domain.ActionMemberRead:       true,
			domain.ActionMemberManage:     true,
		},
		RoleEditor: {
			domain.ActionFormRead:         true,
			domain.ActionFormWrite:        true,
			domain.ActionFormDelete:       true,
			domain.ActionSubmissionDelete: true,
			domain.ActionBillingView:      false,
			domain.ActionMemberRead:       true,
			domain.ActionMemberManage:     false,
		},
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

// frozenStore — командное пространство заданного ранга: проверяет решение о
// заморозке, а не матрицу прав.
type frozenStore struct {
	fakeStore
	rank int64
}

func (f *frozenStore) AccessContext(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (AccessContext, error) {
	return AccessContext{Role: string(RoleOwner), IsPersonal: false, TeamRank: f.rank}, nil
}

func frozenService(rank int64, limit *int64) *Service {
	plans := &limitPlans{limit: limit}
	return NewService(nil, &fakeTx{}, &frozenStore{rank: rank}, plans, nil, "https://app.example")
}

type limitPlans struct{ limit *int64 }

func (p *limitPlans) CheckAccount(_ context.Context, _ uuid.UUID, _ entitlements.Key) (entitlements.Decision, error) {
	return entitlements.Decision{Allowed: true, Limit: p.limit}, nil
}

func (p *limitPlans) CheckWorkspace(_ context.Context, _ uuid.UUID, _ entitlements.Key) (entitlements.Decision, error) {
	return entitlements.Decision{Allowed: true}, nil
}

// Заморозка при даунгрейде: лимит считает ВСЕ пространства владельца, включая
// личное, поэтому на командные приходится Limit-1 мест.
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
		{"лимит 2: первое командное живо", 1, &two, false},
		{"лимит 2: второе командное заморожено", 2, &two, true},
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
		&limitPlans{limit: &zero}, nil, "https://app.example")
	if err := svc.Can(context.Background(), uuid.New(), uuid.New(), domain.ActionFormRead); err != nil {
		t.Fatalf("личное пространство заморожено: %v", err)
	}
}
