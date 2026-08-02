package workspaces

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/postgres"
)

const (
	// inviteTTL — срок жизни ссылки. Неделя, а не полчаса как у сброса пароля:
	// приглашение не срочное, его читают «когда дойдут руки», а протухшая
	// ссылка стоит владельцу повторной отправки.
	inviteTTL = 7 * 24 * time.Hour
	// inviteTokenBytes — 256 бит случайности; в БД лёг только SHA-256.
	inviteTokenBytes = 32
	// MaxEmailLen — потолок адреса приглашения (совпадает с потолком в auth).
	MaxEmailLen = 254
)

// Invitation — приглашение, каким его видит приглашённый ДО принятия.
type Invitation struct {
	WorkspaceID   uuid.UUID
	WorkspaceName string
	Email         string
	Role          Role
	ExpiresAt     time.Time
	UsedAt        *time.Time
}

// Expired сообщает, что срок ссылки вышел.
func (i Invitation) Expired(now time.Time) bool { return !now.Before(i.ExpiresAt) }

// Used сообщает, что по ссылке уже вошли.
func (i Invitation) Used() bool { return i.UsedAt != nil }

// InviteStore — данные приглашений (часть Store, вынесена для читаемости).
type InviteStore interface {
	CreateInvitation(ctx context.Context, db postgres.DBTX, tokenHash []byte, workspaceID uuid.UUID, email, role string, invitedBy uuid.UUID, expiresAt time.Time) error
	DeletePendingInvitation(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, email string) error
	GetInvitation(ctx context.Context, db postgres.DBTX, tokenHash []byte) (Invitation, error)
	ConsumeInvitation(ctx context.Context, db postgres.DBTX, tokenHash []byte) (Invitation, error)
	AddMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID, role string) error
	UserIDByEmail(ctx context.Context, db postgres.DBTX, email string) (uuid.UUID, error)
}

// MailEnqueuer — постановка письма в outbox В ТОЙ ЖЕ транзакции, что и токен:
// либо есть и ссылка, и письмо в очереди, либо ничего (transactional outbox).
type MailEnqueuer interface {
	EnqueueEmail(ctx context.Context, db postgres.DBTX, msg mail.EmailMessage) error
}

// Invite создаёт приглашение и ставит письмо в очередь.
//
// Порядок проверок не косметический: сначала право (приглашать может только
// владелец), потом тариф (места), потом уже запись. Обратный порядок означал бы,
// что посторонний узнаёт лимит чужого пространства.
func (s *Service) Invite(ctx context.Context, inviterID, workspaceID uuid.UUID, email string, role Role) error {
	if err := s.Can(ctx, workspaceID, inviterID, domain.ActionMemberManage); err != nil {
		return err
	}

	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || !strings.Contains(email, "@") || len(email) > MaxEmailLen {
		return fmt.Errorf("%w: неверный email", domain.ErrValidation)
	}
	// Владельцем не приглашают: он ровно один, и передача владения — отдельное
	// действие, а не побочный эффект приглашения (то же правило CHECK'ом в 0017).
	if role != RoleEditor {
		return fmt.Errorf("%w: приглашать можно только ролью editor", domain.ErrValidation)
	}

	// Уже участник — не ошибка сервера, а сообщение человеку: второй строки
	// членства всё равно не будет (PK), но молча «пригласить» его нельзя, иначе
	// владелец будет ждать письма, которое ничего не изменит.
	if uid, err := s.repo.UserIDByEmail(ctx, s.db, email); err == nil {
		if _, err := s.repo.MemberRole(ctx, s.db, workspaceID, uid); err == nil {
			return fmt.Errorf("%w: этот человек уже в пространстве", domain.ErrConflict)
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}

	d, err := s.plans.CheckWorkspace(ctx, workspaceID, entitlements.MembersPerWorkspace)
	if err != nil {
		return err
	}
	if !d.Allowed {
		return domain.ErrPlanRequired
	}

	rawToken, err := newInviteToken()
	if err != nil {
		return err
	}
	ws, err := s.repo.GetWorkspace(ctx, s.db, workspaceID)
	if err != nil {
		return err
	}
	inviter, err := s.repo.EmailByUserID(ctx, s.db, inviterID)
	if err != nil {
		return err
	}
	link := s.appBaseURL + "/invite?token=" + url.QueryEscape(rawToken)

	return s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		// Прежнее непринятое приглашение этому адресу снимается: годной должна
		// остаться ровно одна ссылка, иначе отозвать приглашение невозможно —
		// у человека на руках останется старое письмо.
		if e := s.repo.DeletePendingInvitation(ctx, tx, workspaceID, email); e != nil {
			return e
		}
		if e := s.repo.CreateInvitation(ctx, tx, hashInviteToken(rawToken),
			workspaceID, email, string(role), inviterID, time.Now().Add(inviteTTL)); e != nil {
			return e
		}
		return s.mail.EnqueueEmail(ctx, tx, mail.EmailMessage{
			To:       email,
			Template: mail.TemplateWorkspaceInvite,
			Data: map[string]any{
				"link":      link,
				"workspace": ws.Name,
				"inviter":   inviter,
			},
		})
	})
}

// PreviewInvitation показывает приглашение по ссылке ДО входа: кто зовёт и куда.
// Аутентификации не требует намеренно — приглашённого аккаунта может ещё не
// быть, и он должен понимать, куда его зовут, до регистрации.
//
// Токен здесь — сам по себе право: знание ссылки и есть доказательство. Поэтому
// неизвестный токен неотличим от истёкшего для постороннего — оба ErrNotFound.
func (s *Service) PreviewInvitation(ctx context.Context, rawToken string) (Invitation, error) {
	inv, err := s.repo.GetInvitation(ctx, s.db, hashInviteToken(rawToken))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Invitation{}, domain.ErrNotFound
		}
		return Invitation{}, err
	}
	return inv, nil
}

// AcceptInvitation принимает приглашение вошедшим пользователем.
//
// Потребление токена — атомарный UPDATE (0017): повтор получает 0 строк,
// поэтому одной ссылкой нельзя войти дважды, а гонка двух вкладок не создаёт
// двух членств. Проверка «тот ли адрес» — на нашей стороне: ссылка попадает в
// почту приглашённого, но переслать её можно кому угодно.
func (s *Service) AcceptInvitation(ctx context.Context, userID uuid.UUID, userEmail, rawToken string) (Workspace, error) {
	inv, err := s.PreviewInvitation(ctx, rawToken)
	if err != nil {
		return Workspace{}, err
	}
	if !strings.EqualFold(strings.TrimSpace(userEmail), inv.Email) {
		// 403, а не 404: ссылку он открыл законно (она у него на руках), просто
		// звали не его — и сказать это надо прямо, иначе человек будет думать,
		// что ссылка сломалась.
		return Workspace{}, domain.ErrForbidden
	}

	var ws Workspace
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		consumed, e := s.repo.ConsumeInvitation(ctx, tx, hashInviteToken(rawToken))
		if e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				// Ссылка уже использована или протухла. Различать эти два случая
				// в ответе незачем — действие одно: попросить новую.
				return domain.ErrLinkExpired
			}
			return e
		}
		if e := s.repo.AddMember(ctx, tx, consumed.WorkspaceID, userID, string(consumed.Role)); e != nil {
			return e
		}
		w, e := s.repo.GetWorkspace(ctx, tx, consumed.WorkspaceID)
		if e != nil {
			return e
		}
		ws = w
		return nil
	})
	if err != nil {
		return Workspace{}, err
	}
	return ws, nil
}

// newInviteToken — 256-битный случайный токен в base64url (в БД лёг только его
// SHA-256, как у сессии и у сброса пароля).
func newInviteToken() (string, error) {
	b := make([]byte, inviteTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("workspaces: read token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// hashInviteToken — в БД хранится только SHA-256 (утечка дампа не даёт ссылок).
func hashInviteToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
