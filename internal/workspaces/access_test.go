package workspaces

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
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
			domain.ActionWorkspaceManage:  true,
		},
		RoleEditor: {
			domain.ActionFormRead:         true,
			domain.ActionFormWrite:        true,
			domain.ActionFormDelete:       true,
			domain.ActionSubmissionDelete: true,
			domain.ActionBillingView:      false,
			domain.ActionMemberRead:       true,
			domain.ActionMemberManage:     false,
			domain.ActionWorkspaceManage:  false,
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
	for _, a := range []domain.Action{domain.ActionBillingView, domain.ActionMemberManage, domain.ActionWorkspaceManage} {
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
