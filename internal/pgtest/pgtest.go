// Package pgtest поднимает одноразовый Postgres в контейнере и применяет к нему
// миграции проекта — общий фундамент интеграционных тестов (PROCESS §3: каждый
// эндпоинт покрывается тестом против testcontainers-Postgres). Импортируется
// только из тестов, поэтому в бинарь приложения не попадает.
package pgtest

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// MailService собирает почтовый сервис на dev-транспорте (LogMailer, логи в
// io.Discard) поверх пула. Нужен интеграционным тестам, где регистрация ставит
// письмо подтверждения email в outbox (auth.Service.Register без рабочего мейлера
// паникует), но сами письма тест не проверяет. Прод собирает сервис сам
// (cmd/api/main.go) — транспорт и From там из конфига.
func MailService(pool postgres.DBTX) *mail.Service {
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	return mail.NewService(pool, mail.Repo{}, mail.LogMailer{Log: discard, From: "test@localhost"},
		discard, 50, mail.Backoff{Base: time.Minute, Max: time.Hour})
}

// StartDSN поднимает пустой контейнер Postgres 16 и отдаёт DSN — БЕЗ миграций.
// Нужен тому единственному тесту, который сам решает, что накатывать и что
// откатывать (обратимость миграций); всем остальным нужен Start.
func StartDSN(ctx context.Context) (dsn string, stop func(), err error) {
	container, err := tcpostgres.Run(ctx, "postgres:16-alpine",
		tcpostgres.WithDatabase("trillix"),
		tcpostgres.WithUsername("test"),
		tcpostgres.WithPassword("test"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		return "", nil, fmt.Errorf("start postgres container: %w", err)
	}
	terminate := func() { _ = testcontainers.TerminateContainer(container) }

	dsn, err = container.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		terminate()
		return "", nil, fmt.Errorf("connection string: %w", err)
	}
	return dsn, terminate, nil
}

// Start запускает контейнер Postgres 16, прогоняет миграции и возвращает пул к
// свежей базе вместе с функцией остановки. Предназначен для вызова из TestMain:
// один контейнер на пакет, тесты изолируются очисткой данных между собой.
func Start(ctx context.Context) (pool *pgxpool.Pool, stop func(), err error) {
	dsn, terminate, err := StartDSN(ctx)
	if err != nil {
		return nil, nil, err
	}

	if err := postgres.MigrateUp(dsn); err != nil {
		terminate()
		return nil, nil, fmt.Errorf("migrate up: %w", err)
	}

	pool, err = postgres.NewPool(ctx, dsn)
	if err != nil {
		terminate()
		return nil, nil, fmt.Errorf("new pool: %w", err)
	}

	stop = func() {
		pool.Close()
		terminate()
	}
	return pool, stop, nil
}
