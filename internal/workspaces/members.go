package workspaces

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Member — участник пространства.
type Member struct {
	UserID   uuid.UUID
	Email    string
	Role     Role
	JoinedAt time.Time
}

// PendingInvite — позвали, но ещё не вошёл. Показывается на той же странице,
// что и участники: это тоже состояние пространства, и отозвать приглашение
// человек идёт туда же, куда снимать доступ.
type PendingInvite struct {
	Email     string
	Role      Role
	ExpiresAt time.Time
}

// Members — состав пространства: участники и непринятые приглашения.
func (s *Service) Members(ctx context.Context, userID, workspaceID uuid.UUID) ([]Member, []PendingInvite, error) {
	if err := s.Can(ctx, workspaceID, userID, domain.ActionMemberRead); err != nil {
		return nil, nil, err
	}
	members, err := s.repo.ListMembers(ctx, s.db, workspaceID)
	if err != nil {
		return nil, nil, err
	}
	// Непринятые приглашения видит только тот, кто может ими управлять: адреса
	// позванных — не то, что нужно знать редактору.
	//
	// Различать «нельзя» и «спросить не удалось» здесь обязательно: проглоти мы
	// вторую — владелец увидел бы пустой список приглашённых, выписал бы
	// повторное, и первая ссылка молча аннулировалась бы у человека на руках.
	var invites []PendingInvite
	switch err := s.Can(ctx, workspaceID, userID, domain.ActionMemberManage); {
	case err == nil:
		invites, err = s.repo.ListPendingInvites(ctx, s.db, workspaceID)
		if err != nil {
			return nil, nil, err
		}
	case errors.Is(err, domain.ErrForbidden):
		// Роль не даёт — законный случай: редактор видит состав без приглашений.
	default:
		return nil, nil, err
	}
	return members, invites, nil
}

// RemoveMember снимает доступ участнику.
//
// Владельца удалить нельзя ВООБЩЕ — ни чужой рукой, ни своей: пространство без
// владельца не имеет плана и становится осиротевшим (TD-53). Сторож стоит в
// самом запросе (role <> 'owner'), а не только здесь: правило про деньги, и
// одной проверки в Go для него мало.
func (s *Service) RemoveMember(ctx context.Context, actorID, workspaceID, memberID uuid.UUID) error {
	if err := s.Can(ctx, workspaceID, actorID, domain.ActionMemberManage); err != nil {
		return err
	}
	n, err := s.repo.DeleteMember(ctx, s.db, workspaceID, memberID)
	if err != nil {
		return err
	}
	if n == 0 {
		// Либо такого участника нет, либо это владелец. Различать незачем:
		// в обоих случаях состав не изменился, и действие человека одно.
		return fmt.Errorf("%w: участника нельзя удалить (нет такого или это владелец)", domain.ErrValidation)
	}
	return nil
}

// Leave — выход из пространства своей рукой. Владелец выйти не может: см.
// RemoveMember. Личное пространство не покидают по той же причине — оно и есть
// пространство самого человека.
func (s *Service) Leave(ctx context.Context, userID, workspaceID uuid.UUID) error {
	// Право не спрашиваем: выйти может любой участник, включая редактора.
	// Но членство проверить обязаны — иначе «выход» из чужого пространства
	// сообщал бы о его существовании.
	if _, err := s.repo.MemberRole(ctx, s.db, workspaceID, userID); err != nil {
		return domain.ErrNotFound
	}
	n, err := s.repo.DeleteMember(ctx, s.db, workspaceID, userID)
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: владелец не может покинуть пространство", domain.ErrValidation)
	}
	return nil
}
