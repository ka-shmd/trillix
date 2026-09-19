package postgres

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type argsDB struct{ got []any }

func (d *argsDB) Exec(_ context.Context, _ string, args ...any) (pgconn.CommandTag, error) {
	d.got = args
	return pgconn.CommandTag{}, nil
}

func (d *argsDB) Query(_ context.Context, _ string, args ...any) (pgx.Rows, error) {
	d.got = args
	return nil, nil
}

func (d *argsDB) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	d.got = args
	return nil
}

// Режим выполнения pgx читает ТОЛЬКО из первого аргумента: окажись он не первым,
// запрос молча вернулся бы к кешу выражений и обобщённому плану.
func TestCustomPlans_ModeFirst(t *testing.T) {
	db := &argsDB{}
	c := CustomPlans(db)
	for name, call := range map[string]func(){
		"Query":    func() { _, _ = c.Query(context.Background(), "q", 1, "x") },
		"QueryRow": func() { _ = c.QueryRow(context.Background(), "q", 1, "x") },
		"Exec":     func() { _, _ = c.Exec(context.Background(), "q", 1, "x") },
	} {
		call()
		if len(db.got) != 3 || db.got[0] != pgx.QueryExecModeDescribeExec || db.got[1] != 1 || db.got[2] != "x" {
			t.Errorf("%s: аргументы %v", name, db.got)
		}
	}
}
