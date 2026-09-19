package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// CustomPlans — исполнитель, чьи запросы Postgres планирует по ФАКТИЧЕСКИМ параметрам
// на каждом выполнении (безымянное подготовленное выражение, pgx.QueryExecModeDescribeExec).
//
// Мина, от которой он спасает: по умолчанию pgx кеширует именованные выражения, и с
// шестого выполнения Postgres вправе перейти на ОБОБЩЁННЫЙ план. У аналитических
// запросов с необязательным условием («сегмент NULL или ключ визита в списке») и
// границами окна ±бесконечность обобщённый план не сворачивает «NULL IS NULL», читает
// meta каждой строки и теряет index-only: замер фазы 30 — счёт воронки 10 → 39 мс,
// путь 62 → 120, время на страницах 135 → 266 после пятого вызова. Плата — лишний
// круг до базы на запрос, против сотен миллисекунд выигрыша.
//
// Только для чтений аналитики: у коротких точечных запросов обобщённый план не хуже, а
// кеш выражений экономит разбор.
func CustomPlans(db DBTX) DBTX { return customPlans{db: db} }

type customPlans struct{ db DBTX }

func withMode(args []any) []any {
	return append([]any{pgx.QueryExecModeDescribeExec}, args...)
}

func (c customPlans) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	return c.db.Exec(ctx, sql, withMode(args)...)
}

func (c customPlans) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return c.db.Query(ctx, sql, withMode(args)...)
}

func (c customPlans) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return c.db.QueryRow(ctx, sql, withMode(args)...)
}
