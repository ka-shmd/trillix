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
//
// ⚠ ВРЕМЕНА НАРУЖУ ОТДАЮТСЯ В UTC. pgx возвращает timestamptz в поясе сессии, и один и
// тот же момент выглядел бы в разных ответах API по-разному («…07:00:00Z» против
// «…10:00:00+03:00»). Читателей у этих полей несколько (кабинет, публичная выдача,
// страница отмены), и разъехаться их разбору нельзя.
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
	ID        uuid.UUID
	FormID    uuid.UUID
	FormTitle string
	// FormSlug — адрес формы в кабинете: карточка записи ведёт к ответу, из
	// которого запись пришла, а ответы адресуются слагом формы, не её id.
	FormSlug        string
	SubmissionID    *uuid.UUID
	StartsAt        time.Time
	DurationMinutes int
	Seats           int
	Status          string
	CreatedAt       time.Time
}

// Calendar — два слоя полотна недели, которые лежат в базе. Одним типом, потому
// что экран берёт их одним запросом: два отдельных обхода означали бы две картины
// занятости, снятые в разные моменты.
type Calendar struct {
	Blocks   []Block
	Bookings []Booking
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
		StartsAt:   row.StartsAt.Time.UTC(),
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
			StartsAt:   r.StartsAt.Time.UTC(),
			EndsAt:     r.EndsAt.Time.UTC(),
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
			FormSlug:        r.FormSlug,
			StartsAt:        r.StartsAt.Time.UTC(),
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

// BookingsInRange — подтверждённые записи, задевающие отрезок: полотну недели.
//
// Имена полей параметров сгенерированы по столбцу, а не по смыслу: StartsAt — это
// НАЧАЛО отрезка ($2, сравнивается с концом брони), StartsAt_2 — его КОНЕЦ ($3).
// Перепутать их местами компилятор не помешает, а выдача станет пустой.
func (Repo) BookingsInRange(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from, to time.Time) ([]Booking, error) {
	rows, err := postgres.New(db).BookingsInRange(ctx, postgres.BookingsInRangeParams{
		ScheduleID: scheduleID,
		StartsAt:   pgtype.Timestamptz{Time: from, Valid: true},
		StartsAt_2: pgtype.Timestamptz{Time: to, Valid: true},
	})
	if err != nil {
		return nil, fmt.Errorf("bookings of schedule %s in range: %w", scheduleID, err)
	}
	out := make([]Booking, 0, len(rows))
	for _, r := range rows {
		b := Booking{
			ID:              r.ID,
			FormID:          r.FormID,
			FormTitle:       r.FormTitle,
			FormSlug:        r.FormSlug,
			StartsAt:        r.StartsAt.Time.UTC(),
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

// CancelBooking отменяет запись из кабинета и возвращает НОМЕР РЕДАКЦИИ отменённой
// строки. pgx.ErrNoRows означает «нет такой записи или уже отменена» — вызывающий
// различает это сам.
func (Repo) CancelBooking(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID) (int, error) {
	rev, err := postgres.New(db).CancelBookingByAuthor(ctx, postgres.CancelBookingByAuthorParams{
		ID:         id,
		ScheduleID: scheduleID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}
		return 0, fmt.Errorf("cancel booking %s: %w", id, err)
	}
	return int(rev), nil
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

// BookingForConfirm — бронь для подтверждения приёмом ответа. Форма и клиент в
// условии не украшение: id брони приезжает в ответе респондента, то есть недоверенным
// вводом.
func (Repo) BookingForConfirm(ctx context.Context, db postgres.DBTX, bookingID, formID, clientID uuid.UUID) (BookingRow, error) {
	row, err := postgres.New(db).GetBookingForConfirm(ctx, postgres.GetBookingForConfirmParams{
		ID:       bookingID,
		FormID:   formID,
		ClientID: clientID,
	})
	if err != nil {
		// pgx.ErrNoRows пробрасывается как есть: «нет такой брони» разбирает
		// вызывающий — для отвечающего это не ошибка запроса, а состояние.
		return BookingRow{}, err
	}
	out := BookingRow{
		ID:              row.ID,
		ScheduleID:      row.ScheduleID,
		StartsAt:        row.StartsAt.Time.UTC(),
		DurationMinutes: int(row.DurationMinutes),
		Seats:           int(row.Seats),
		Status:          row.Status,
		Timezone:        row.Timezone,
	}
	if row.HoldExpiresAt.Valid {
		at := row.HoldExpiresAt.Time
		out.HoldExpires = &at
	}
	if row.SubmissionID.Valid {
		id := uuid.UUID(row.SubmissionID.Bytes)
		out.SubmissionID = &id
	}
	return out, nil
}

// ScheduleCapacity — вместимость слота расписания. Отдельным запросом, а не чтением
// всей строки: подтверждению нужно одно число, а расписание с документом правила —
// это килобайты JSONB на каждом принятом ответе.
func (Repo) ScheduleCapacity(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID) (int, error) {
	n, err := postgres.New(db).GetScheduleCapacity(ctx, scheduleID)
	if err != nil {
		return 0, fmt.Errorf("capacity of schedule %s: %w", scheduleID, err)
	}
	return int(n), nil
}

// AttachBooking привязывает бронь к ответу и делает её подтверждённой.
func (Repo) AttachBooking(ctx context.Context, db postgres.DBTX, bookingID, submissionID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).ConfirmBooking(ctx, postgres.ConfirmBookingParams{
		ID:           bookingID,
		SubmissionID: pgtype.UUID{Bytes: submissionID, Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("confirm booking %s: %w", bookingID, err)
	}
	return n, nil
}

// BookingCard — что показывает страница отмены.
type BookingCard struct {
	ID     uuid.UUID
	FormID uuid.UUID
	// SubmissionID — ответ, которым запись оформлена; nil, если ответ удалили или
	// бронь так и осталась холдом. Письмо об отмене без него не собрать: адрес
	// получателя живёт в ответе.
	SubmissionID    *uuid.UUID
	StartsAt        time.Time
	DurationMinutes int
	Seats           int
	Status          string
	FormTitle       string
	Timezone        string
}

// BookingForCancel — карточка записи для страницы отмены.
// BookingMove — бронь перед переносом: что двигаем и сколько мест это займёт.
type BookingMove struct {
	ID              uuid.UUID
	FormID          uuid.UUID
	SubmissionID    *uuid.UUID
	StartsAt        time.Time
	DurationMinutes int
	Seats           int
}

func (Repo) BookingForMove(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID) (BookingMove, error) {
	row, err := postgres.New(db).BookingForMove(ctx, postgres.BookingForMoveParams{ID: id, ScheduleID: scheduleID})
	if err != nil {
		return BookingMove{}, err
	}
	move := BookingMove{
		ID:              row.ID,
		FormID:          row.FormID,
		StartsAt:        row.StartsAt.Time.UTC(),
		DurationMinutes: int(row.DurationMinutes),
		Seats:           int(row.Seats),
	}
	if row.SubmissionID.Valid {
		id := uuid.UUID(row.SubmissionID.Bytes)
		move.SubmissionID = &id
	}
	return move, nil
}

// TakenAtExcept — занятость точки без учёта самой переносимой брони.
func (Repo) TakenAtExcept(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time, bookingID uuid.UUID) (int, error) {
	n, err := postgres.New(db).TakenSeatsAtExcept(ctx, postgres.TakenSeatsAtExceptParams{
		ScheduleID: scheduleID,
		StartsAt:   pgtype.Timestamptz{Time: startsAt, Valid: true},
		ID:         bookingID,
	})
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// MoveBooking двигает бронь и возвращает НОВЫЙ номер редакции — тот, с которым уедет
// приглашение. pgx.ErrNoRows — строку между чтением и правкой отменили.
func (Repo) MoveBooking(ctx context.Context, db postgres.DBTX, id, scheduleID uuid.UUID, startsAt time.Time) (int, error) {
	rev, err := postgres.New(db).MoveBooking(ctx, postgres.MoveBookingParams{
		ID:         id,
		ScheduleID: scheduleID,
		StartsAt:   pgtype.Timestamptz{Time: startsAt, Valid: true},
	})
	return int(rev), err
}

func (Repo) BookingForCancel(ctx context.Context, db postgres.DBTX, id uuid.UUID) (BookingCard, error) {
	row, err := postgres.New(db).GetBookingForCancel(ctx, id)
	if err != nil {
		return BookingCard{}, err
	}
	card := BookingCard{
		ID:              row.ID,
		FormID:          row.FormID,
		StartsAt:        row.StartsAt.Time.UTC(),
		DurationMinutes: int(row.DurationMinutes),
		Seats:           int(row.Seats),
		Status:          row.Status,
		FormTitle:       row.FormTitle,
		Timezone:        row.Timezone,
	}
	if row.SubmissionID.Valid {
		id := uuid.UUID(row.SubmissionID.Bytes)
		card.SubmissionID = &id
	}
	return card, nil
}

// CancelByID отменяет запись по ссылке из письма. Право предъявил токен.
func (Repo) CancelByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (int, error) {
	rev, err := postgres.New(db).CancelBookingByID(ctx, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, err
		}
		return 0, fmt.Errorf("cancel booking %s: %w", id, err)
	}
	return int(rev), nil
}

// PurgeExpiredHolds убирает протухшие холды старше before. Место они не держат и так
// (счёт занятого отсекает истёкшие) — это уборка мусора, а не освобождение времени.
func (Repo) PurgeExpiredHolds(ctx context.Context, db postgres.DBTX, before time.Time) (int64, error) {
	n, err := postgres.New(db).DeleteExpiredHolds(ctx, pgtype.Timestamptz{Time: before, Valid: true})
	if err != nil {
		return 0, fmt.Errorf("purge expired holds: %w", err)
	}
	return n, nil
}

// CountFutureBookingsOfForm — живые будущие записи ФОРМЫ. Стоп-кран удаления ответа и
// формы спрашивает именно это (design/booking.md §4.10).
func (Repo) CountFutureBookingsOfForm(ctx context.Context, db postgres.DBTX, formID uuid.UUID, from time.Time) (int64, error) {
	n, err := postgres.New(db).CountFutureBookingsOfForm(ctx, postgres.CountFutureBookingsOfFormParams{
		FormID:   formID,
		StartsAt: pgtype.Timestamptz{Time: from, Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("count future bookings of form %s: %w", formID, err)
	}
	return n, nil
}

// CountFutureBookingsOfSubmission — живые будущие записи ОДНОГО ответа.
func (Repo) CountFutureBookingsOfSubmission(ctx context.Context, db postgres.DBTX, submissionID uuid.UUID, from time.Time) (int64, error) {
	n, err := postgres.New(db).CountFutureBookingsOfSubmission(ctx, postgres.CountFutureBookingsOfSubmissionParams{
		SubmissionID: pgtype.UUID{Bytes: submissionID, Valid: true},
		StartsAt:     pgtype.Timestamptz{Time: from, Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("count future bookings of submission %s: %w", submissionID, err)
	}
	return n, nil
}

// FormScheduleZone — пояс расписания формы. pgx.ErrNoRows пробрасывается: «у формы нет
// записи» разбирает вызывающий, и для него это состояние, а не ошибка.
func (Repo) FormScheduleZone(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (string, error) {
	return postgres.New(db).GetFormScheduleZone(ctx, formID)
}
