package workspaces

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// MaxNameLen — потолок имени пространства в рунах. Имя видно в сайдбаре и
// крошках, длинное там всё равно обрезается многоточием.
const MaxNameLen = 60

// Store — доступ к данным workspaces, объявленный на стороне потребителя
// (сервиса). Реализация — Repo; в тестах подменяется фейком.
type Store interface {
	ListByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]WorkspaceAccess, error)
	// MemberRole — роль участника; pgx.ErrNoRows означает «не участник».
	MemberRole(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (string, error)
	GetWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Workspace, error)
	// AccessContext — роль плюс всё, что нужно для решения о заморозке.
	AccessContext(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (AccessContext, error)
	JoinLinkStore
	ListMembers(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]Member, error)
	ListOwnedTeamsWithMembers(ctx context.Context, db postgres.DBTX, userID uuid.UUID) ([]string, error)
	DeleteMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (int64, error)
	Create(ctx context.Context, db postgres.DBTX, id uuid.UUID, slug, name string) (Workspace, error)
	Rename(ctx context.Context, db postgres.DBTX, id uuid.UUID, name string) (Workspace, error)
	Delete(ctx context.Context, db postgres.DBTX, id uuid.UUID) (int64, error)
	AddOwner(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) error
	// DemoteOwner/PromoteToOwner — две половины передачи владения; порознь не
	// вызываются никогда (см. TransferOwnership).
	DemoteOwner(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (int64, error)
	PromoteToOwner(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (int64, error)
}

var _ Store = Repo{}

// Notifications — уведомления кабинета глазами этого модуля (internal/notify).
// Объявлен здесь, у потребителя, и НАМЕРЕННО узкий: про поводы и их ключи модуль
// прав знать не должен, иначе за правами в него приехал бы реестр поводов.
//
// nil = уведомлений в сборке нет (так собран модуль в тестах прав).
type Notifications interface {
	// ClearOverQuota гасит непрочитанные поводы о превышении квоты пространства.
	ClearOverQuota(ctx context.Context, workspaceID uuid.UUID) error
}

// Transactor открывает транзакцию (без знания о конкретном пуле). Реализация —
// postgres.TxRunner; в тестах — фейк, выполняющий fn без реальной БД.
type Transactor interface {
	WithTx(ctx context.Context, fn func(pgx.Tx) error) error
}

// Plans — единая точка лимитов глазами этого модуля (internal/entitlements).
// Спрашивается ПОДПИСКА АККАУНТА, а не план воркспейса: нового пространства
// ещё нет, а старое к нему отношения не имеет (ADR §10).
type Plans interface {
	CheckAccount(ctx context.Context, userID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
	// CheckWorkspace — лимит самого пространства (места), спрашивается у плана
	// его владельца.
	CheckWorkspace(ctx context.Context, workspaceID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
}

// Files — файлы ответов глазами этого модуля (internal/answerfiles). Нужен ровно
// для удаления пространства: каскад БД уносит строки загрузок вместе с ключами
// объектов, а сами объекты остаются в бакете, и найти их после этого нечем.
// Модули общаются интерфейсом потребителя, а не импортом чужого repo.
type Files interface {
	RemoveByWorkspace(ctx context.Context, workspaceID uuid.UUID) error
}

// Service — бизнес-логика пространств: список своих и создание новых.
// Право доступа к списку обеспечивает запрос — возвращаются лишь пространства
// с членством (инвариант безопасности 1).
type Service struct {
	db    postgres.DBTX // пул: чтение списка
	tx    Transactor    // пространство + владелец одной транзакцией
	repo  Store
	plans Plans
	// files — снос объектов ответов при удалении пространства. nil допустим:
	// хранилище настраивается опционально (как и у forms), и без него удаление
	// сносит только строки — файлов в такой сборке нет и быть не может.
	files Files
	// notes — уведомления кабинета. Сеттером, а не аргументом конструктора: связь
	// обратная (notify спрашивает у нас права), и в конструкторе её было бы не
	// собрать — сервис уведомлений строится позже нас.
	notes Notifications
	// appBaseURL — origin кабинета, из которого строится ссылка приглашения.
	appBaseURL string
}

// Писем модуль больше не шлёт: приглашение по адресу почты вырезано, а ссылку
// человек передаёт сам (ADR §10). Поэтому ни MailEnqueuer, ни лимитера отправки
// здесь нет — лимитер существовал ровно потому, что письмо уходило на
// ПРОИЗВОЛЬНЫЙ адрес с подконтрольным отправителю текстом.
func NewService(db postgres.DBTX, tx Transactor, repo Store, plans Plans, appBaseURL string) *Service {
	return &Service{db: db, tx: tx, repo: repo, plans: plans, appBaseURL: appBaseURL}
}

// WithNotifications подключает уведомления кабинета: передача владения гасит
// поводы о квоте, адресованные прежнему владельцу.
func (s *Service) WithNotifications(n Notifications) *Service {
	s.notes = n
	return s
}

// WithFiles подключает модуль файлов ответов (тот же приём, что WithFiles у
// forms и submissions): без него удаление пространства оставило бы файлы его
// форм в бакете навсегда.
func (s *Service) WithFiles(f Files) *Service {
	s.files = f
	return s
}

// ListForUser возвращает пространства пользователя (личное — первым: оно старше
// любого другого, а запрос сортирует по created_at) вместе с признаком заморозки.
//
// ЗАМОРОЗКА СЧИТАЕТСЯ ЗДЕСЬ, А НЕ ВЫЗОВОМ checkFrozen НА КАЖДУЮ СТРОКУ. Список
// читается на каждом экране кабинета (его держит сайдбар), и построчная проверка
// стоила бы N+1 ради вывески. Лимиты спрашиваются ПО ВЛАДЕЛЬЦАМ, а их в списке
// обычно один-два, а не по пространствам; у человека с одним личным пространством
// не уходит ни одного лишнего запроса — обе ветки правила отсекаются без обращения
// к тарифу.
//
// ⚠ ОТКАЗ ТАРИФА НЕ РОНЯЕТ СПИСОК. Заморозка — вывеска: без неё кабинет показывает
// пространства как обычные, а настоящий запрет всё равно стоит на каждой операции
// (Can → checkFrozen). Уронить единственный запрос, на котором держится вся
// навигация, ради пометки — обмен не в ту сторону.
func (s *Service) ListForUser(ctx context.Context, userID uuid.UUID) ([]Workspace, error) {
	rows, err := s.repo.ListByUser(ctx, s.db, userID)
	if err != nil {
		return nil, err
	}
	// Лимит пространств у одного владельца один на все его пространства —
	// спрашиваем по разу на владельца.
	seen := make(map[uuid.UUID]*int64, 2)
	out := make([]Workspace, len(rows))
	for i, r := range rows {
		w := r.Workspace
		w.Frozen = s.frozenForList(ctx, r, seen)
		out[i] = w
	}
	return out, nil
}

// frozenForList — то же правило, что у checkFrozen, но для строки списка и без
// ошибок наружу (см. оговорку выше). Порядок веток обязан совпадать с checkFrozen:
// лишние пространства, затем лишние участники. Совпадение проверяется тестом —
// разъехавшись, они дадут худшее из состояний: кабинет показывает пространство
// рабочим, а первое же действие отвечает 402.
func (s *Service) frozenForList(ctx context.Context, r WorkspaceAccess, seen map[uuid.UUID]*int64) bool {
	if !r.IsPersonal {
		limit, ok := seen[r.OwnerID]
		if !ok {
			d, err := s.plans.CheckAccount(ctx, r.OwnerID, entitlements.Workspaces)
			if err != nil {
				return false
			}
			limit = d.Limit
			seen[r.OwnerID] = limit
		}
		if overWorkspaceLimit(r.IsPersonal, r.TeamRank, limit) {
			return true
		}
	}
	// Владелец всегда первый и потому не мёрзнет НИКОГДА — на этом же экономится
	// запрос: у самого частого случая второй поездки в БД не будет.
	if r.MemberRank <= 1 {
		return false
	}
	d, err := s.plans.CheckWorkspace(ctx, r.ID, entitlements.MembersPerWorkspace)
	if err != nil {
		return false
	}
	return overMemberLimit(r.MemberRank, d.Limit)
}

// Create заводит пространство и делает создателя его владельцем.
//
// Порядок обязателен: сначала гейт тарифа, потом запись. Лимит считает
// пространства, которыми аккаунт ВЛАДЕЕТ, — членство в чужих не расходует
// его место, иначе владелец Pro не смог бы позвать никого с Free.
//
// Подписка здесь НЕ создаётся: субъект тарифа — аккаунт, и она у него уже есть
// с регистрации (0016). Пространство работает по плану своего владельца.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, name string) (Workspace, error) {
	name, err := validateName(name)
	if err != nil {
		return Workspace{}, err
	}

	d, err := s.plans.CheckAccount(ctx, userID, entitlements.Workspaces)
	if err != nil {
		return Workspace{}, err
	}
	if !d.Allowed {
		return Workspace{}, domain.ErrPlanRequired
	}

	// Пространство и его владелец — одной транзакцией: пространство без
	// владельца не имеет плана, то есть неотличимо от осиротевшего (TD-53), и
	// его не видно ни в одном списке — то есть создать его молча значит создать
	// мусор.
	id := domain.NewID()
	// Slug генерирует приложение, а не БД: тот же nanoid, что у формы, и та же
	// страховка от коллизии — UNIQUE на колонке (60 бит делают её астрономически
	// редкой, но повтор обязан стать ошибкой вставки, а не тихим дублем).
	slug := domain.NewSlug()
	var created Workspace
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		w, e := s.repo.Create(ctx, tx, id, slug, name)
		if e != nil {
			return e
		}
		created = w
		return s.repo.AddOwner(ctx, tx, id, userID)
	})
	if err != nil {
		return Workspace{}, err
	}
	return created, nil
}

// Rename меняет название пространства. Проверка права — первой строкой
// (инвариант безопасности 1): id из URL доказательством доступа не является, а
// вывеску правит тот, кому это позволяет действие, а не тот, кто знает адрес.
//
// Валидация имени та же, что у создания, и намеренно вызывается общим кодом:
// разъехавшись, две проверки дадут пространство, которое нельзя завести, но
// можно получить переименованием.
func (s *Service) Rename(ctx context.Context, userID, workspaceID uuid.UUID, name string) (Workspace, error) {
	if err := s.Can(ctx, workspaceID, userID, domain.ActionWorkspaceManage); err != nil {
		return Workspace{}, err
	}
	name, err := validateName(name)
	if err != nil {
		return Workspace{}, err
	}
	return s.repo.Rename(ctx, s.db, workspaceID, name)
}

// validateName — общая проверка имени пространства для создания и
// переименования: непустое после обрезки пробелов и не длиннее MaxNameLen рун.
func validateName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("%w: имя пространства пустое", domain.ErrValidation)
	}
	if utf8.RuneCountInString(name) > MaxNameLen {
		return "", fmt.Errorf("%w: имя пространства длиннее %d символов", domain.ErrValidation, MaxNameLen)
	}
	return name, nil
}

// Delete сносит пространство со всем содержимым: формы, их версии, ответы,
// визиты, участники и приглашения уходят каскадом по FK.
//
// Порядок обязателен и не переставляется. Сначала право (инвариант безопасности
// 1), затем ФАЙЛЫ ОТВЕТОВ — до строк: каскад уносит записи о загрузках вместе с
// ключами объектов, и оставшееся в бакете не найдёт ни чистка сирот, ни человек.
// Сбой сноса останавливает удаление: лучше отказать владельцу (он повторит), чем
// оставить в хранилище персональные данные респондентов без единой записи о них.
//
// Личное не удаляется: человеку негде было бы жить, а его подписка и формы
// остались бы без места. Сторож стоит и в SQL (personal_user_id IS NULL), и
// здесь — ноль удалённых строк означает ровно этот случай.
func (s *Service) Delete(ctx context.Context, userID, workspaceID uuid.UUID) error {
	if err := s.Can(ctx, workspaceID, userID, domain.ActionWorkspaceDelete); err != nil {
		return err
	}
	if s.files != nil {
		if err := s.files.RemoveByWorkspace(ctx, workspaceID); err != nil {
			return err
		}
	}
	n, err := s.repo.Delete(ctx, s.db, workspaceID)
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%w: личное пространство не удаляется", domain.ErrValidation)
	}
	return nil
}
