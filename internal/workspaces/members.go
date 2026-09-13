package workspaces

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/httpserver"
)

// Member — участник пространства.
type Member struct {
	UserID uuid.UUID
	Email  string
	// FirstName/LastName/AvatarKey — как человек выглядит в списке: кружок с
	// картинкой или с инициалами. Пустые строки = не заполнено; кабинет тогда
	// зовёт по email и берёт его первую букву.
	FirstName string
	LastName  string
	AvatarKey string
	Role      Role
	JoinedAt  time.Time
}

// TeamsBlockingAccountDeletion — имена командных пространств, где человек
// владелец и есть кто-то ещё. Пустой список означает «удалять аккаунт можно».
//
// Вопрос задаёт auth (фаза 23, слайс G), и задаёт он его сюда, а не своим
// запросом: владение — понятие ЭТОГО модуля, а сравнение с ролью за его
// пределами запрещено (internal/CLAUDE.md). Импортировать workspaces из auth
// нельзя — цикл (handler workspaces стоит на RequireAuth), поэтому связь
// проложена интерфейсом на стороне auth и подключается в main.
func (s *Service) TeamsBlockingAccountDeletion(ctx context.Context, userID uuid.UUID) ([]string, error) {
	return s.repo.ListOwnedTeamsWithMembers(ctx, s.db, userID)
}

// Members — состав пространства.
//
// Списка «позвали, но ещё не вошёл» здесь больше нет и быть не может: ссылка
// никого не называет, поэтому между её выпиской и входом человека продукт про
// него ничего не знает (ADR §10). Состояние приглашения теперь одно — сама
// ссылка, и живёт она в своей ручке.
func (s *Service) Members(ctx context.Context, userID, workspaceID uuid.UUID) ([]Member, error) {
	if err := s.Can(ctx, workspaceID, userID, domain.ActionMemberRead); err != nil {
		return nil, err
	}
	return s.repo.ListMembers(ctx, s.db, workspaceID)
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

// TransferOwnership отдаёт пространство другому его участнику: отдающий
// становится редактором, получатель — владельцем и ПЛАТЕЛЬЩИКОМ.
//
// Порядок проверок несущий и повторяет Invite: сначала право, потом предмет,
// потом тариф, и только потом запись. Обратный порядок означал бы, что
// посторонний узнаёт состав чужого пространства, задав ему вопрос о передаче.
//
// Личное пространство не передаётся. Признак «личное» — это колонка
// personal_user_id, а не роль (WORKSPACES.md §1), и передача владения их бы
// развела: прежний хозяин продолжал бы видеть пространство своим (не покинуть,
// не удалить), не владея им.
//
// ⚠ ТАРИФ ПОЛУЧАТЕЛЯ СПРАШИВАЕТСЯ ДО ПЕРЕДАЧИ, И ЭТО НЕ ПЕРЕСТРАХОВКА.
// Пространство работает по плану своего владельца (ADR §10), поэтому передача
// человеку, чей план его не покрывает, заморозила бы пространство для ВСЕХ
// участников сразу после успешного действия — включая получателя, который об
// этом не просил. Заморозка задумана как следствие СВОЕГО даунгрейда, а не
// чужого подарка. Сегодня проверка ничего не запрещает (лимит `workspaces` у
// всех планов null), но включается она одним UPDATE'ом в plans.limits.
func (s *Service) TransferOwnership(ctx context.Context, actorID, workspaceID, newOwnerID uuid.UUID) error {
	if err := s.Can(ctx, workspaceID, actorID, domain.ActionOwnershipTransfer); err != nil {
		return err
	}
	if newOwnerID == actorID {
		return fmt.Errorf("%w: пространство уже ваше", domain.ErrValidation)
	}

	ws, err := s.repo.GetWorkspace(ctx, s.db, workspaceID)
	if err != nil {
		return err
	}
	if ws.IsPersonal {
		return fmt.Errorf("%w: личное пространство не передаётся", domain.ErrValidation)
	}

	// Получатель обязан быть участником: приглашение и передача — разные
	// действия, и «отдать пространство постороннему по id» не должно
	// существовать даже как побочный эффект.
	if _, err := s.repo.MemberRole(ctx, s.db, workspaceID, newOwnerID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: этот человек не состоит в пространстве", domain.ErrValidation)
		}
		return err
	}

	d, err := s.plans.CheckAccount(ctx, newOwnerID, entitlements.Workspaces)
	if err != nil {
		return err
	}
	if !d.Allowed {
		return fmt.Errorf("%w: тариф этого человека не позволяет принять пространство", domain.ErrPlanRequired)
	}

	// Обе половины — одной транзакцией и строго в этом порядке: частичный
	// уникальный индекс (0016) не даёт второго владельца, поэтому повышать до
	// понижения нельзя. Ноль строк на любой половине откатывает обе — состояние
	// «пространство без владельца» невыразимо индексом и недопустимо по TD-53.
	if err := s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		n, e := s.repo.DemoteOwner(ctx, tx, workspaceID, actorID)
		if e != nil {
			return e
		}
		if n == 0 {
			// Владение уехало между Can и этой строкой — параллельной передачей
			// или снятием роли. Повторять нечего: пространство уже не его.
			return fmt.Errorf("%w: вы больше не владелец этого пространства", domain.ErrValidation)
		}
		n, e = s.repo.PromoteToOwner(ctx, tx, workspaceID, newOwnerID)
		if e != nil {
			return e
		}
		if n == 0 {
			return fmt.Errorf("%w: этот человек не состоит в пространстве", domain.ErrValidation)
		}
		return nil
	}); err != nil {
		return err
	}

	// Поводы о превышении квоты адресованы тому, кому можно видеть тариф, а это
	// право только что переехало. Гасим их у ВСЕХ адресатов разом: у прежнего
	// владельца строка стала чужой новостью, а новому она и не приходила — следующий
	// сверхлимитный ответ поднимет повод заново, уже ему.
	//
	// После коммита и best-effort: откат вернул бы владение, но не вернул бы
	// погашенные строки, а ронять передачу владения из-за уведомления нельзя.
	if s.notes != nil {
		if err := s.notes.ClearOverQuota(ctx, workspaceID); err != nil {
			httpserver.LoggerFrom(ctx).Warn("over quota notifications not cleared after transfer",
				slog.String("workspace_id", workspaceID.String()), slog.String("error", err.Error()))
		}
	}
	return nil
}
