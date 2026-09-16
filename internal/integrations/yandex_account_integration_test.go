//go:build integration

package integrations_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/integrations"
)

// Аккаунт Яндекса для счётчика Метрики (фаза 29, design/yandex-metrika.md §13)
// против настоящего Postgres: поход за согласием, строка аккаунта, её место в
// состоянии вкладки и границы отключения. Провайдер подставной — живой Яндекс
// означал бы тест, зелёный только с ключами и интернетом.

// fakeYandex — аккаунтная часть fakeProvider под именем Яндекса.
type fakeYandex struct{ fakeProvider }

func (f *fakeYandex) Provider() string { return integrations.ProviderYandex }

func newFakeYandexProvider() *fakeYandex {
	return &fakeYandex{fakeProvider{accounts: []integrations.Account{{ID: "ya-1", Email: "author@yandex.ru"}}}}
}

// connectYandex проходит поход за согласием Яндекса и отдаёт id аккаунта.
func connectYandex(t *testing.T, c *http.Client, srv *httptest.Server) string {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/integrations/yandex/start")
	if r.StatusCode != http.StatusFound {
		closeBody(t, r)
		t.Fatalf("start: статус %d, ожидалось 302", r.StatusCode)
	}
	loc, err := url.Parse(r.Header.Get("Location"))
	closeBody(t, r)
	if err != nil || loc.Query().Get("state") == "" {
		t.Fatalf("start: state не уехал к провайдеру (%v)", err)
	}
	r = do(t, c, http.MethodGet,
		srv.URL+"/api/v1/integrations/yandex/callback?code=auth-code&state="+loc.Query().Get("state"))
	assertOutcome(t, r, "integration_ok")

	var id string
	if err := testPool.QueryRow(context.Background(),
		`SELECT id FROM integration_accounts WHERE provider = 'yandex'
		 ORDER BY connected_at DESC, id DESC LIMIT 1`).Scan(&id); err != nil {
		t.Fatalf("аккаунт Яндекса не записан: %v", err)
	}
	return id
}

func accountsLeft(t *testing.T, id string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM integration_accounts WHERE id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

// Аккаунт Яндекса записан своим провайдером, токен лежит шифротекстом, и в
// состоянии вкладки он приходит в `yandex`, а не в списке Google — и наоборот.
func TestYandexAccount_ConnectSeparateFromGoogle(t *testing.T) {
	resetDB(t)
	srv := newStackWith(t, &fakeProvider{}, newFakeYandexProvider(), testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	connectAccount(t, owner, srv)
	yandexID := connectYandex(t, owner, srv)

	var sealed []byte
	var provider, email string
	if err := testPool.QueryRow(context.Background(),
		`SELECT refresh_token, provider, external_email FROM integration_accounts WHERE id = $1`,
		yandexID).Scan(&sealed, &provider, &email); err != nil {
		t.Fatalf("строка аккаунта: %v", err)
	}
	if provider != integrations.ProviderYandex || email != "author@yandex.ru" {
		t.Errorf("строка = %q/%q", provider, email)
	}
	if strings.Contains(string(sealed), testRefreshToken) {
		t.Fatal("refresh-токен Яндекса лежит в базе открытым текстом")
	}

	got := formStatus(t, owner, srv, newForm(t, wsID, "f-yandex"))
	if !got.Yandex.Enabled || len(got.Yandex.Accounts) != 1 || got.Yandex.Accounts[0].Email != "author@yandex.ru" {
		t.Fatalf("yandex = %+v, ожидался ровно аккаунт Яндекса", got.Yandex)
	}
	if len(got.Account.Accounts) != 1 || got.Account.Accounts[0].Email != "author@gmail.com" {
		t.Fatalf("account (Google) = %+v — списки провайдеров смешались", got.Account)
	}
}

// Ручка отключения Яндекса удаляет только СВОЙ аккаунт Яндекса: аккаунт Google по
// тому же адресу и чужой аккаунт Яндекса остаются на месте — 204 по
// идемпотентности, чтобы отказ не подтверждал существование чужого.
func TestYandexAccount_DisconnectOnlyOwnYandex(t *testing.T) {
	resetDB(t)
	srv := newStackWith(t, &fakeProvider{}, newFakeYandexProvider(), testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	personalWorkspace(t)
	stranger := registerUser(t, srv, "stranger@example.com")

	googleID := connectAccount(t, owner, srv)
	strangerYandex := connectYandex(t, stranger, srv)
	ownYandex := connectYandex(t, owner, srv)

	for name, id := range map[string]string{"Google по адресу Яндекса": googleID, "чужой Яндекс": strangerYandex} {
		r := deleteWithCSRF(t, owner, srv, "/api/v1/integrations/yandex/accounts/"+id)
		if r.StatusCode != http.StatusNoContent {
			t.Fatalf("%s: статус %d, ожидалось 204", name, r.StatusCode)
		}
		closeBody(t, r)
		if accountsLeft(t, id) != 1 {
			t.Fatalf("%s: аккаунт удалён", name)
		}
	}

	r := deleteWithCSRF(t, owner, srv, "/api/v1/integrations/yandex/accounts/"+ownYandex)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("свой Яндекс: статус %d, ожидалось 204", r.StatusCode)
	}
	closeBody(t, r)
	if accountsLeft(t, ownYandex) != 0 {
		t.Fatal("свой аккаунт Яндекса не отключён")
	}
}

// Переподключение по id чужого провайдера — отказ: подсказка несёт почту, и
// аккаунт Google не должен отдавать её через поход Яндекса.
func TestYandexAccount_ReconnectHintOnlyForOwnYandex(t *testing.T) {
	resetDB(t)
	srv := newStackWith(t, &fakeProvider{}, newFakeYandexProvider(), testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	personalWorkspace(t)

	googleID := connectAccount(t, owner, srv)

	r := do(t, owner, http.MethodGet, srv.URL+"/api/v1/integrations/yandex/start?accountId="+googleID)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("переподключение Google через Яндекс: статус %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)
}

// Контур без приложения Яндекса: подключения аккаунта нет, вкладка честно говорит
// «не настроено», Google при этом работает.
func TestYandexAccount_NotConfigured(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	r := do(t, owner, http.MethodGet, srv.URL+"/api/v1/integrations/yandex/start")
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("start без приложения: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)

	got := formStatus(t, owner, srv, newForm(t, wsID, "f-no-yandex"))
	if got.Yandex.Enabled || len(got.Yandex.Accounts) != 0 {
		t.Fatalf("yandex = %+v, ожидалось «не настроено»", got.Yandex)
	}
	if !got.Account.Enabled {
		t.Fatal("Google выключился вместе с Яндексом")
	}
}
