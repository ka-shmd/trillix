package booking

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Подтверждение брони в приёме ответа (фаза 27, слайс G).
//
// Работает ВНУТРИ ЧУЖОЙ ТРАНЗАКЦИИ — той, которой submissions принимает ответ: время
// записи попадает в сам ответ, и разъехаться этим двум записям нельзя. Отсюда две
// половины вместо одной: Reserve считает место под локом ДО вставки ответа (оттуда
// берётся время для ответа), Attach привязывает бронь ПОСЛЕ — внешний ключ требует,
// чтобы строка ответа уже существовала.

// ConfirmStore — то, что подтверждению нужно от данных.
type ConfirmStore interface {
	LockSlot(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time) error
	TakenAt(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time, clientID uuid.UUID) (int, error)
	BookingForConfirm(ctx context.Context, db postgres.DBTX, bookingID, formID, clientID uuid.UUID) (BookingRow, error)
	ScheduleCapacity(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID) (int, error)
	AttachBooking(ctx context.Context, db postgres.DBTX, bookingID, submissionID uuid.UUID) (int64, error)
}

var _ ConfirmStore = Repo{}

// BookingRow — строка брони в том виде, в каком её читает подтверждение.
type BookingRow struct {
	ID           uuid.UUID
	ScheduleID   uuid.UUID
	StartsAt     time.Time
	Seats        int
	Status       string
	HoldExpires  *time.Time
	SubmissionID *uuid.UUID
}

// Confirmer — подтверждение брони. Отдельный тип, а не метод сервиса: его зовёт
// ДРУГОЙ модуль (submissions) и внутри своей транзакции, поэтому ни пула, ни своих
// часов ему давать не надо.
type Confirmer struct {
	repo ConfirmStore
	now  func() time.Time
}

func NewConfirmer(repo ConfirmStore) *Confirmer {
	return &Confirmer{repo: repo, now: time.Now}
}

// WithClock подменяет часы (тесты).
func (c *Confirmer) WithClock(now func() time.Time) *Confirmer {
	c.now = now
	return c
}

// Reserve проверяет и придерживает место под ответ. Зовётся ВНУТРИ транзакции приёма,
// до вставки строки ответа.
//
// ИСТЁКШИЙ ХОЛД ПЕРЕЗАНИМАЕТСЯ, А НЕ ОТКАЗЫВАЕТ (ADR §10): пятнадцати минут не хватает
// на длинную анкету и на возврат к автосохранённому черновику, а отказ на кнопке
// «Отправить» — ровно то, ради чего холд и заводился. Место чаще всего так никто и не
// занял; отказ остаётся там, где он правдив.
func (c *Confirmer) Reserve(ctx context.Context, tx pgx.Tx, bookingID, formID, submissionID uuid.UUID) (domain.SlotHold, error) {
	b, err := c.repo.BookingForConfirm(ctx, tx, bookingID, formID, submissionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Брони нет, она чужой формы или взята другим клиентом — для отвечающего
			// это одно и то же: выбранного времени у него нет.
			return domain.SlotHold{}, fmt.Errorf("%w: время записи не выбрано", domain.ErrValidation)
		}
		return domain.SlotHold{}, err
	}

	switch b.Status {
	case domain.BookingCanceled:
		return domain.SlotHold{}, fmt.Errorf("%w: эта запись отменена", domain.ErrConflict)
	case domain.BookingConfirmed:
		// Уже подтверждена ЭТИМ ЖЕ ответом — идемпотентный ретрай отправки. Второго
		// места он не занимает и ничего не пересчитывает.
		if b.SubmissionID != nil && *b.SubmissionID == submissionID {
			return domain.SlotHold{StartsAt: b.StartsAt, Seats: b.Seats}, nil
		}
		// Подтверждена другим ответом того же клиента: по этой форме запись уже есть.
		return domain.SlotHold{}, fmt.Errorf("%w: по этой форме запись уже оформлена", domain.ErrConflict)
	}

	// Живой холд место уже держит — пересчитывать нечего.
	if b.HoldExpires != nil && b.HoldExpires.After(c.now()) {
		return domain.SlotHold{StartsAt: b.StartsAt, Seats: b.Seats}, nil
	}

	// Холд протух: место могли занять, и решает это счёт под локом — тем же, что у
	// взятия холда. Порядок локов в приёме фиксирован (сначала форма, потом слот), и
	// нарушать его нельзя: два лока в обратном порядке дают дедлок.
	if err := c.repo.LockSlot(ctx, tx, b.ScheduleID, b.StartsAt); err != nil {
		return domain.SlotHold{}, err
	}
	capacity, err := c.repo.ScheduleCapacity(ctx, tx, b.ScheduleID)
	if err != nil {
		return domain.SlotHold{}, err
	}
	taken, err := c.repo.TakenAt(ctx, tx, b.ScheduleID, b.StartsAt, submissionID)
	if err != nil {
		return domain.SlotHold{}, err
	}
	if taken+b.Seats > capacity {
		return domain.SlotHold{}, fmt.Errorf("%w: это время только что заняли", domain.ErrConflict)
	}
	return domain.SlotHold{StartsAt: b.StartsAt, Seats: b.Seats}, nil
}

// Attach привязывает бронь к принятому ответу. Зовётся ПОСЛЕ вставки строки ответа:
// внешний ключ submission_id требует, чтобы она уже была.
func (c *Confirmer) Attach(ctx context.Context, tx pgx.Tx, bookingID, submissionID uuid.UUID) error {
	n, err := c.repo.AttachBooking(ctx, tx, bookingID, submissionID)
	if err != nil {
		return err
	}
	if n == 0 {
		// Строку отменили между Reserve и этим утверждением — редкость, но молча
		// принять ответ с записью, которой нет, нельзя.
		return fmt.Errorf("%w: эта запись отменена", domain.ErrConflict)
	}
	return nil
}
