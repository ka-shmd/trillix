package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TxRunner привязывает WithTx к конкретному пулу, чтобы service зависел от
// маленького интерфейса (WithTx без пула), а не от *pgxpool.Pool напрямую —
// в юнит-тестах он подменяется фейком, выполняющим fn без реальной транзакции.
type TxRunner struct {
	Pool *pgxpool.Pool
}

// WithTx выполняет fn в одной транзакции против связанного пула.
func (r TxRunner) WithTx(ctx context.Context, fn func(pgx.Tx) error) error {
	return WithTx(ctx, r.Pool, fn)
}

// WithTx выполняет fn в одной транзакции: коммит при nil-ошибке, иначе откат.
// Вызывается из service-слоя там, где несколько операций обязаны быть атомарны
// (регистрация = user + workspace + membership; публикация формы = version +
// published_version_id). Переданный fn получает tx как исполнителя для repo.
func WithTx(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op после успешного Commit

	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}
