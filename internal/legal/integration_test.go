//go:build integration

// Интеграционный тест документов против настоящего Postgres: сверка реестра с базой при
// старте и публичная выдача. Проверяется то, что живёт в схеме и в SQL: неизменность
// опубликованной редакции, выбор действующей по дате вступления, скрытие будущей.
package legal_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/legal"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	pool, stop, err := pgtest.Start(ctx)
	if err != nil {
		panic(err)
	}
	testPool = pool
	code := m.Run()
	stop()
	os.Exit(code)
}

func resetDB(t *testing.T) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(), `TRUNCATE users, legal_documents CASCADE`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

var (
	msk   = time.FixedZone("MSK", 3*60*60)
	clock = time.Date(2026, 9, 20, 12, 0, 0, 0, msk)
)

func fixedNow() time.Time { return clock }

func edition(kind legal.Kind, version, body string, effective time.Time, draft bool) legal.Edition {
	return legal.Edition{
		Kind: kind, Version: version, Title: "Заголовок " + version, Body: body,
		SHA256: "sha-" + body, EffectiveAt: effective, Draft: draft,
	}
}

func day(y int, m time.Month, d int) time.Time { return time.Date(y, m, d, 0, 0, 0, 0, msk) }

func newService(eds ...legal.Edition) *legal.Service {
	return legal.NewService(testPool, postgres.TxRunner{Pool: testPool}, legal.Repo{}, newAuthService(), eds, fixedNow)
}

func newAuthService() *auth.Service {
	return auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
}

func TestSync(t *testing.T) {
	ctx := context.Background()

	t.Run("заводит редакции и повторно ничего не меняет", func(t *testing.T) {
		resetDB(t)
		svc := newService(
			edition(legal.KindTerms, "2026-09-01", "текст", day(2026, 9, 1), false),
			edition(legal.KindPrivacy, "2026-09-01", "политика", day(2026, 9, 1), true),
		)
		res, err := svc.Sync(ctx)
		if err != nil || res.Inserted != 2 || res.Rewritten != 0 {
			t.Fatalf("первый Sync = %+v, %v", res, err)
		}
		res, err = svc.Sync(ctx)
		if err != nil || res.Inserted != 0 || res.Rewritten != 0 {
			t.Fatalf("второй Sync = %+v, %v", res, err)
		}
	})

	t.Run("черновик перезаписывается и публикуется", func(t *testing.T) {
		resetDB(t)
		if _, err := newService(edition(legal.KindTerms, "2026-09-01", "черновик", day(2026, 9, 1), true)).Sync(ctx); err != nil {
			t.Fatal(err)
		}
		res, err := newService(edition(legal.KindTerms, "2026-09-01", "поправленный", day(2026, 9, 1), true)).Sync(ctx)
		if err != nil || res.Rewritten != 1 {
			t.Fatalf("правка черновика = %+v, %v", res, err)
		}
		res, err = newService(edition(legal.KindTerms, "2026-09-01", "поправленный", day(2026, 9, 1), false)).Sync(ctx)
		if err != nil || res.Rewritten != 1 {
			t.Fatalf("публикация черновика = %+v, %v", res, err)
		}
		ed, _, err := newService().Document(ctx, legal.KindTerms, "2026-09-01")
		if err != nil || ed.Body != "поправленный" || ed.Draft {
			t.Fatalf("после публикации: %+v, %v", ed, err)
		}
	})

	published := edition(legal.KindTerms, "2026-09-01", "опубликовано", day(2026, 9, 1), false)
	changed := func(mut func(*legal.Edition)) legal.Edition {
		e := published
		mut(&e)
		return e
	}
	refusals := []struct {
		name string
		want legal.Edition
		what string
	}{
		{"текст", changed(func(e *legal.Edition) { e.Body, e.SHA256 = "исправлено", "sha-исправлено" }), "текст"},
		{"заголовок", changed(func(e *legal.Edition) { e.Title = "Другой" }), "заголовок"},
		{"дата вступления", changed(func(e *legal.Edition) { e.EffectiveAt = day(2026, 9, 2) }), "дата вступления в силу"},
		{"повторное принятие", changed(func(e *legal.Edition) { e.RequiresReacceptance = true }), "повторное принятие"},
		{"обратно в черновик", changed(func(e *legal.Edition) { e.Draft = true }), "черновик"},
	}
	for _, tc := range refusals {
		t.Run("опубликованная не меняется: "+tc.name, func(t *testing.T) {
			resetDB(t)
			if _, err := newService(published).Sync(ctx); err != nil {
				t.Fatal(err)
			}
			_, err := newService(tc.want).Sync(ctx)
			if err == nil {
				t.Fatal("Sync принял правку опубликованной редакции")
			}
			for _, part := range []string{"terms", "2026-09-01", tc.what} {
				if !strings.Contains(err.Error(), part) {
					t.Errorf("сообщение %q не называет %q", err, part)
				}
			}
			ed, _, err := newService().Document(ctx, legal.KindTerms, "2026-09-01")
			if err != nil || ed.Body != "опубликовано" || ed.Title != published.Title {
				t.Fatalf("редакция в базе изменилась: %+v, %v", ed, err)
			}
		})
	}

	t.Run("реестр репозитория ложится в базу", func(t *testing.T) {
		resetDB(t)
		eds, err := legal.Editions()
		if err != nil {
			t.Fatal(err)
		}
		svc := legal.NewService(testPool, postgres.TxRunner{Pool: testPool}, legal.Repo{}, newAuthService(), eds, time.Now)
		if _, err := svc.Sync(ctx); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.Sync(ctx); err != nil {
			t.Fatalf("повторный Sync реестра: %v", err)
		}
	})
}

type summaryDTO struct {
	Kind        string    `json:"kind"`
	Title       string    `json:"title"`
	Version     string    `json:"version"`
	EffectiveAt time.Time `json:"effectiveAt"`
}

type documentDTO struct {
	summaryDTO
	Text     string `json:"text"`
	Versions []struct {
		Version     string    `json:"version"`
		EffectiveAt time.Time `json:"effectiveAt"`
	} `json:"versions"`
}

// noSession — заглушка middleware для стека публичных ручек: ручки согласий в нём не
// вызываются, их проверяет consent_integration_test.go с настоящей сессией.
func noSession(http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
}

func get(t *testing.T, srv *httptest.Server, path string, out any) int {
	t.Helper()
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK && out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func TestPublicDocuments(t *testing.T) {
	resetDB(t)
	ctx := context.Background()
	svc := newService(
		edition(legal.KindTerms, "2026-08-01", "первая", day(2026, 8, 1), false),
		edition(legal.KindTerms, "2026-09-10", "вторая", day(2026, 9, 10), false),
		// Будущая: опубликована заранее, но в силу ещё не вступила (часы — 20 сентября).
		edition(legal.KindTerms, "2026-09-15", "будущая", day(2026, 10, 1), false),
		edition(legal.KindPrivacy, "2026-08-01", "политика", day(2026, 8, 1), false),
	)
	if _, err := svc.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	legal.NewHandler(svc, noSession, noSession).Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	t.Run("список — действующие редакции", func(t *testing.T) {
		var body struct {
			Items []summaryDTO `json:"items"`
		}
		if code := get(t, srv, "/api/v1/legal/documents", &body); code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
		got := map[string]string{}
		for _, it := range body.Items {
			got[it.Kind] = it.Version
		}
		if len(got) != 2 || got["terms"] != "2026-09-10" || got["privacy"] != "2026-08-01" {
			t.Fatalf("items = %+v", body.Items)
		}
	})

	t.Run("документ без версии — действующий, архив без будущей", func(t *testing.T) {
		var doc documentDTO
		if code := get(t, srv, "/api/v1/legal/documents/terms", &doc); code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
		if doc.Version != "2026-09-10" || doc.Text != "вторая" || doc.Title != "Заголовок 2026-09-10" {
			t.Fatalf("doc = %+v", doc)
		}
		if len(doc.Versions) != 2 || doc.Versions[0].Version != "2026-09-10" || doc.Versions[1].Version != "2026-08-01" {
			t.Fatalf("versions = %+v", doc.Versions)
		}
	})

	t.Run("прошлая редакция по версии", func(t *testing.T) {
		var doc documentDTO
		if code := get(t, srv, "/api/v1/legal/documents/terms?version=2026-08-01", &doc); code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
		if doc.Text != "первая" || !doc.EffectiveAt.Equal(day(2026, 8, 1)) {
			t.Fatalf("doc = %+v", doc)
		}
	})

	for _, path := range []string{
		"/api/v1/legal/documents/offer",
		"/api/v1/legal/documents/terms?version=latest",
		"/api/v1/legal/documents/terms?version=2026-01-01",
		"/api/v1/legal/documents/terms?version=2026-09-15",
		"/api/v1/legal/documents/marketing",
	} {
		t.Run("404 "+path, func(t *testing.T) {
			if code := get(t, srv, path, nil); code != http.StatusNotFound {
				t.Fatalf("status %d, want 404", code)
			}
		})
	}
}
