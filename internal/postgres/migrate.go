package postgres

import (
	"errors"
	"fmt"
	"io"

	"github.com/golang-migrate/migrate/v4"
	pgxmigrate "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/ka-shmd/trillix/migrations"
)

// newMigrator строит migrate.Migrate поверх встроенных .sql-файлов и pgx.
// Открывает соединение через pgx-stdlib, поэтому вторая реализация драйвера
// (lib/pq) в зависимости не тянется.
//
// Источник возвращается вторым значением: migrate.Migrate наружу его не отдаёт,
// а откату нужно прочитать текст файла, который он собирается исполнить.
func newMigrator(dsn string) (*migrate.Migrate, source.Driver, error) {
	src, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return nil, nil, fmt.Errorf("open embedded migrations: %w", err)
	}
	connCfg, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, nil, fmt.Errorf("parse dsn: %w", err)
	}
	drv, err := pgxmigrate.WithInstance(stdlib.OpenDB(*connCfg), &pgxmigrate.Config{})
	if err != nil {
		return nil, nil, fmt.Errorf("init migrate driver: %w", err)
	}
	m, err := migrate.NewWithInstance("iofs", src, "trillix", drv)
	if err != nil {
		return nil, nil, fmt.Errorf("init migrator: %w", err)
	}
	return m, src, nil
}

// MigrateUp применяет все непримененные миграции. Отсутствие изменений — не ошибка.
func MigrateUp(dsn string) (err error) {
	m, _, err := newMigrator(dsn)
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

// DownMigration — миграция, которую откатит следующий шаг вниз: её номер, имя
// и ТЕКСТ отката. Текст нужен вызывающему, чтобы решить, спрашивать ли человека:
// «удалить таблицу» и «снять индекс» — разные последствия, и отличить их можно
// только по тому, что в файле написано.
type DownMigration struct {
	Version uint
	Name    string
	SQL     string
}

// Applied — есть ли что откатывать. Ноль означает пустую базу: MigrateDown на
// ней ничего не делает и возвращает пустое значение, а не ошибку.
func (d DownMigration) Applied() bool { return d.Version != 0 }

// MigrateDown откатывает одну последнюю миграцию.
//
// gate зовётся ПОСЛЕ чтения плана и ДО его исполнения: его ошибка отменяет
// откат, не тронув базу. Через него команда спрашивает человека, когда откат
// уносит данные, которых повторный `up` не вернёт (cmd/api). nil — откатывать
// без вопросов; так ходит только тест обратимости миграций.
func MigrateDown(dsn string, gate func(DownMigration) error) (down DownMigration, err error) {
	m, src, err := newMigrator(dsn)
	if err != nil {
		return DownMigration{}, err
	}
	defer func() {
		srcErr, dbErr := m.Close()
		err = errors.Join(err, srcErr, dbErr)
	}()

	version, dirty, err := m.Version()
	if errors.Is(err, migrate.ErrNilVersion) {
		return DownMigration{}, nil
	}
	if err != nil {
		return DownMigration{}, fmt.Errorf("read schema version: %w", err)
	}
	if dirty {
		return DownMigration{}, fmt.Errorf("schema version %d is dirty: fix it by hand before rolling back", version)
	}

	down, err = readDown(src, version)
	if err != nil {
		return DownMigration{}, err
	}
	if gate != nil {
		if err := gate(down); err != nil {
			return down, err
		}
	}

	if e := m.Steps(-1); e != nil && !errors.Is(e, migrate.ErrNoChange) {
		return down, fmt.Errorf("migrate down: %w", e)
	}
	return down, nil
}

// readDown достаёт файл отката названной версии из встроенных миграций.
func readDown(src source.Driver, version uint) (DownMigration, error) {
	r, name, err := src.ReadDown(version)
	if err != nil {
		return DownMigration{}, fmt.Errorf("read down migration %d: %w", version, err)
	}
	defer func() { _ = r.Close() }()

	sql, err := io.ReadAll(r)
	if err != nil {
		return DownMigration{}, fmt.Errorf("read down migration %d: %w", version, err)
	}
	return DownMigration{Version: version, Name: name, SQL: string(sql)}, nil
}
