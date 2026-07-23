package mail

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Store — доступ к данным outbox, объявленный на стороне потребителя (сервиса);
// реализация — Repo, в тестах подменяется фейком.
type Store interface {
	Enqueue(ctx context.Context, db postgres.DBTX, id uuid.UUID, channel string, payload []byte) error
	ListPending(ctx context.Context, db postgres.DBTX, limit int32) ([]Pending, error)
	MarkSent(ctx context.Context, db postgres.DBTX, id uuid.UUID) error
	MarkFailed(ctx context.Context, db postgres.DBTX, id uuid.UUID, attempts int32, nextAttemptAt time.Time, lastError string) error
}

var _ Store = Repo{}

// Backoff — задержка перед следующей попыткой доставки: экспоненциальная от Base
// с потолком Max (первая неудача → Base, дальше удвоение до Max). Чистая функция
// delay тестируется без БД. Верхнего числа попыток нет: провайдер может лежать
// долго, а письмо (сброс пароля) обязано уйти, когда он вернётся; вечно-битая
// строка ретраится раз в Max — терпимо, dead-letter — возможная будущая полировка.
type Backoff struct {
	Base time.Duration
	Max  time.Duration
}

// delay для attempts уже сделанных (неудачных) попыток (>=1).
func (b Backoff) delay(attempts int32) time.Duration {
	d := b.Base
	for i := int32(1); i < attempts; i++ {
		d *= 2
		if d >= b.Max {
			return b.Max
		}
	}
	if d > b.Max {
		return b.Max
	}
	return d
}

// Service — диспетчеризация outbox и запись намерений доставки.
type Service struct {
	db      postgres.DBTX // пул: выборка готовых и пометки исхода в диспетчере
	repo    Store
	mailer  Mailer
	log     *slog.Logger
	batch   int32
	backoff Backoff
	now     func() time.Time // подменяется в тестах
}

func NewService(db postgres.DBTX, repo Store, mailer Mailer, log *slog.Logger, batch int32, backoff Backoff) *Service {
	return &Service{db: db, repo: repo, mailer: mailer, log: log, batch: batch, backoff: backoff, now: time.Now}
}

// EnqueueEmail пишет письмо в outbox через переданный исполнитель. db — транзакция
// продюсера: письмо фиксируется атомарно с изменением состояния, которое его
// породило (transactional outbox). Синхронно наружу ничего не уходит — доставку
// делает диспетчер.
func (s *Service) EnqueueEmail(ctx context.Context, db postgres.DBTX, msg EmailMessage) error {
	if msg.To == "" {
		return fmt.Errorf("enqueue email: empty recipient")
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal email payload: %w", err)
	}
	return s.repo.Enqueue(ctx, db, domain.NewID(), ChannelEmail, payload)
}

// Dispatch отправляет одну пачку готовых писем; возвращает число доставленных.
// Гоняется periodic-задачей. Сбой отдельного письма не роняет пачку: письмо
// логируется и откладывается по бэкоффу, диспетчер идёт к следующему.
func (s *Service) Dispatch(ctx context.Context) (int, error) {
	pending, err := s.repo.ListPending(ctx, s.db, s.batch)
	if err != nil {
		return 0, err
	}
	sent := 0
	for _, p := range pending {
		if err := ctx.Err(); err != nil {
			return sent, err // остановка процесса — не ошибка задачи
		}
		if err := s.deliver(ctx, p); err != nil {
			s.markFailed(ctx, p, err)
			continue
		}
		if err := s.repo.MarkSent(ctx, s.db, p.ID); err != nil {
			// Письмо ушло, но пометку не записали — при следующем прогоне уйдёт
			// повторно. Дубль приемлемее потери; логируем и идём дальше.
			s.log.Error("outbox: delivered but mark-sent failed",
				slog.String("id", p.ID.String()), slog.String("error", err.Error()))
			continue
		}
		sent++
	}
	return sent, nil
}

// deliver маршрутизирует строку по каналу в нужный транспорт. Неизвестный канал
// или битый payload — ошибка доставки (строка уйдёт на ретрай); в норме такого
// не бывает, payload пишем мы сами.
func (s *Service) deliver(ctx context.Context, p Pending) error {
	switch p.Channel {
	case ChannelEmail:
		var msg EmailMessage
		if err := json.Unmarshal(p.Payload, &msg); err != nil {
			return fmt.Errorf("unmarshal email payload: %w", err)
		}
		return s.mailer.Send(ctx, msg)
	default:
		return fmt.Errorf("unknown outbox channel %q", p.Channel)
	}
}

func (s *Service) markFailed(ctx context.Context, p Pending, cause error) {
	attempts := p.Attempts + 1
	nextAt := s.now().Add(s.backoff.delay(attempts))
	s.log.Warn("outbox: delivery failed, will retry",
		slog.String("id", p.ID.String()),
		slog.String("channel", p.Channel),
		slog.Int("attempts", int(attempts)),
		slog.Time("next_attempt_at", nextAt),
		slog.String("error", cause.Error()))
	if err := s.repo.MarkFailed(ctx, s.db, p.ID, attempts, nextAt, cause.Error()); err != nil {
		s.log.Error("outbox: mark-failed failed",
			slog.String("id", p.ID.String()), slog.String("error", err.Error()))
	}
}
