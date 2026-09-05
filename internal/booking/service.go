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
	BookingsInRange(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from, to time.Time) ([]Booking, error)
	// CancelBooking возвращает номер редакции отменённой строки; pgx.ErrNoRows —
	// «нет такой записи или уже отменена».
	CancelBooking(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID) (int, error)
	// BookingForCancel — карточка записи: письму об отмене нужны время и ответ.
	BookingForCancel(ctx context.Context, db postgres.DBTX, id uuid.UUID) (BookingCard, error)
	// Перенос записи: та же тройка «лок, счёт, правка», что у публичного холда.
	BookingForMove(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID) (BookingMove, error)
	LockSlot(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time) error
	TakenAtExcept(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time, bookingID uuid.UUID) (int, error)
	MoveBooking(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID, startsAt time.Time) (int, error)
}

var _ Store = Repo{}

// UpcomingLimit — сколько ближайших записей отдаётся экрану расписания. Список,
// а не таблица с листанием: он отвечает на вопрос «кто придёт на неделе».
const UpcomingLimit = 100

// CalendarWindowMaxDays — потолок окна полотна. Полотно листается неделями, и
// запрос шире двух месяцев означает не «показать», а «выгрузить»: границу ставим
// здесь, а не полагаемся на то, что клиент попросит по-божески.
const CalendarWindowMaxDays = 62

// BlocksHorizonDays — на сколько дней вперёд экран показывает блокировки. Отпуск
// ставят за месяцы, но список на годы вперёд перестаёт читаться.
const BlocksHorizonDays = 365

// Service — расписания записи: кабинетная половина фазы 27.
type Service struct {
	db postgres.DBTX
	// tx — транзакция переноса записи: лок, счёт мест и правка обязаны быть одной,
	// иначе перенос обходит защиту от двойной записи с той стороны, с которой её
	// никто не сторожит.
	tx     TxRunner
	repo   Store
	access Access
	plans  Plans
	// notifier — письма кабинета о чужой встрече: отмена и перенос.
	notifier BookingNotifier
	// now — часы сервиса. Инжектируются, потому что стоп-кран удаления и список
	// ближайших записей отвечают «начиная с сейчас», и в тестах это «сейчас»
	// должно быть управляемым.
	now func() time.Time
}

func NewService(db postgres.DBTX, tx TxRunner, repo Store, access Access, plans Plans) *Service {
	return &Service{db: db, tx: tx, repo: repo, access: access, plans: plans, now: time.Now}
}

// WithClock подменяет часы сервиса (тесты).
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

// WithNotifier подключает письма кабинета. Без него отмена и перенос молчаливы:
// место переезжает, а записавшийся об этом не узнаёт.
func (s *Service) WithNotifier(n BookingNotifier) *Service {
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

// Calendar — занятое время и записи, задевающие отрезок: два слоя полотна недели,
// которые лежат в базе. Третий и четвёртый (часы приёма и исключения) не считаются
// сервером вовсе — они целиком лежат в правиле расписания, которое экран уже держит.
//
// Ручка ранжированная, а не «от сейчас», потому что полотно листается и назад:
// прошлая неделя, показанная пустой, была бы враньём, а не экономией.
func (s *Service) Calendar(ctx context.Context, userID, scheduleID uuid.UUID, from, to time.Time) (Calendar, error) {
	if _, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormRead); err != nil {
		return Calendar{}, err
	}
	if from.IsZero() || to.IsZero() {
		return Calendar{}, fmt.Errorf("%w: нужны обе границы отрезка", domain.ErrValidation)
	}
	if !from.Before(to) {
		return Calendar{}, fmt.Errorf("%w: from не раньше to", domain.ErrValidation)
	}
	if to.Sub(from) > CalendarWindowMaxDays*24*time.Hour {
		return Calendar{}, fmt.Errorf("%w: отрезок длиннее %d дней", domain.ErrValidation, CalendarWindowMaxDays)
	}
	blocks, err := s.repo.BlocksInRange(ctx, s.db, scheduleID, from, to)
	if err != nil {
		return Calendar{}, err
	}
	bookings, err := s.repo.BookingsInRange(ctx, s.db, scheduleID, from, to)
	if err != nil {
		return Calendar{}, err
	}
	return Calendar{Blocks: blocks, Bookings: bookings}, nil
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
// Записавшемуся уходит письмо об отмене — то же, что и при отмене по ссылке, и с
// тем же гашением события календаря.
func (s *Service) CancelBooking(ctx context.Context, userID, scheduleID, bookingID uuid.UUID) error {
	if _, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormWrite); err != nil {
		return err
	}
	// Карточка читается ДО отмены: письму нужны время, длительность и ответ, а после
	// отмены статус уже другой, и отличить «отменил я» от «было отменено» нечем.
	card, cardErr := s.repo.BookingForCancel(ctx, s.db, bookingID)
	// НОМЕР РЕДАКЦИИ БЕРЁТСЯ У САМОЙ ОТМЕНЫ, а не из карточки, прочитанной строкой
	// выше: между чтением и этим UPDATE запись могли перенести, и номер из карточки
	// оказался бы не больше уже выданного — такую отмену клиент вправе отбросить как
	// устаревшую, и встреча осталась бы в чужом календаре навсегда.
	revision, err := s.repo.CancelBooking(ctx, s.db, bookingID, scheduleID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// «Нет такой записи» и «уже отменена» для клиента одно: в обоих случаях
			// делать больше нечего, а второй ответ раскрывал бы существование чужих
			// записей перебором.
			return domain.ErrNotFound
		}
		return err
	}
	if cardErr == nil && s.notifier != nil && card.SubmissionID != nil {
		// Best-effort, как и всё остальное вокруг отмены: сбой почты уже
		// освобождённое место не занимает.
		s.notifier.NotifyBookingCanceled(ctx, card.FormID, *card.SubmissionID, bookingID,
			card.StartsAt, card.DurationMinutes, revision+1, card.Timezone)
	}
	return nil
}

// MoveBooking — перенос записи автором на другое время.
//
// ОГРАНИЧЕНИЙ РОВНО ДВА (ADR §10, решение владельца 2026-09-05): вместимость слота и
// шаг сетки. Часы приёма, упреждение и горизонт здесь не спрашиваются — автор не
// респондент, и, договорившись по телефону, он вправе поставить человека и до
// открытия приёма. А вот шаг сетки обязателен: занятость считается по РАВЕНСТВУ
// точки старта, и съехавшая на семь минут бронь не встретилась бы в счёте ни с чем.
//
// Гонка закрывается там же и тем же, что у публичного холда: advisory-lock по паре
// «расписание + начало слота», счёт под локом, правка одной транзакцией.
func (s *Service) MoveBooking(
	ctx context.Context, userID, scheduleID, bookingID uuid.UUID, startsAt time.Time,
) error {
	sch, err := s.forAction(ctx, userID, scheduleID, domain.ActionFormWrite)
	if err != nil {
		return err
	}
	if s.tx == nil {
		return fmt.Errorf("booking: перенос без транзакции")
	}
	if !domain.MoveAligned(sch.Schedule, startsAt) {
		return fmt.Errorf("%w: это время не совпадает с шагом сетки расписания", domain.ErrValidation)
	}
	// Карточка читается ДО правки: письму нужны длительность и ответ, а после неё
	// прежнее время уже не спросить.
	card, err := s.repo.BookingForMove(ctx, s.db, bookingID, scheduleID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Отменённая и чужая неотличимы от несуществующей — тем же доводом, что
			// и у отмены: второй ответ раскрывал бы чужие записи перебором.
			return domain.ErrNotFound
		}
		return err
	}
	if card.StartsAt.Equal(startsAt) {
		return fmt.Errorf("%w: запись уже стоит на это время", domain.ErrValidation)
	}

	// Номер редакции, с которым уедет приглашение. Присваивается ВНУТРИ транзакции
	// тем же утверждением, что двигает строку: прочитанный заранее одинаков у двух
	// одновременных переносов одной брони в разные слоты — локи у них разные, ждать
	// друг друга им нечем, и оба письма уехали бы с общим SEQUENCE.
	revision := 0
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.repo.LockSlot(ctx, tx, scheduleID, startsAt); err != nil {
			return err
		}
		// Счёт ПОД ЛОКОМ и без самой переносимой брони: она уже лежит в таблице, и
		// без исключения перенос внутри одного слота отказал бы сам себе.
		taken, err := s.repo.TakenAtExcept(ctx, tx, scheduleID, startsAt, bookingID)
		if err != nil {
			return err
		}
		if taken+card.Seats > sch.Capacity {
			return errSlotTaken(sch.Capacity - taken)
		}
		rev, err := s.repo.MoveBooking(ctx, tx, bookingID, scheduleID, startsAt)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Между чтением карточки и правкой запись отменили.
				return domain.ErrNotFound
			}
			return err
		}
		revision = rev
		return nil
	})
	if err != nil {
		return err
	}

	if s.notifier != nil && card.SubmissionID != nil {
		// Best-effort, как и у отмены: сбой почты уже состоявшийся перенос не
		// откатывает. У записи с удалённым ответом адреса нет вовсе — экран
		// предупреждает об этом автора до подтверждения.
		s.notifier.NotifyBookingRescheduled(ctx, card.FormID, *card.SubmissionID, bookingID,
			card.StartsAt, startsAt, card.DurationMinutes, revision, sch.Timezone)
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
