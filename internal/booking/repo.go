package booking

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Repo — доступ к данным расписаний поверх sqlc.
type Repo struct{}

// Schedule — строка schedules в том виде, в каком её знает кабинет: правило и
// параметры нарезки (domain.Schedule, он же вход расчёта свободного времени) плюс
// то, что к расчёту отношения не имеет.
//
// Встроен, а не скопирован полями: копия разъехалась бы с доменом при первом же
// новом параметре, а сверять их было бы нечем.
type Schedule struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	domain.Schedule
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Block — ручная блокировка времени.
type Block struct {
	ID         uuid.UUID
	ScheduleID uuid.UUID
	StartsAt   time.Time
	EndsAt     time.Time
	Note       string
	CreatedAt  time.Time
}

// Booking — запись в расписании, как её видит автор. Имени и контактов
// записавшегося здесь нет: они живут в ответе формы и подчиняются его правилам
// (152-ФЗ, спека §13). Экран показывает время и форму, из которой запись пришла.
type Booking struct {
	ID              uuid.UUID
	FormID          uuid.UUID
	FormTitle       string
	SubmissionID    *uuid.UUID
	StartsAt        time.Time
	DurationMinutes int
	Seats           int
	Status          string
	CreatedAt       time.Time
}

func (Repo) CreateSchedule(ctx context.Context, db postgres.DBTX, s Schedule) (Schedule, error) {
	raw, err := json.Marshal(s.Availability)
	if err != nil {
		return Schedule{}, fmt.Errorf("encode availability: %w", err)
	}
	row, err := postgres.New(db).CreateSchedule(ctx, postgres.CreateScheduleParams{
		ID:                 s.ID,
		WorkspaceID:        s.WorkspaceID,
		Name:               s.Name,
		Timezone:           s.Timezone,
		Availability:       raw,
		SlotMinutes:        int32(s.SlotMinutes),
		BufferMinutes:      int32(s.BufferMinutes),
		HorizonDays:        int32(s.HorizonDays),
		LeadMinutes:        int32(s.LeadMinutes),
		Capacity:           int32(s.Capacity),
		MaxSeatsPerBooking: int32(s.MaxSeatsPerBooking),
		ShowRemaining:      s.ShowRemaining,
	})
	if err != nil {
		return Schedule{}, fmt.Errorf("create schedule in workspace %s: %w", s.WorkspaceID, err)
	}
	return scheduleFrom(postgres.Schedule(row))
}

func (Repo) ListSchedules(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]Schedule, error) {
	rows, err := postgres.New(db).ListSchedules(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list schedules of workspace %s: %w", workspaceID, err)
	}
	out := make([]Schedule, 0, len(rows))
	for _, r := range rows {
		s, err := scheduleFrom(postgres.Schedule(r))
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

// GetSchedule — расписание по id. pgx.ErrNoRows пробрасывается: «нет такого»
// разбирает сервис, он же решает, чем это обернётся для клиента.
func (Repo) GetSchedule(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Schedule, error) {
	row, err := postgres.New(db).GetSchedule(ctx, id)
	if err != nil {
		return Schedule{}, fmt.Errorf("get schedule %s: %w", id, err)
	}
	return scheduleFrom(postgres.Schedule(row))
}

func (Repo) UpdateSchedule(ctx context.Context, db postgres.DBTX, s Schedule) (Schedule, error) {
	raw, err := json.Marshal(s.Availability)
	if err != nil {
		return Schedule{}, fmt.Errorf("encode availability: %w", err)
	}
	row, err := postgres.New(db).UpdateSchedule(ctx, postgres.UpdateScheduleParams{
		ID:                 s.ID,
		Name:               s.Name,
		Timezone:           s.Timezone,
		Availability:       raw,
		SlotMinutes:        int32(s.SlotMinutes),
		BufferMinutes:      int32(s.BufferMinutes),
		HorizonDays:        int32(s.HorizonDays),
		LeadMinutes:        int32(s.LeadMinutes),
		Capacity:           int32(s.Capacity),
		MaxSeatsPerBooking: int32(s.MaxSeatsPerBooking),
		ShowRemaining:      s.ShowRemaining,
	})
	if err != nil {
		return Schedule{}, fmt.Errorf("update schedule %s: %w", s.ID, err)
	}
	return scheduleFrom(postgres.Schedule(row))
}

func (Repo) DeleteSchedule(ctx context.Context, db postgres.DBTX, id uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteSchedule(ctx, id)
	if err != nil {
		return 0, fmt.Errorf("delete schedule %s: %w", id, err)
	}
	return n, nil
}

// CountFutureBookings — сколько подтверждённых записей у расписания начиная с
// момента from. Стоп-кран удаления спрашивает именно это.
func (Repo) CountFutureBookings(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from time.Time) (int64, error) {
	n, err := postgres.New(db).CountFutureBookings(ctx, postgres.CountFutureBookingsParams{
		ScheduleID: scheduleID,
		StartsAt:   pgtype.Timestamptz{Time: from, Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("count future bookings of schedule %s: %w", scheduleID, err)
	}
	return n, nil
}

// CountFormsBySchedule — сколько форм ссылается на расписание.
func (Repo) CountFormsBySchedule(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).CountSchedulesByForm(ctx, pgtype.UUID{Bytes: scheduleID, Valid: true})
	if err != nil {
		return 0, fmt.Errorf("count forms of schedule %s: %w", scheduleID, err)
	}
	return n, nil
}

func (Repo) CreateBlock(ctx context.Context, db postgres.DBTX, b Block) (Block, error) {
	row, err := postgres.New(db).CreateScheduleBlock(ctx, postgres.CreateScheduleBlockParams{
		ID:         b.ID,
		ScheduleID: b.ScheduleID,
		StartsAt:   pgtype.Timestamptz{Time: b.StartsAt, Valid: true},
		EndsAt:     pgtype.Timestamptz{Time: b.EndsAt, Valid: true},
		Note:       b.Note,
	})
	if err != nil {
		return Block{}, fmt.Errorf("create block in schedule %s: %w", b.ScheduleID, err)
	}
	return Block{
		ID:         row.ID,
		ScheduleID: row.ScheduleID,
		StartsAt:   row.StartsAt.Time,
		EndsAt:     row.EndsAt.Time,
		Note:       row.Note,
		CreatedAt:  row.CreatedAt.Time,
	}, nil
}

func (Repo) BlocksInRange(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from, to time.Time) ([]Block, error) {
	rows, err := postgres.New(db).BlocksInRange(ctx, postgres.BlocksInRangeParams{
		ScheduleID: scheduleID,
		EndsAt:     pgtype.Timestamptz{Time: from, Valid: true},
		StartsAt:   pgtype.Timestamptz{Time: to, Valid: true},
	})
	if err != nil {
		return nil, fmt.Errorf("blocks of schedule %s: %w", scheduleID, err)
	}
	out := make([]Block, 0, len(rows))
	for _, r := range rows {
		out = append(out, Block{
			ID:         r.ID,
			ScheduleID: r.ScheduleID,
			StartsAt:   r.StartsAt.Time,
			EndsAt:     r.EndsAt.Time,
			Note:       r.Note,
			CreatedAt:  r.CreatedAt.Time,
		})
	}
	return out, nil
}

func (Repo) DeleteBlock(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteScheduleBlock(ctx, postgres.DeleteScheduleBlockParams{
		ID:         id,
		ScheduleID: scheduleID,
	})
	if err != nil {
		return 0, fmt.Errorf("delete block %s: %w", id, err)
	}
	return n, nil
}

func (Repo) UpcomingBookings(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from time.Time, limit int32) ([]Booking, error) {
	rows, err := postgres.New(db).ListUpcomingBookings(ctx, postgres.ListUpcomingBookingsParams{
		ScheduleID: scheduleID,
		StartsAt:   pgtype.Timestamptz{Time: from, Valid: true},
		Limit:      limit,
	})
	if err != nil {
		return nil, fmt.Errorf("upcoming bookings of schedule %s: %w", scheduleID, err)
	}
	out := make([]Booking, 0, len(rows))
	for _, r := range rows {
		b := Booking{
			ID:              r.ID,
			FormID:          r.FormID,
			FormTitle:       r.FormTitle,
			StartsAt:        r.StartsAt.Time,
			DurationMinutes: int(r.DurationMinutes),
			Seats:           int(r.Seats),
			Status:          r.Status,
			CreatedAt:       r.CreatedAt.Time,
		}
		if r.SubmissionID.Valid {
			id := uuid.UUID(r.SubmissionID.Bytes)
			b.SubmissionID = &id
		}
		out = append(out, b)
	}
	return out, nil
}

func (Repo) CancelBooking(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).CancelBookingByAuthor(ctx, postgres.CancelBookingByAuthorParams{
		ID:         id,
		ScheduleID: scheduleID,
	})
	if err != nil {
		return 0, fmt.Errorf("cancel booking %s: %w", id, err)
	}
	return n, nil
}

// scheduleFrom — строка БД в доменное расписание. Документ правила разбирается
// здесь: дальше по коду он живёт типами, а не сырым JSON.
func scheduleFrom(row postgres.Schedule) (Schedule, error) {
	var a domain.Availability
	if err := json.Unmarshal(row.Availability, &a); err != nil {
		return Schedule{}, fmt.Errorf("decode availability of schedule %s: %w", row.ID, err)
	}
	return Schedule{
		ID:          row.ID,
		WorkspaceID: row.WorkspaceID,
		Schedule: domain.Schedule{
			Name:               row.Name,
			Timezone:           row.Timezone,
			Availability:       a,
			SlotMinutes:        int(row.SlotMinutes),
			BufferMinutes:      int(row.BufferMinutes),
			HorizonDays:        int(row.HorizonDays),
			LeadMinutes:        int(row.LeadMinutes),
			Capacity:           int(row.Capacity),
			MaxSeatsPerBooking: int(row.MaxSeatsPerBooking),
			ShowRemaining:      row.ShowRemaining,
		},
		CreatedAt: row.CreatedAt.Time,
		UpdatedAt: row.UpdatedAt.Time,
	}, nil
}

// TakenSeats — занятые места на отрезке: ключ — Unix-секунда старта (domain.Taken).
// Свой холд спрашивающего не считается: он его и держит.
func (Repo) TakenSeats(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from, to time.Time, clientID uuid.UUID) (domain.Taken, error) {
	rows, err := postgres.New(db).TakenSeatsInRange(ctx, postgres.TakenSeatsInRangeParams{
		ScheduleID: scheduleID,
		StartsAt:   pgtype.Timestamptz{Time: from, Valid: true},
		StartsAt_2: pgtype.Timestamptz{Time: to, Valid: true},
		ClientID:   clientID,
	})
	if err != nil {
		return nil, fmt.Errorf("taken seats of schedule %s: %w", scheduleID, err)
	}
	out := make(domain.Taken, len(rows))
	for _, r := range rows {
		out[r.StartsAt.Time.Unix()] = int(r.Seats)
	}
	return out, nil
}

// LockSlot берёт транзакционный advisory-lock по паре «расписание + начало слота».
// Зовётся ТОЛЬКО внутри транзакции: вне её лок снимается сразу же и не значит ничего.
func (Repo) LockSlot(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time) error {
	key := scheduleID.String() + "@" + startsAt.UTC().Format(time.RFC3339)
	if err := postgres.New(db).LockSlot(ctx, key); err != nil {
		return fmt.Errorf("lock slot %s: %w", key, err)
	}
	return nil
}

// TakenAt — занятые места в одной точке (счёт под локом).
func (Repo) TakenAt(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time, clientID uuid.UUID) (int, error) {
	n, err := postgres.New(db).TakenSeatsAt(ctx, postgres.TakenSeatsAtParams{
		ScheduleID: scheduleID,
		StartsAt:   pgtype.Timestamptz{Time: startsAt, Valid: true},
		ClientID:   clientID,
	})
	if err != nil {
		return 0, fmt.Errorf("taken seats at %s: %w", startsAt, err)
	}
	return int(n), nil
}

// Hold придерживает время. Второе значение — false, если строка клиента уже стала
// подтверждённой записью: переносить состоявшуюся встречу нельзя.
func (Repo) Hold(ctx context.Context, db postgres.DBTX, h NewHold) (uuid.UUID, bool, error) {
	id, err := postgres.New(db).HoldSlot(ctx, postgres.HoldSlotParams{
		ID:              h.ID,
		ScheduleID:      h.ScheduleID,
		FormID:          h.FormID,
		StartsAt:        pgtype.Timestamptz{Time: h.StartsAt, Valid: true},
		DurationMinutes: int32(h.DurationMinutes),
		Seats:           int32(h.Seats),
		HoldExpiresAt:   pgtype.Timestamptz{Time: h.ExpiresAt, Valid: true},
		ClientID:        h.ClientID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// Ноль строк даёт оговорка DO UPDATE ... WHERE bookings.status = 'held':
		// у клиента уже есть ПОДТВЕРЖДЁННАЯ запись в этой форме.
		return uuid.Nil, false, nil
	}
	if err != nil {
		return uuid.Nil, false, fmt.Errorf("hold slot: %w", err)
	}
	return id, true, nil
}

// NewHold — что нужно, чтобы придержать время.
type NewHold struct {
	ID              uuid.UUID
	ScheduleID      uuid.UUID
	FormID          uuid.UUID
	ClientID        uuid.UUID
	StartsAt        time.Time
	DurationMinutes int
	Seats           int
	ExpiresAt       time.Time
}
