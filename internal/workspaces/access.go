package workspaces

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Role — роль участника в пространстве.
type Role string

const (
	// RoleOwner — владелец: может всё, включая тариф и участников. Он же
	// плательщик, и он ровно один (уникальный частичный индекс в 0016).
	RoleOwner Role = "owner"
	// RoleEditor — редактор: формы и ответы, но не тариф и не участники.
	RoleEditor Role = "editor"
)

// roleActions — матрица «роль × действие». ЕДИНСТВЕННОЕ место, где записано,
// кому что можно; всё остальное спрашивает Can.
//
// Перечисление явное, без «owner может всё»: список действий растёт, и
// «может всё» однажды тихо раздаст роли то, чего ей давать не собирались.
// Каждая ячейка покрыта тестом (TestCan_Matrix).
//
// Решение владельца 2026-08-02 по двум спорным строкам: удаление формы editor'у
// РАЗРЕШЕНО (иначе «редактор» не редактор, а испортить он и так может правкой),
// список участников editor ВИДИТ (знать, с кем работаешь, безобидно).
var roleActions = map[Role]map[domain.Action]bool{
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

// AllActions — все действия, которые обязана называть каждая роль. Молчание
// матрицы про действие не должно значить ни «можно», ни «нельзя» — оно обязано
// краснеть (TestMatrixCoversAllActions), ровно как молчание плана про ключ
// тарифа в entitlements.
var AllActions = []domain.Action{
	domain.ActionFormRead,
	domain.ActionFormWrite,
	domain.ActionFormDelete,
	domain.ActionSubmissionDelete,
	domain.ActionBillingView,
	domain.ActionMemberRead,
	domain.ActionMemberManage,
	domain.ActionWorkspaceManage,
}

// allows — чистое решение по матрице, без БД: роль + действие → можно ли.
// Вынесено отдельно, чтобы матрица проверялась табличным юнитом поячеечно.
func allows(role Role, action domain.Action) (bool, error) {
	actions, ok := roleActions[role]
	if !ok {
		return false, fmt.Errorf("workspaces: неизвестная роль %q", role)
	}
	allowed, ok := actions[action]
	if !ok {
		return false, fmt.Errorf("workspaces: роль %q молчит про действие %q", role, action)
	}
	return allowed, nil
}

// Can — единственный вопрос, который остальной код задаёт про права:
// «можно ли ЭТОМУ человеку ЭТО действие в ЭТОМ пространстве».
//
// Возвращает error, а не bool: у права нет промежуточных состояний (в отличие
// от квоты тарифа, где вызывающему нужен факт «сверх лимита»), а вызов первой
// строкой сервис-метода читается как охрана.
//
// Два разных отказа, и путать их нельзя:
//
//   - не участник → ErrNotFound (404). Существование чужого пространства не
//     раскрывается: 403 сообщил бы «оно есть, просто не твоё» (инвариант 5).
//   - участник, но роль не даёт → ErrForbidden (403). Пространство он и так
//     видит, скрывать нечего, а «404» на кнопке, которая у него есть, читалось
//     бы как поломка.
func (s *Service) Can(ctx context.Context, workspaceID, userID uuid.UUID, action domain.Action) error {
	role, err := s.repo.MemberRole(ctx, s.db, workspaceID, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		return err
	}
	allowed, err := allows(Role(role), action)
	if err != nil {
		// Неизвестная роль или дыра в матрице — внутренняя ошибка (500), а не
		// молчаливое «нельзя»: молчание спрятало бы поломку конфигурации.
		return err
	}
	if !allowed {
		return domain.ErrForbidden
	}
	return nil
}

// AllowedActions — что этому человеку можно в этом пространстве. Нужен
// кабинету: кнопку, которой нет права, не рисуют, и логику матрицы для этого
// не дублируют в TypeScript.
func (s *Service) AllowedActions(ctx context.Context, workspaceID, userID uuid.UUID) ([]domain.Action, error) {
	role, err := s.repo.MemberRole(ctx, s.db, workspaceID, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	out := make([]domain.Action, 0, len(AllActions))
	for _, a := range AllActions {
		allowed, err := allows(Role(role), a)
		if err != nil {
			return nil, err
		}
		if allowed {
			out = append(out, a)
		}
	}
	return out, nil
}
