package booking

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Access — право на действие в пространстве. Реализация — *workspaces.Service.
//
// Своих действий у расписаний НЕТ, и это решение, а не экономия: спека §9 говорит
// «как у форм — смотреть может тот, кто видит формы; править владелец и редактор»,
// а три новых действия с теми же ячейками матрицы означали бы право, которое никто
// не различает (internal/domain/access.go: действия без потребителя не заводятся).
// Понадобится развести — это правка матрицы, а не сервиса.
type Access interface {
	Can(ctx context.Context, workspaceID, userID uuid.UUID, action domain.Action) error
}

// Plans — единственная точка «можно ли» (ADR §10). Реализация — *entitlements.Service.
type Plans interface {
	CheckWorkspace(ctx context.Context, workspaceID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
}

// Store — доступ к данным, объявленный потребителем. Реализация — Repo.
type Store interface {
	CreateSchedule(ctx context.Context, db postgres.DBTX, s Schedule) (Schedule, error)
	ListSchedules(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]Schedule, error)
	GetSchedule(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Schedule, error)
	UpdateSchedule(ctx context.Context, db postgres.DBTX, s Schedule) (Schedule, error)
	DeleteSchedule(ctx context.Context, db postgres.DBTX, id uuid.UUID) (int64, error)
	CountFutureBookings(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from time.Time) (int64, error)
	CountFormsBySchedule(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID) (int64, error)
	CreateBlock(ctx context.Context, db postgres.DBTX, b Block) (Block, error)
	BlocksInRange(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from, to time.Time) ([]Block, error)
	DeleteBlock(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID) (int64, error)
	UpcomingBookings(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from time.Time, limit int32) ([]Booking, error)
	CancelBooking(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID) (int64, error)
	// BookingForCancel — карточка записи: письму об отмене нужны время и ответ.
	BookingForCancel(ctx context.Context, db postgres.DBTX, id uuid.UUID) (BookingCard, error)
}

var _ Store = Repo{}

// UpcomingLimit — сколько ближайших записей отдаётся экрану расписания. Список,
// а не таблица с листанием: он отвечает на вопрос «кто придёт на неделе».
const UpcomingLimit = 100

// BlocksHorizonDays — на сколько дней вперёд экран показывает блокировки. Отпуск
// ставят за месяцы, но список на годы вперёд перестаёт читаться.
const BlocksHorizonDays = 365

// Service — расписания записи: кабинетная половина фазы 27.
type Service struct {
	db     postgres.DBTX
	repo   Store
	access Access
	plans  Plans
	// notifier — письмо об отмене записи (фаза 27, слайс I).
	notifier CancelNotifier
	// now — часы сервиса. Инжектируются, потому что стоп-кран удаления и список
	// ближайших записей отвечают «начиная с сейчас», и в тестах это «сейчас»
	// должно быть управляемым.
	now func() time.Time
}

func NewService(db postgres.DBTX, repo Store, access Access, plans Plans) *Service {
	return &Service{db: db, repo: repo, access: access, plans: plans, now: time.Now}
}

// WithClock подменяет часы сервиса (тесты).
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

// WithNotifier подключает письмо об отмене записи из кабинета. Без него отмена
// молчалива: место возвращается, а записавшийся об этом не узнаёт.
func (s *Service) WithNotifier(n CancelNotifier) *Service {
	s.notifier = n
	return s
}

// ScheduleInput — то, что автор задаёт в экране расписания. Правится всё разом:
// экран сохраняет форму настроек одним куском.
type ScheduleInput struct {
	Name               string
	Timezone           string
	Availability       domain.Availability
	SlotMinutes        int
	BufferMinutes      int
	HorizonDays        int
	LeadMinutes        int
	Capacity           int
	MaxSeatsPerBooking int
	ShowRemaining      bool
}

func (in ScheduleInput) domainSchedule() domain.Schedule {
	return domain.Schedule{
		Name:               in.Name,
		Timezone:           in.Timezone,
		Availability:       in.Availability,
		SlotMinutes:        in.SlotMinutes,
		BufferMinutes:      in.BufferMinutes,
		HorizonDays:        in.HorizonDays,
		LeadMinutes:        in.LeadMinutes,
		Capacity:           in.Capacity,
		MaxSeatsPerBooking: in.MaxSeatsPerBooking,
		ShowRemaining:      in.ShowRemaining,
	}
}

// List — расписания пространства.
func (s *Service) List(ctx context.Context, userID, workspaceID uuid.UUID) ([]Schedule, error) {
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionFormRead); err != nil {
		return nil, err
	}
	return s.repo.ListSchedules(ctx, s.db, workspaceID)
}

// Create заводит расписание. Квота спрашивается ДО вставки: ключ открыт на всех
// планах сегодня, но включиться он должен без правки этого метода.
func (s *Service) Create(ctx context.Context, userID, workspaceID uuid.UUID, in ScheduleInput) (Schedule, error) {
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionFormWrite); err != nil {
		return Schedule{}, err
	}
	if err := domain.ValidateSchedule(in.domainSchedule()); err != nil {
		return Schedule{}, err
	}
	d, err := s.plans.CheckWorkspace(ctx, workspaceID, entitlements.BookingSchedulesMax)
	if err != nil {
		return Schedule{}, err
	}
	if !d.Allowed {
		// Текст обязателен: код конверта у всех 402 один, и без него кабинет
		// печатал бы про тариф на любом отказе.
		return Schedule{}, fmt.Errorf("%w: на этом тарифе больше расписаний завести нельзя",
			domain.ErrPlanRequired)
	}
	return s.repo.CreateSchedule(ctx, s.db, Schedule{
		ID:          domain.NewID(),
		WorkspaceID: workspaceID,
		Schedule:    in.domainSchedule(),
	})
}

// Get — одно расписание.
func (s *Service) Get(ctx context.Context, userID, scheduleID uuid.UUID) (Schedule, error) {
	return s.forAction(ctx, userID, scheduleID, domain.ActionFormRead)
}

// Update правит расписание целиком.
func (s *Service) Update(ctx context.Context, userID, scheduleID uuid.UUID, in ScheduleInput) (Schedule, error) {
	cur, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormWrite)
	if err != nil {
		return Schedule{}, err
	}
	if err := domain.ValidateSchedule(in.domainSchedule()); err != nil {
		return Schedule{}, err
	}
	cur.Schedule = in.domainSchedule()
	return s.repo.UpdateSchedule(ctx, s.db, cur)
}

// Delete удаляет расписание — если удалять есть что и никого этим не подводит.
//
// СТОП-КРАН (ADR §10): живая будущая запись отказывает 409 с числом. Молча снести
// чужие договорённости нельзя, а массовая отмена — отдельное осознанное действие с
// письмами всем записавшимся. Прошлые записи не держат ничего: они уже состоялись,
// и уборка старого расписания не должна упираться в прошлогоднюю бронь.
func (s *Service) Delete(ctx context.Context, userID, scheduleID uuid.UUID) error {
	if _, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormDelete); err != nil {
		return err
	}
	future, err := s.repo.CountFutureBookings(ctx, s.db, scheduleID, s.now())
	if err != nil {
		return err
	}
	if future > 0 {
		return fmt.Errorf("%w: у расписания %s — сначала отмените их",
			domain.ErrConflict, domain.Plural(future, "будущая запись", "будущие записи", "будущих записей"))
	}
	// Форма со ссылкой на расписание — второй отказ, и он обязан быть отдельным:
	// внешний ключ отвергнет удаление ошибкой БД, а она автору ничего не объясняет.
	forms, err := s.repo.CountFormsBySchedule(ctx, s.db, scheduleID)
	if err != nil {
		return err
	}
	if forms > 0 {
		return fmt.Errorf("%w: на расписание ссылается %s — сначала уберите запись из них",
			domain.ErrConflict, domain.Plural(forms, "форма", "формы", "форм"))
	}
	n, err := s.repo.DeleteSchedule(ctx, s.db, scheduleID)
	if err != nil {
		return err
	}
	if n == 0 {
		// Удалили между проверкой и удалением — для клиента расписания нет.
		return domain.ErrNotFound
	}
	return nil
}

// Blocks — ручные блокировки от текущего момента и вперёд.
func (s *Service) Blocks(ctx context.Context, userID, scheduleID uuid.UUID) ([]Block, error) {
	if _, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormRead); err != nil {
		return nil, err
	}
	now := s.now()
	return s.repo.BlocksInRange(ctx, s.db, scheduleID, now, now.AddDate(0, 0, BlocksHorizonDays))
}

// AddBlock закрывает время руками.
func (s *Service) AddBlock(ctx context.Context, userID, scheduleID uuid.UUID, startsAt, endsAt time.Time, note string) (Block, error) {
	if _, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormWrite); err != nil {
		return Block{}, err
	}
	if err := domain.ValidateScheduleBlock(startsAt, endsAt, note); err != nil {
		return Block{}, err
	}
	return s.repo.CreateBlock(ctx, s.db, Block{
		ID:         domain.NewID(),
		ScheduleID: scheduleID,
		StartsAt:   startsAt,
		EndsAt:     endsAt,
		Note:       note,
	})
}

// RemoveBlock снимает блокировку.
func (s *Service) RemoveBlock(ctx context.Context, userID, scheduleID, blockID uuid.UUID) error {
	if _, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormWrite); err != nil {
		return err
	}
	n, err := s.repo.DeleteBlock(ctx, s.db, blockID, scheduleID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// Upcoming — ближайшие записи расписания.
func (s *Service) Upcoming(ctx context.Context, userID, scheduleID uuid.UUID) ([]Booking, error) {
	if _, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormRead); err != nil {
		return nil, err
	}
	return s.repo.UpcomingBookings(ctx, s.db, scheduleID, s.now(), UpcomingLimit)
}

// CancelBooking отменяет запись из кабинета: место возвращается в оборот тем же
// утверждением, что меняет статус.
//
// Письмо записавшемуся здесь НЕ уходит: доставка приезжает слайсом I. До неё
// отмена из кабинета молчалива, и это записано, чтобы не считать её сделанной.
func (s *Service) CancelBooking(ctx context.Context, userID, scheduleID, bookingID uuid.UUID) error {
	if _, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormWrite); err != nil {
		return err
	}
	// Карточка читается ДО отмены: письму нужны время, длительность и ответ, а после
	// отмены статус уже другой, и отличить «отменил я» от «было отменено» нечем.
	card, cardErr := s.repo.BookingForCancel(ctx, s.db, bookingID)
	n, err := s.repo.CancelBooking(ctx, s.db, bookingID, scheduleID)
	if err != nil {
		return err
	}
	if n > 0 && cardErr == nil && s.notifier != nil && card.SubmissionID != nil {
		// Best-effort, как и всё остальное вокруг отмены: сбой почты уже
		// освобождённое место не занимает.
		s.notifier.NotifyBookingCanceled(ctx, card.FormID, *card.SubmissionID, bookingID,
			card.StartsAt, card.DurationMinutes, card.Timezone)
	}
	if n == 0 {
		// Ноль строк — это и «нет такой записи», и «уже отменена». Для клиента
		// различать их незачем: в обоих случаях действие делать больше нечего,
		// а второй ответ раскрывал бы существование чужих записей перебором.
		return domain.ErrNotFound
	}
	return nil
}

// forAction — расписание плюс охрана: право спрашивается по ПРОСТРАНСТВУ строки,
// а не по id из адреса (инвариант 1). Не участник получает 404 от Can, поэтому
// чужое расписание неотличимо от несуществующего.
func (s *Service) forAction(ctx context.Context, userID, scheduleID uuid.UUID, action domain.Action) (Schedule, error) {
	sch, err := s.repo.GetSchedule(ctx, s.db, scheduleID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Schedule{}, domain.ErrNotFound
		}
		return Schedule{}, err
	}
	if err := s.access.Can(ctx, sch.WorkspaceID, userID, action); err != nil {
		return Schedule{}, err
	}
	return sch, nil
}
