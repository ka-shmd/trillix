//go:build integration

// Снятие системного шрифта из документов оформления (0054).
//
// Отдельным тестом, а не строкой в roundtrip: тот проверяет ОБРАТИМОСТЬ на пустой базе
// и данных не видит вовсе. Здесь проверяется единственное, ради чего миграция написана:
// после неё в документах не остаётся значения, которого каталог шрифтов больше не
// принимает. Пропущенный документ молчит до первого читателя — черновик перестанет
// сохраняться, снапшот не разберётся у респондента.
package migrations_test

import (
	"context"
	"testing"

	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Версия миграции, которую проверяет этот тест. Числом, а не «последняя»: смысл теста
// в конкретной чистке данных, и привязка к концу списка ломается на каждой новой
// миграции.
const designFontVersion uint = 54

func TestDesignFontSystemMigration(t *testing.T) {
	ctx := context.Background()
	dsn, stop, err := pgtest.StartDSN(ctx)
	if err != nil {
		t.Fatalf("поднять Postgres: %v", err)
	}
	defer stop()

	if err := postgres.MigrateUp(dsn); err != nil {
		t.Fatalf("накат: %v", err)
	}
	// Назад — в состояние ДО 0054, чтобы положить документы старого формата, не
	// выписывая схему той версии руками. Циклом, а не одним шагом: MigrateDown
	// откатывает ровно одну миграцию, и «шаг назад = до 0054» верно лишь пока она
	// последняя (на этом сломался брат этого теста, см. branding_test.go).
	for {
		down, err := postgres.MigrateDown(dsn, nil)
		if err != nil || !down.Applied() {
			t.Fatalf("откат до %d: %v (применён: %v)", designFontVersion, err, down.Applied())
		}
		if down.Version == designFontVersion {
			break
		}
	}

	pool, err := postgres.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("пул: %v", err)
	}
	defer pool.Close()

	// Четыре черновика: системный шрифт единственной настройкой (design схлопывается),
	// он же рядом с темой (уходит только ключ font), другое семейство и форма без
	// оформления вовсе. Последние два сторожат обратную ошибку: миграция, стирающая
	// шрифт у всех подряд, тоже «убирает системный».
	const seed = `
WITH u AS (
  INSERT INTO users (id, email, password_hash) VALUES
    (gen_random_uuid(), 'font@example.com', 'x') RETURNING id
), w AS (
  INSERT INTO workspaces (id, name, slug) VALUES
    (gen_random_uuid(), 'W', 'w-font') RETURNING id
)
INSERT INTO forms (id, workspace_id, name, title, slug, draft_schema)
SELECT gen_random_uuid(), w.id, n.name, 'T', n.slug, n.doc::jsonb FROM w, (VALUES
  ('только шрифт',  'f-sys',   '{"blocks":[],"design":{"font":"system"}}'),
  ('шрифт и тема',  'f-mix',   '{"blocks":[],"design":{"font":"system","theme":"dark"}}'),
  ('другой шрифт',  'f-lora',  '{"blocks":[],"design":{"font":"lora"}}'),
  ('без оформления','f-plain', '{"blocks":[]}')
) AS n(name, slug, doc);

-- Снапшот: чистится вместе с черновиком, иначе опубликованная форма не разберётся.
INSERT INTO form_versions (id, form_id, version, schema)
SELECT gen_random_uuid(), id, 1, '{"blocks":[],"design":{"font":"system","theme":"dark"}}'::jsonb
  FROM forms WHERE slug = 'f-mix';`
	if _, err := pool.Exec(ctx, seed); err != nil {
		t.Fatalf("сид: %v", err)
	}

	if err := postgres.MigrateUp(dsn); err != nil {
		t.Fatalf("повторный накат (0054): %v", err)
	}

	for _, c := range []struct {
		slug   string
		design string
	}{
		// Единственная настройка ушла — пустой объект схлопывается, иначе публикация
		// давала бы два разных документа на одну форму.
		{"f-sys", ""},
		{"f-mix", `{"theme": "dark"}`},
		{"f-lora", `{"font": "lora"}`},
		{"f-plain", ""},
	} {
		var design *string
		err := pool.QueryRow(ctx,
			`SELECT draft_schema -> 'design' FROM forms WHERE slug = $1`, c.slug).Scan(&design)
		if err != nil {
			t.Fatalf("%s: чтение: %v", c.slug, err)
		}
		got := ""
		if design != nil {
			got = *design
		}
		if got != c.design {
			t.Errorf("%s: design = %q, ожидалось %q", c.slug, got, c.design)
		}
	}

	var snapshot string
	err = pool.QueryRow(ctx, `
SELECT v.schema -> 'design' FROM form_versions v
  JOIN forms f ON f.id = v.form_id WHERE f.slug = 'f-mix'`).Scan(&snapshot)
	if err != nil {
		t.Fatalf("снапшот: чтение: %v", err)
	}
	if snapshot != `{"theme": "dark"}` {
		t.Errorf("снапшот: design = %q, ожидалось %q", snapshot, `{"theme": "dark"}`)
	}
}
