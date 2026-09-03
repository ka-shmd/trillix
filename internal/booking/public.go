package booking

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Публичная половина записи: свободное время и холд (фаза 27, design/booking.md §7).
//
// ⚠ ЭТО ДВА НОВЫХ ПУБЛИЧНЫХ ВХОДА ПО SLUG, и они попадают в тот самый закрытый список,
// который держится вручную (мины на forms.PublicForm.PasswordSealed и
// domain.ErrFormLocked). Общего middleware здесь нет и быть не может: решение
// принимается по СТРОКЕ ФОРМЫ, а не по маршруту. Отказывать они обязаны так же, как
// отдача формы:
//
//	черновик или удалённая  → 404 (существование приватного не раскрывается)
//	форма под паролем       → 401 (токен разблокировки в X-Form-Unlock)
//	форма закрыта           → 410 (была публичной — не скрываем)
//	у формы нет расписания  → 404 (вопроса о времени не существует)
//
// Проверки идут именно в этом порядке и в обеих ручках: разойдясь, они превратили бы
// одну из них в оракул — она отвечала бы иначе там, где отдача формы отвечает 404.

// PublicForms — то, что публичной половине нужно от модуля forms. Тот же узкий
// интерфейс, что у submissions и answerfiles: доступ к публичной форме правом не
// является, но черновик и несуществующая обязаны давать одинаковый 404.
type PublicForms interface {
	PublicForm(ctx context.Context, slug string) (forms.PublicForm, error)
	// VerifyUnlock — пускать ли к содержимому формы, закрытой паролем (0047).
	VerifyUnlock(formID uuid.UUID, sealed []byte, tok string) error
}

// PublicStore — доступ к данным публичной половины.
type PublicStore interface {
	GetSchedule(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Schedule, error)
	BlocksInRange(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from, to time.Time) ([]Block, error)
	TakenSeats(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, from, to time.Time, clientID uuid.UUID) (domain.Taken, error)
	LockSlot(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time) error
	TakenAt(ctx context.Context, db postgres.DBTX, scheduleID uuid.UUID, startsAt time.Time, clientID uuid.UUID) (int, error)
	Hold(ctx context.Context, db postgres.DBTX, h NewHold) (uuid.UUID, bool, error)
}

var _ PublicStore = Repo{}

// TxRunner — транзакция для холда: лок, счёт и вставка обязаны быть одной.
type TxRunner interface {
	WithTx(ctx context.Context, fn func(tx pgx.Tx) error) error
}

// PublicService — свободное время и холды.
type PublicService struct {
	db    postgres.DBTX
	tx    TxRunner
	repo  PublicStore
	forms PublicForms
	now   func() time.Time
}

func NewPublicService(db postgres.DBTX, tx TxRunner, repo PublicStore, f PublicForms) *PublicService {
	return &PublicService{db: db, tx: tx, repo: repo, forms: f, now: time.Now}
}

// WithClock подменяет часы (тесты).
func (s *PublicService) WithClock(now func() time.Time) *PublicService {
	s.now = now
	return s
}

// SlotsRequest — что спрашивает выдача свободного времени.
type SlotsRequest struct {
	Slug string
	From time.Time
	To   time.Time
	// Unlock — токен разблокировки формы под паролем; пусто у открытой.
	Unlock string
	// ClientID — кто спрашивает. Его собственный холд не считается занятым: человек,
	// вернувшийся к списку, обязан снова увидеть время, которое сам же держит.
	ClientID uuid.UUID
}

// FactsFor — факты расписания для публичной отдачи формы. nil, если записи у формы
// нет: тогда вопрос о времени (если он в схеме) живого выбора не получает.
//
// Тип ответа — forms.BookingFacts, а не свой: интерфейс объявляет ПОТРЕБИТЕЛЬ
// (forms.ScheduleFacts), и свой тип здесь потребовал бы от forms знать про booking —
// а booking уже знает про forms.
//
// Отказы формы здесь НЕ повторяются: зовёт эту функцию сама отдача формы, уже прошедшая
// их все.
func (s *PublicService) FactsFor(ctx context.Context, scheduleID *uuid.UUID) (*forms.BookingFacts, error) {
	if scheduleID == nil {
		return nil, nil
	}
	sch, err := s.repo.GetSchedule(ctx, s.db, *scheduleID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Расписание удалено под ногами: внешний ключ этого не допускает, но
			// читаем мы двумя запросами — отвечаем «записи нет», а не пятисоткой.
			return nil, nil
		}
		return nil, err
	}
	return &forms.BookingFacts{
		Timezone:      sch.Timezone,
		MaxSeats:      sch.MaxSeatsPerBooking,
		ShowRemaining: sch.ShowRemaining,
	}, nil
}

// Slots — свободное время формы на отрезке.
func (s *PublicService) Slots(ctx context.Context, req SlotsRequest) ([]domain.Slot, error) {
	_, sch, err := s.formSchedule(ctx, req.Slug, req.Unlock)
	if err != nil {
		return nil, err
	}

	from, to := s.window(req.From, req.To, sch)
	slots, err := s.freeSlots(ctx, sch, from, to, req.ClientID)
	if err != nil {
		return nil, err
	}
	// Отрезок запроса режет уже посчитанное: горизонт считает домен, а окно — клиент,
	// и пересекать их в домене значило бы учить его о запросах.
	out := slots[:0]
	for _, sl := range slots {
		if !sl.StartsAt.Before(from) && sl.StartsAt.Before(to) {
			out = append(out, sl)
		}
	}
	return out, nil
}

// HoldRequest — что нужно, чтобы придержать время.
type HoldRequest struct {
	Slug     string
	StartsAt time.Time
	Seats    int
	ClientID uuid.UUID
	Unlock   string
}

// Hold придерживает время на HoldTTL.
//
// ГОНКА ЗАКРЫВАЕТСЯ В БАЗЕ: advisory-lock по паре «расписание + начало слота», затем
// счёт занятого и вставка — одной транзакцией (ADR §10). Уникальный индекс здесь не
// годится: при вместимости больше единицы уникальна не строка, а сумма мест.
func (s *PublicService) Hold(ctx context.Context, req HoldRequest) (uuid.UUID, time.Time, error) {
	pf, sch, err := s.formSchedule(ctx, req.Slug, req.Unlock)
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	if req.Seats < 1 || req.Seats > sch.MaxSeatsPerBooking {
		return uuid.Nil, time.Time{}, fmt.Errorf("%w: столько мест в одной записи взять нельзя", domain.ErrValidation)
	}

	// Время обязано быть тем, что предлагает расписание СЕЙЧАС. Без этой проверки
	// клиент придерживал бы что угодно: и час вне окон приёма, и прошлое, и слот,
	// закрытый блокировкой, — «свободное» считает сервер, а не браузер.
	if err := s.offered(ctx, sch, req.StartsAt, req.ClientID, req.Seats); err != nil {
		return uuid.Nil, time.Time{}, err
	}

	id := domain.NewID()
	expires := s.now().Add(domain.HoldTTL)
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.repo.LockSlot(ctx, tx, sch.ID, req.StartsAt); err != nil {
			return err
		}
		// Счёт ПОД ЛОКОМ и заново: между проверкой предложения и этой строкой слот
		// мог занять кто-то другой, и именно здесь гонка и закрывается.
		taken, err := s.repo.TakenAt(ctx, tx, sch.ID, req.StartsAt, req.ClientID)
		if err != nil {
			return err
		}
		if taken+req.Seats > sch.Capacity {
			return errSlotTaken(sch.Capacity - taken)
		}
		newID, moved, err := s.repo.Hold(ctx, tx, NewHold{
			ID:              id,
			ScheduleID:      sch.ID,
			FormID:          pf.FormID,
			ClientID:        req.ClientID,
			StartsAt:        req.StartsAt,
			DurationMinutes: sch.SlotMinutes,
			Seats:           req.Seats,
			ExpiresAt:       expires,
		})
		if err != nil {
			return err
		}
		if !moved {
			// У клиента уже есть подтверждённая запись в этой форме: ответ отправлен,
			// и переносить состоявшуюся встречу холдом нельзя.
			return fmt.Errorf("%w: по этой форме запись уже оформлена", domain.ErrConflict)
		}
		id = newID
		return nil
	})
	if err != nil {
		return uuid.Nil, time.Time{}, err
	}
	return id, expires, nil
}

// freeSlots — свободное время расписания на отрезке: блокировки и занятое из базы,
// счёт — в домене. Единственный путь к ответу «свободно ли»: и выдача времени (Slots),
// и проверка перед холдом (offered) обязаны отвечать одинаково, а два одинаковых куска
// отвечают одинаково только пока их правят вместе.
//
// Отрезок здесь НЕ режется по краям: домен считает горизонт целиком, обрезка — дело
// вызывающего (Slots режет окном клиента, offered ищет в выдаче одну точку).
func (s *PublicService) freeSlots(
	ctx context.Context, sch Schedule, from, to time.Time, clientID uuid.UUID,
) ([]domain.Slot, error) {
	blocks, err := s.repo.BlocksInRange(ctx, s.db, sch.ID, from, to)
	if err != nil {
		return nil, err
	}
	taken, err := s.repo.TakenSeats(ctx, s.db, sch.ID, from, to, clientID)
	if err != nil {
		return nil, err
	}
	busy := make([]domain.Busy, 0, len(blocks))
	for _, b := range blocks {
		busy = append(busy, domain.Busy{StartsAt: b.StartsAt, EndsAt: b.EndsAt})
	}
	return domain.FreeSlots(sch.Schedule, busy, taken, s.now())
}

// offered — предлагает ли расписание это время прямо сейчас. Считается тем же кодом,
// что и выдача: два разных ответа на вопрос «свободно ли» разошлись бы молча.
func (s *PublicService) offered(ctx context.Context, sch Schedule, at time.Time, clientID uuid.UUID, seats int) error {
	// Окно — ВЕСЬ СЛОТ, а не точка старта: блокировка, начинающаяся внутри него
	// (обед с 10:30 при часовом приёме), слот пересекает, но в минутное окно не
	// попадает — и холд проходил бы поверх времени, которое автор закрыл, а выдача
	// уже не показывает. Правого края слота окно не включает, поэтому соседний старт
	// в счёт занятого не попадает.
	end := at.Add(time.Duration(sch.SlotMinutes) * time.Minute)
	slots, err := s.freeSlots(ctx, sch, at, end, clientID)
	if err != nil {
		return err
	}
	for _, sl := range slots {
		if sl.StartsAt.Equal(at.UTC()) {
			if sl.Remaining < seats {
				return errSlotTaken(sl.Remaining)
			}
			return nil
		}
	}
	return fmt.Errorf("%w: записаться на это время уже нельзя", domain.ErrConflict)
}

// errSlotTaken — «мест не хватило». Текст пишет рендерер (он говорит с клиентом
// автора), сюда попадает только повод: код конверта у обоих один — 409.
func errSlotTaken(left int) error {
	if left <= 0 {
		return fmt.Errorf("%w: это время только что заняли", domain.ErrConflict)
	}
	return fmt.Errorf("%w: свободных мест осталось %d", domain.ErrValidation, left)
}

// formSchedule — форма по slug плюс её расписание, со всеми четырьмя отказами.
func (s *PublicService) formSchedule(ctx context.Context, slug, unlock string) (forms.PublicForm, Schedule, error) {
	pf, err := s.forms.PublicForm(ctx, slug)
	if err != nil {
		// Черновик и несуществующая одинаково дают 404 — это делает сам forms.
		return forms.PublicForm{}, Schedule{}, err
	}
	// Пароль — тот самый закрытый список входов. Проверяется ДО всего остального:
	// иначе ручка рассказывала бы о закрытой форме тому, кто пароля не знает.
	if err := s.forms.VerifyUnlock(pf.FormID, pf.PasswordSealed, unlock); err != nil {
		return forms.PublicForm{}, Schedule{}, err
	}
	if domain.FormClosed(pf.Status, pf.CloseAt, pf.ResponseLimit, pf.SubmissionCount, s.now()) {
		return forms.PublicForm{}, Schedule{}, domain.ErrFormClosed
	}
	if pf.ScheduleID == nil {
		// Записи у формы нет — вопроса о времени не существует, и говорить о нём
		// нечего: 404, как о несуществующей форме.
		return forms.PublicForm{}, Schedule{}, domain.ErrNotFound
	}
	sch, err := s.repo.GetSchedule(ctx, s.db, *pf.ScheduleID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return forms.PublicForm{}, Schedule{}, domain.ErrNotFound
		}
		return forms.PublicForm{}, Schedule{}, err
	}
	return pf, sch, nil
}

// window — отрезок выдачи. Клиент вправе спросить меньше горизонта, но не больше и не
// в прошлом: расчёт всё равно вернёт только предлагаемое, а лишний диапазон — лишняя
// работа базы на публичной ручке.
func (s *PublicService) window(from, to time.Time, sch Schedule) (time.Time, time.Time) {
	now := s.now()
	limit := now.AddDate(0, 0, sch.HorizonDays+1)
	if from.Before(now) || from.IsZero() {
		from = now
	}
	if to.IsZero() || to.After(limit) {
		to = limit
	}
	if to.Before(from) {
		to = from
	}
	return from, to
}
