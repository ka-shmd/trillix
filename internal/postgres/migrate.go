package postgres

import (
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	pgxmigrate "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/ka-shmd/trillix/migrations"
)

// newMigrator строит migrate.Migrate поверх встроенных .sql-файлов и pgx.
// Открывает соединение через pgx-stdlib, поэтому вторая реализация драйвера
// (lib/pq) в зависимости не тянется.
func newMigrator(dsn string) (*migrate.Migrate, error) {
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return nil, fmt.Errorf("open embedded migrations: %w", err)
	}
	connCfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	drv, err := pgxmigrate.WithInstance(stdlib.OpenDB(*connCfg), &pgxmigrate.Config{})
	if err != nil {
		return nil, fmt.Errorf("init migrate driver: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", src, "trillix", drv)
	if err != nil {
		return nil, fmt.Errorf("init migrator: %w", err)
	}
	return m, nil
}

// MigrateUp применяет все непримененные миграции. Отсутствие изменений — не ошибка.
func MigrateUp(dsn string) (err error) {
	m, err := newMigrator(dsn)
	if err != nil {
		return err
	}
	defer func() {
		srcErr, dbErr := m.Close()
		err = errors.Join(err, srcErr, dbErr)
	}()

	if e := m.Up(); e != nil && !errors.Is(e, migrate.ErrNoChange) {
		return fmt.Errorf("migrate up: %w", e)
	}
	return nil
}

// MigrateDown откатывает одну последнюю миграцию.
func MigrateDown(dsn string) (err error) {
	m, err := newMigrator(dsn)
	if err != nil {
		return err
	}
	defer func() {
		srcErr, dbErr := m.Close()
		err = errors.Join(err, srcErr, dbErr)
	}()

	if e := m.Steps(-1); e != nil && !errors.Is(e, migrate.ErrNoChange) {
		return fmt.Errorf("migrate down: %w", e)
	}
	return nil
}
