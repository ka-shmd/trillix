//go:build integration

// Обратимость миграций: накатить всё, откатить всё по одной, накатить снова.
//
// База одноразовая, и это главное свойство теста: тот же вопрос, заданный
// dev-контуру, стоит его данных.
// История — JOURNAL, «Откат миграции стал громким».
package migrations_test

import (
	"context"
	"testing"

	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
)

func TestMigrationsRoundTrip(t *testing.T) {
	ctx := context.Background()
	dsn, stop, err := pgtest.StartDSN(ctx)
	if err != nil {
		t.Fatalf("поднять Postgres: %v", err)
	}
	defer stop()

	if err := postgres.MigrateUp(dsn); err != nil {
		t.Fatalf("первый накат: %v", err)
	}

	// Вниз по одной — тем же путём, которым ходит `api migrate down`: ворота
	// nil, потому что спрашивать здесь некого.
	steps := 0
	for {
		down, err := postgres.MigrateDown(dsn, nil)
		if err != nil {
			t.Fatalf("откат после %d шагов: %v", steps, err)
		}
		if !down.Applied() {
			break
		}
		steps++
		if steps > 1000 {
			t.Fatal("откат не кончается: MigrateDown не двигает версию")
		}
	}
	if steps == 0 {
		t.Fatal("не откатилось ни одной миграции — накат ничего не применил")
	}

	// Пустая база означает пустую схему. Откат, оставивший за собой таблицу,
	// уронил бы следующий накат не здесь, а через полгода на чужой машине.
	if left := publicTables(ctx, t, dsn); len(left) > 0 {
		t.Errorf("после полного отката в схеме остались таблицы: %v", left)
	}

	if err := postgres.MigrateUp(dsn); err != nil {
		t.Fatalf("повторный накат после отката: %v", err)
	}
}

// publicTables — таблицы схемы public, кроме служебной таблицы версий самого
// раннера миграций: её он заводит сам и сам за собой не убирает.
func publicTables(ctx context.Context, t *testing.T, dsn string) []string {
	t.Helper()
	pool, err := postgres.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("пул к базе: %v", err)
	}
	defer pool.Close()

	rows, err := pool.Query(ctx, `SELECT tablename FROM pg_tables
		WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
		ORDER BY tablename`)
	if err != nil {
		t.Fatalf("список таблиц: %v", err)
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("список таблиц: %v", err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("список таблиц: %v", err)
	}
	return names
}
