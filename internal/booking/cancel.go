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

// Отмена записи респондентом по ссылке из письма (фаза 27, слайс H).
//
// Ни сессии, ни пароля у него нет: право предъявляет подписанный токен, покрывающий id
// брони и срок. Поэтому страница отмены не спрашивает ничего и ничего не раскрывает
// сверх того, что человеку и так прислали письмом: время, длительность и название
// формы. Чужих ответов, имён и контактов на ней нет (спека §13).

// CancelStore — доступ к данным отмены.
type CancelStore interface {
	BookingForCancel(ctx context.Context, db postgres.DBTX, id uuid.UUID) (BookingCard, error)
	CancelByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (int64, error)
	PurgeExpiredHolds(ctx context.Context, db postgres.DBTX, before time.Time) (int64, error)
}

var _ CancelStore = Repo{}

// CancelNotifier — письмо об отмене записи. Интерфейс объявлен здесь, у потребителя;
// реализация — *submissions.Service: адрес получателя живёт в ОТВЕТЕ формы, и знает о
// нём только модуль ответов.
//
// Зовётся best-effort: письмо не имеет права отменить отмену. Человек нажал кнопку,
// место освободилось — сбой почты этого уже не отменяет.
type CancelNotifier interface {
	// sequence — номер редакции документа календаря. Едет ПАРАМЕТРОМ, а не считается
	// на месте: он живёт в строке брони (bookings.revision, 0052) и растёт с каждым
	// переносом, а модуль писем о ней знает только id.
	NotifyBookingCanceled(ctx context.Context, formID, submissionID, bookingID uuid.UUID,
		startsAt time.Time, durationMinutes int, sequence int, timezone string)
}

// BookingNotifier — письма о чужой встрече, которые шлёт КАБИНЕТ. Отмена у него общая
// с отменой по ссылке, а перенос бывает только отсюда: респонденту переноса не дано
// (ADR §10), у него в письме одна кнопка — отменить.
type BookingNotifier interface {
	CancelNotifier
	NotifyBookingRescheduled(ctx context.Context, formID, submissionID, bookingID uuid.UUID,
		wasAt, startsAt time.Time, durationMinutes int, sequence int, timezone string)
}

// CancelService — страница отмены и сама отмена.
type CancelService struct {
	db       postgres.DBTX
	repo     CancelStore
	secret   []byte
	notifier CancelNotifier
	now      func() time.Time
}

// WithNotifier подключает письмо об отмене.
func (s *CancelService) WithNotifier(n CancelNotifier) *CancelService {
	s.notifier = n
	return s
}

// NewCancelService собирает сервис отмены. secret — производный секрет отмены
// (DeriveCancelSecret): выводит его композиционный корень, а не сервис, — так секрет
// контура не расходится по модулям.
func NewCancelService(db postgres.DBTX, repo CancelStore, secret []byte) *CancelService {
	return &CancelService{db: db, repo: repo, secret: secret, now: time.Now}
}

// WithClock подменяет часы (тесты).
func (s *CancelService) WithClock(now func() time.Time) *CancelService {
	s.now = now
	return s
}

// Card — что показать на странице отмены.
type Card struct {
	StartsAt        time.Time
	DurationMinutes int
	Seats           int
	FormTitle       string
	Timezone        string
	// Canceled — запись уже отменена. Не ошибка: по ссылке переходят дважды, и второй
	// раз человек обязан увидеть «уже отменено», а не отказ.
	Canceled bool
	// Ниже — служебное: письму об отмене нужно знать, у какого ответа брать адрес и
	// с каким номером редакции гасить событие календаря. Наружу не отдаётся
	// (см. cardView в public_handler.go).
	formID       uuid.UUID
	submissionID *uuid.UUID
	revision     int
}

// Show — карточка записи по ссылке отмены.
func (s *CancelService) Show(ctx context.Context, tok string) (Card, error) {
	id, ok := ParseCancelToken(s.secret, tok, s.now())
	if !ok {
		// Подделка и протухшая ссылка снаружи неотличимы: у человека в обоих случаях
		// одно действие — написать автору формы.
		return Card{}, domain.ErrLinkExpired
	}
	b, err := s.repo.BookingForCancel(ctx, s.db, id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Записи нет: удалили расписание или форму. Для человека это тот же
			// «ссылка больше не действует» — отменять нечего.
			return Card{}, domain.ErrLinkExpired
		}
		return Card{}, err
	}
	return Card{
		StartsAt:        b.StartsAt,
		DurationMinutes: b.DurationMinutes,
		Seats:           b.Seats,
		FormTitle:       b.FormTitle,
		Timezone:        b.Timezone,
		Canceled:        b.Status == domain.BookingCanceled,
		formID:          b.FormID,
		submissionID:    b.SubmissionID,
		revision:        b.Revision,
	}, nil
}

// Cancel отменяет запись по ссылке. Место возвращается в оборот тем же утверждением,
// что меняет статус: без этого группа со временем зарастает отменёнными записями и
// перестаёт набираться.
func (s *CancelService) Cancel(ctx context.Context, tok string) (Card, error) {
	card, err := s.Show(ctx, tok)
	if err != nil {
		return Card{}, err
	}
	if card.Canceled {
		// Повторный переход по той же ссылке — успех, а не отказ: человек хотел
		// отменить, и запись отменена.
		return card, nil
	}
	id, _ := ParseCancelToken(s.secret, tok, s.now())
	if _, err := s.repo.CancelByID(ctx, s.db, id); err != nil {
		return Card{}, err
	}
	card.Canceled = true
	// Письмо с отменой приглашения — ПОСЛЕ отмены и best-effort: календарь человека
	// гасит событие тем же UID, а сбой почты уже освобождённое место не занимает.
	if s.notifier != nil && card.formID != uuid.Nil && card.submissionID != nil {
		s.notifier.NotifyBookingCanceled(ctx, card.formID, *card.submissionID, id,
			// СЛЕДУЮЩИЙ номер, а не единица: после переносов приглашение уже уехало
			// с бо́льшим, и отмена с прежним была бы отброшена как устаревшая.
			card.StartsAt, card.DurationMinutes, card.revision+1, card.Timezone)
	}
	return card, nil
}

// PurgeHolds убирает протухшие холды. Зовётся периодической задачей.
//
// ⚠ ЭТО УБОРКА, А НЕ ОСВОБОЖДЕНИЕ ВРЕМЕНИ. Место возвращается в оборот само —
// счёт занятого не считает истёкшие холды, — и заминка задачи ни на что не влияет.
// Полагаться на неё в вопросе «свободно ли» нельзя.
func (s *CancelService) PurgeHolds(ctx context.Context, grace time.Duration) (int64, error) {
	n, err := s.repo.PurgeExpiredHolds(ctx, s.db, s.now().Add(-grace))
	if err != nil {
		return 0, fmt.Errorf("purge holds: %w", err)
	}
	return n, nil
}
