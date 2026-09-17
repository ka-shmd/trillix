//go:build integration

package legal_test

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/legal"
	"github.com/ka-shmd/trillix/internal/pgtest"
)

// Протокол согласия из раннбука (deploy/sql/consent-protocol.sql) исполняется против
// настоящей схемы: правка таблиц, ломающая запрос, краснеет здесь, а не в день спора.
// Переменная psql :'email' подменяется параметром — остальной текст запроса тот же.
func protocolQueries(t *testing.T) []string {
	t.Helper()
	raw, err := os.ReadFile("../../deploy/sql/consent-protocol.sql")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, stmt := range strings.Split(string(raw), ";\n") {
		if strings.Contains(stmt, "SELECT") {
			out = append(out, strings.ReplaceAll(stmt, ":'email'", "$1"))
		}
	}
	if len(out) != 2 {
		t.Fatalf("в протоколе %d запросов, ожидалось 2", len(out))
	}
	return out
}

func TestConsentProtocol(t *testing.T) {
	resetDB(t)
	ctx := context.Background()
	eds, err := legal.Editions()
	if err != nil {
		t.Fatal(err)
	}
	st := newConsentStack(t, eds...)
	c := newHTTPClient(t, st.srv.URL)
	const email = "protocol@example.com"
	c.register(email)
	pgtest.CompleteSignup(t, testPool, email)
	queries := protocolQueries(t)

	var events int
	rows, err := testPool.Query(ctx, queries[0], "PROTOCOL@example.com")
	if err != nil {
		t.Fatalf("события: %v", err)
	}
	for rows.Next() {
		events++
	}
	rows.Close()
	if rows.Err() != nil || events != 1 {
		t.Fatalf("событий %d, err = %v", events, rows.Err())
	}

	intact := func() bool {
		t.Helper()
		var kind, version, sha, body string
		var effective any
		var ok bool
		if err := testPool.QueryRow(ctx, queries[1], email).Scan(&kind, &version, &effective, &sha, &ok, &body); err != nil {
			t.Fatalf("тексты: %v", err)
		}
		if kind != "terms" || body == "" {
			t.Fatalf("редакция %s %s без текста", kind, version)
		}
		return ok
	}
	if !intact() {
		t.Fatal("отпечаток редакции, записанной API, не сошёлся с текстом")
	}
	if _, err := testPool.Exec(ctx, `UPDATE legal_documents SET body = body || ' ' WHERE kind = 'terms'`); err != nil {
		t.Fatal(err)
	}
	if intact() {
		t.Fatal("правка текста мимо API не видна в «текст цел»")
	}
}
