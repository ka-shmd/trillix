//go:build integration

// Перенос намерения о бейдже из схемы в колонку (0038).
//
// Отдельным тестом, а не строкой в roundtrip: тот проверяет ОБРАТИМОСТЬ на пустой
// базе и данных не видит вовсе. Здесь проверяется единственное, ради чего миграция
// написана, — что снятый автором бейдж переживает переезд. Ошибка в этом месте
// молчалива: формы просто снова покажут бейдж, и заметит это не деплой, а автор.
package migrations_test

import (
	"context"
	"testing"

	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Версия миграции, которую проверяет этот тест. Числом, а не «последняя»: смысл теста
// в конкретном переносе данных, и привязка к концу списка ломается на каждой новой
// миграции — ровно так он и сломался на 0039.
const brandingVersion uint = 38

func TestBrandingMigration(t *testing.T) {
	ctx := context.Background()
	dsn, stop, err := pgtest.StartDSN(ctx)
	if err != nil {
		t.Fatalf("поднять Postgres: %v", err)
	}
	defer stop()

	if err := postgres.MigrateUp(dsn); err != nil {
		t.Fatalf("накат: %v", err)
	}
	// Назад — в состояние ДО 0038: колонки нет, намерение снова в документах. Так и
	// получается «база предыдущей версии», в которую можно положить данные старого
	// формата, не выписывая её схему руками.
	//
	// ЦИКЛОМ, А НЕ ОДНИМ ШАГОМ. MigrateDown откатывает ровно одну миграцию, и «шаг
	// назад = до 0038» верно ровно до тех пор, пока 0038 последняя. Первая же
	// следующая миграция (0039) молча увела тест на шаг: он откатывал её, оставался
	// ПОСЛЕ 0038 и падал так, будто перенос бейджа сломался.
	for {
		down, err := postgres.MigrateDown(dsn, nil)
		if err != nil || !down.Applied() {
			t.Fatalf("откат до %d: %v (применён: %v)", brandingVersion, err, down.Applied())
		}
		if down.Version == brandingVersion {
			break
		}
	}

	pool, err := postgres.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("пул: %v", err)
	}
	defer pool.Close()

	// Две формы: у одной автор бейдж снял, у другой — нет. Вторая сторожит обратную
	// ошибку: миграция, снимающая бейдж со всех подряд, тоже «переносит намерение».
	const seed = `
WITH u AS (
  INSERT INTO users (id, email, password_hash) VALUES
    (gen_random_uuid(), 'migr@example.com', 'x') RETURNING id
), w AS (
  INSERT INTO workspaces (id, name, slug) VALUES
    (gen_random_uuid(), 'W', 'w-migr') RETURNING id
)
INSERT INTO forms (id, workspace_id, name, title, slug, draft_schema)
SELECT gen_random_uuid(), w.id, n.name, 'T', n.slug, n.doc::jsonb FROM w, (VALUES
  ('без бейджа', 'f-off', '{"blocks":[],"design":{"branding":false}}'),
  ('бейдж и тема', 'f-mix', '{"blocks":[],"design":{"branding":false,"theme":"dark"}}'),
  ('с бейджем',  'f-on',  '{"blocks":[],"design":{"theme":"dark"}}')
) AS n(name, slug, doc);`
	if _, err := pool.Exec(ctx, seed); err != nil {
		t.Fatalf("сид: %v", err)
	}

	if err := postgres.MigrateUp(dsn); err != nil {
		t.Fatalf("повторный накат (0038): %v", err)
	}

	for _, c := range []struct {
		slug     string
		branding bool
		design   string
	}{
		// Единственный ключ design'а уехал в колонку — пустой объект схлопывается,
		// иначе публикация давала бы два разных документа на одну форму.
		{"f-off", false, ""},
		{"f-mix", false, `{"theme": "dark"}`},
		{"f-on", true, `{"theme": "dark"}`},
	} {
		var branding bool
		var design *string
		err := pool.QueryRow(ctx,
			`SELECT branding, draft_schema -> 'design' FROM forms WHERE slug = $1`, c.slug).
			Scan(&branding, &design)
		if err != nil {
			t.Fatalf("%s: чтение: %v", c.slug, err)
		}
		if branding != c.branding {
			t.Errorf("%s: branding = %v, ожидалось %v", c.slug, branding, c.branding)
		}
		got := ""
		if design != nil {
			got = *design
		}
		if got != c.design {
			t.Errorf("%s: design = %q, ожидалось %q", c.slug, got, c.design)
		}
	}
}
