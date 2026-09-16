//go:build integration

// Снятие типа блока `consent` (0068).
//
// Отдельным тестом, а не строкой в roundtrip: тот проверяет обратимость на пустой базе и
// данных не видит. Здесь — единственное, ради чего миграция написана: блок согласия уходит
// из всех трёх мест, где лежат документы, а соседние блоки остаются на своих местах. Ошибка
// молчалива в обе стороны: оставленный блок роняет публичную форму в 500, а стёртый чужой
// блок — ответы, которые на него ссылаются.
package migrations_test

import (
	"context"
	"testing"

	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
)

const consentBlockVersion uint = 68

func TestConsentBlockMigration(t *testing.T) {
	ctx := context.Background()
	dsn, stop, err := pgtest.StartDSN(ctx)
	if err != nil {
		t.Fatalf("поднять Postgres: %v", err)
	}
	defer stop()

	if err := postgres.MigrateUp(dsn); err != nil {
		t.Fatalf("накат: %v", err)
	}
	// Назад — в состояние до 0068 циклом, а не одним шагом: следующая миграция иначе
	// молча увела бы тест на шаг (см. branding_test.go).
	for {
		down, err := postgres.MigrateDown(dsn, nil)
		if err != nil || !down.Applied() {
			t.Fatalf("откат до %d: %v (применён: %v)", consentBlockVersion, err, down.Applied())
		}
		if down.Version == consentBlockVersion {
			break
		}
	}

	pool, err := postgres.NewPool(ctx, dsn)
	if err != nil {
		t.Fatalf("пул: %v", err)
	}
	defer pool.Close()

	// Документ с согласием посередине и форма без него: вторая сторожит обратную ошибку —
	// миграция, переписывающая все документы подряд, тоже «снимает согласие».
	const withConsent = `{"blocks":[
  {"id":"t1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},
  {"id":"b1","groupId":"g_b1","type":"short_text","settings":{}},
  {"id":"c1","groupId":"g_c1","type":"consent","text":[{"t":"Согласен"}],"required":true,"settings":{}},
  {"id":"b2","groupId":"g_b2","type":"email","settings":{}}
],"submitLabel":"Готово"}`
	const plain = `{"blocks":[{"id":"b1","groupId":"g_b1","type":"short_text","settings":{}}]}`

	seed := `
WITH w AS (
  INSERT INTO workspaces (id, name, slug) VALUES
    (gen_random_uuid(), 'W', 'w-consent') RETURNING id
)
INSERT INTO forms (id, workspace_id, name, title, slug, draft_schema)
SELECT gen_random_uuid(), w.id, n.name, 'T', n.slug, n.doc::jsonb FROM w, (VALUES
  ('с согласием', 'f-consent', $1),
  ('без согласия', 'f-plain', $2)
) AS n(name, slug, doc);`
	if _, err := pool.Exec(ctx, seed, withConsent, plain); err != nil {
		t.Fatalf("сид форм: %v", err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO form_versions (id, form_id, version, schema)
SELECT gen_random_uuid(), id, 1, $1::jsonb FROM forms WHERE slug = 'f-consent'`, withConsent); err != nil {
		t.Fatalf("сид версии: %v", err)
	}
	if _, err := pool.Exec(ctx, `
INSERT INTO form_templates (id, title, schema, visibility)
VALUES (gen_random_uuid(), 'Заявка', $1::jsonb, 'public')`, withConsent); err != nil {
		t.Fatalf("сид шаблона: %v", err)
	}

	if err := postgres.MigrateUp(dsn); err != nil {
		t.Fatalf("повторный накат (0068): %v", err)
	}

	const wantIDs = `["t1", "b1", "b2"]`
	for _, c := range []struct {
		name, query, want string
	}{
		{"черновик", `SELECT draft_schema FROM forms WHERE slug = 'f-consent'`, wantIDs},
		{"версия", `SELECT v.schema FROM form_versions v JOIN forms f ON f.id = v.form_id WHERE f.slug = 'f-consent'`, wantIDs},
		{"шаблон", `SELECT schema FROM form_templates`, wantIDs},
		{"форма без согласия", `SELECT draft_schema FROM forms WHERE slug = 'f-plain'`, `["b1"]`},
	} {
		var ids string
		err := pool.QueryRow(ctx, `
SELECT jsonb_agg(b -> 'id' ORDER BY ord)::text
  FROM (`+c.query+`) AS d(doc),
       jsonb_array_elements(d.doc -> 'blocks') WITH ORDINALITY AS t(b, ord)`).Scan(&ids)
		if err != nil {
			t.Fatalf("%s: чтение: %v", c.name, err)
		}
		if ids != c.want {
			t.Errorf("%s: блоки = %s, ожидалось %s", c.name, ids, c.want)
		}
	}

	// Поля документа вне blocks переживают переписывание: jsonb_set меняет только блоки.
	var label string
	if err := pool.QueryRow(ctx,
		`SELECT draft_schema ->> 'submitLabel' FROM forms WHERE slug = 'f-consent'`).Scan(&label); err != nil {
		t.Fatalf("submitLabel: %v", err)
	}
	if label != "Готово" {
		t.Errorf("submitLabel = %q, ожидалось «Готово»", label)
	}
}
