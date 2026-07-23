package mail

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// Pending — строка outbox, готовая к доставке (без служебных полей, не нужных
// диспетчеру): id для пометки исхода, channel для маршрутизации, payload для
// транспорта, attempts для расчёта следующего бэкоффа.
type Pending struct {
	ID       uuid.UUID
	Channel  string
	Payload  []byte
	Attempts int32
}

// Repo — доступ к данным outbox поверх sqlc. Методы принимают исполнителя
// (postgres.DBTX — пул или транзакция); Enqueue вызывается в чужой транзакции
// (transactional outbox), выборка и пометки исхода — на пуле из диспетчера.
type Repo struct{}

// Enqueue пишет намерение доставки. db — исполнитель продюсера (его транзакция).
func (Repo) Enqueue(ctx context.Context, db postgres.DBTX, id uuid.UUID, channel string, payload []byte) error {
	if err := postgres.New(db).EnqueueOutbox(ctx, postgres.EnqueueOutboxParams{
		ID:      id,
		Channel: channel,
		Payload: payload,
	}); err != nil {
		return fmt.Errorf("enqueue outbox: %w", err)
	}
	return nil
}

// ListPending возвращает до limit готовых к отправке строк (недоставленные,
// next_attempt_at наступил), старейшая задолженность первой.
func (Repo) ListPending(ctx context.Context, db postgres.DBTX, limit int32) ([]Pending, error) {
	rows, err := postgres.New(db).ListPendingOutbox(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending outbox: %w", err)
	}
	out := make([]Pending, len(rows))
	for i, r := range rows {
		out[i] = Pending{ID: r.ID, Channel: r.Channel, Payload: r.Payload, Attempts: r.Attempts}
	}
	return out, nil
}

// MarkSent помечает строку доставленной (терминально).
func (Repo) MarkSent(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).MarkOutboxSent(ctx, id); err != nil {
		return fmt.Errorf("mark outbox sent: %w", err)
	}
	return nil
}

// MarkFailed растит счётчик попыток, откладывает следующую и сохраняет ошибку.
func (Repo) MarkFailed(ctx context.Context, db postgres.DBTX, id uuid.UUID, attempts int32, nextAttemptAt time.Time, lastError string) error {
	if err := postgres.New(db).MarkOutboxFailed(ctx, postgres.MarkOutboxFailedParams{
		ID:            id,
		Attempts:      attempts,
		NextAttemptAt: pgtype.Timestamptz{Time: nextAttemptAt, Valid: true},
		LastError:     pgtype.Text{String: lastError, Valid: true},
	}); err != nil {
		return fmt.Errorf("mark outbox failed: %w", err)
	}
	return nil
}
