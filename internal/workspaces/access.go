package workspaces

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
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
		domain.ActionFormRead:          true,
		domain.ActionFormWrite:         true,
		domain.ActionFormDelete:        true,
		domain.ActionSubmissionDelete:  true,
		domain.ActionBillingView:       true,
		domain.ActionMemberRead:        true,
		domain.ActionMemberManage:      true,
		domain.ActionWorkspaceManage:   true,
		domain.ActionWorkspaceDelete:   true,
		domain.ActionIntegrationRead:   true,
		domain.ActionIntegrationManage: true,
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
		domain.ActionWorkspaceDelete:  false,
		domain.ActionIntegrationRead:  true,
		// Подключение аккаунта Google — решение о вывозе персональных данных
		// респондентов наружу; его принимает владелец пространства, а не тот,
		// кому доверили править формы.
		domain.ActionIntegrationManage: false,
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
	domain.ActionWorkspaceDelete,
	domain.ActionIntegrationRead,
	domain.ActionIntegrationManage,
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
	acc, err := s.repo.AccessContext(ctx, s.db, workspaceID, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrNotFound
		}
		return err
	}
	if err := s.checkFrozen(ctx, acc); err != nil {
		return err
	}
	allowed, err := allows(Role(acc.Role), action)
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

// checkFrozen — пространство закрыто, если тариф ВЛАДЕЛЬЦА больше не покрывает
// столько пространств (ADR §10).
//
// Цена решения названа вслух: проверка стоит второго обращения к БД на каждый
// вопрос о правах, то есть на каждую операцию кабинета с формами. Платим
// сознательно (решение владельца 2026-08-02, вариант «а»): дешёвые альтернативы
// либо оставляли замороженное пространство рабочим через прямые вызовы API,
// либо заставляли SQL читать plans.limits — а лимиты знает только entitlements.
// Горячий путь приёма ответа сюда НЕ ходит: он публичный и прав не спрашивает,
// поэтому опубликованные формы замороженного пространства продолжают работать.
//
// Личное не замораживается никогда: иначе человек теряет доступ к собственным
// формам. Какие из дополнительных остаются доступными, решает не выбор пользователя,
// а возраст: место занимают самые старые.
func (s *Service) checkFrozen(ctx context.Context, acc AccessContext) error {
	// 1. Лишние ПРОСТРАНСТВА. Личное не замораживается никогда: иначе даунгрейд
	// отнимает у человека собственные формы, и жить ему негде.
	if !acc.IsPersonal {
		d, err := s.plans.CheckAccount(ctx, acc.OwnerID, entitlements.Workspaces)
		if err != nil {
			return err
		}
		// Лимит считает ВСЕ пространства владельца, включая личное, поэтому на
		// остальные приходится Limit-1 мест.
		if d.Limit != nil && acc.TeamRank > *d.Limit-1 {
			return domain.ErrWorkspaceFrozen
		}
	}

	// 2. Лишние УЧАСТНИКИ. Без этой проверки лимит мест действовал бы только в
	// момент приглашения: набрал команду на Pro, ушёл на Free — и все остались
	// работать бесплатно навсегда. Морозим не пространство, а именно лишних:
	// владельца от его форм отрезать нельзя, а выгонять людей — терять данные и
	// доверие. Возврат тарифа возвращает всех разом.
	//
	// Владелец всегда первый и потому не мёрзнет НИКОГДА — на этом же экономится
	// запрос: у самого частого спрашивающего второй поездки в БД не будет.
	if acc.MemberRank <= 1 {
		return nil
	}
	d, err := s.plans.CheckWorkspace(ctx, acc.WorkspaceID, entitlements.MembersPerWorkspace)
	if err != nil {
		return err
	}
	if d.Limit != nil && acc.MemberRank > *d.Limit {
		return domain.ErrWorkspaceFrozen
	}
	return nil
}

// AllowedActions — что этому человеку можно в этом пространстве. Нужен
// кабинету: кнопку, которой нет права, не рисуют, и логику матрицы для этого
// не дублируют в TypeScript.
func (s *Service) AllowedActions(ctx context.Context, workspaceID, userID uuid.UUID) ([]domain.Action, error) {
	acc, err := s.repo.AccessContext(ctx, s.db, workspaceID, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrNotFound
		}
		return nil, err
	}
	if err := s.checkFrozen(ctx, acc); err != nil {
		return nil, err
	}
	role := acc.Role
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
