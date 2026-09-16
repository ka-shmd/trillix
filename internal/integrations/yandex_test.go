package integrations

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// fakeYandexServer — Яндекс ID на httptest-сервере плюс запись того, что ему
// прислали: проверяются и результат, и параметры запроса.
type fakeYandexServer struct {
	tokenForm  url.Values
	authHeader string

	tokenStatus int
	tokenBody   string
	infoBody    string
}

func newFakeYandex(t *testing.T, f *fakeYandexServer) *Yandex {
	t.Helper()
	if f.tokenStatus == 0 {
		f.tokenStatus = http.StatusOK
	}
	if f.tokenBody == "" {
		f.tokenBody = `{"access_token":"ya-at","refresh_token":"ya-rt","expires_in":31536000,"token_type":"bearer"}`
	}
	if f.infoBody == "" {
		f.infoBody = `{"id":"1130000012345678","login":"author","default_email":"author@yandex.ru"}`
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.tokenForm = r.PostForm
		w.WriteHeader(f.tokenStatus)
		_, _ = w.Write([]byte(f.tokenBody))
	})
	mux.HandleFunc("/info", func(w http.ResponseWriter, r *http.Request) {
		f.authHeader = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(f.infoBody))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	y := NewYandex("client-id", "client-secret", "https://app.example/api/v1/integrations/yandex/callback")
	y.tokenURL = srv.URL + "/token"
	y.infoURL = srv.URL + "/info"
	return y
}

// Права в ссылке — ровно три и явно: без scope Яндекс выдал бы токен со всеми
// правами приложения из консоли. force_confirm — всегда: без него «подключить ещё
// один» приходило бы аккаунтом, в котором человек уже вошёл.
func TestYandex_AuthURL(t *testing.T) {
	y := NewYandex("client-id", "secret", "https://app.example/cb")

	u, err := url.Parse(y.AuthURL("state-value", "verifier-value", ""))
	if err != nil {
		t.Fatalf("ссылка не парсится: %v", err)
	}
	if !strings.HasPrefix(u.String(), yandexAuthURL+"?") {
		t.Errorf("ссылка ведёт не на Яндекс ID: %s", u)
	}
	q := u.Query()
	want := map[string]string{
		"response_type":         "code",
		"client_id":             "client-id",
		"redirect_uri":          "https://app.example/cb",
		"state":                 "state-value",
		"scope":                 "login:email metrika:read metrika:write",
		"force_confirm":         "yes",
		"code_challenge_method": "S256",
	}
	for k, v := range want {
		if q.Get(k) != v {
			t.Errorf("%s = %q, ожидалось %q", k, q.Get(k), v)
		}
	}
	if q.Get("code_challenge") == "verifier-value" || q.Get("code_challenge") == "" {
		t.Errorf("code_challenge = %q — verifier не хэширован", q.Get("code_challenge"))
	}
	if q.Has("login_hint") {
		t.Errorf("login_hint = %q без переподключения", q.Get("login_hint"))
	}
}

func TestYandex_AuthURL_ReconnectHint(t *testing.T) {
	y := NewYandex("client-id", "secret", "https://app.example/cb")

	u, _ := url.Parse(y.AuthURL("s", "v", "author@yandex.ru"))
	if got := u.Query().Get("login_hint"); got != "author@yandex.ru" {
		t.Fatalf("login_hint = %q, ожидалась почта переподключаемого аккаунта", got)
	}
}

func TestYandex_Exchange(t *testing.T) {
	f := &fakeYandexServer{}
	y := newFakeYandex(t, f)

	tokens, err := y.Exchange(context.Background(), "auth-code", "verifier")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if tokens.Access != "ya-at" || tokens.Refresh != "ya-rt" {
		t.Errorf("токены = %+v", tokens)
	}
	for k, v := range map[string]string{
		"grant_type":    "authorization_code",
		"code":          "auth-code",
		"code_verifier": "verifier",
		"client_id":     "client-id",
		"client_secret": "client-secret",
	} {
		if f.tokenForm.Get(k) != v {
			t.Errorf("форма обмена: %s = %q, ожидалось %q", k, f.tokenForm.Get(k), v)
		}
	}
}

// Подключение без refresh-токена выглядело бы удачным ровно до истечения access.
func TestYandex_ExchangeWithoutRefresh(t *testing.T) {
	y := newFakeYandex(t, &fakeYandexServer{tokenBody: `{"access_token":"ya-at","expires_in":3600}`})

	if _, err := y.Exchange(context.Background(), "c", "v"); !errors.Is(err, ErrNoRefreshToken) {
		t.Fatalf("err = %v, ожидалось ErrNoRefreshToken", err)
	}
}

// Отозванное в Яндекс ID согласие приходит 400 invalid_grant — это смерть
// подключения, а не «провайдер полежал».
func TestYandex_RefreshInvalidGrant_AccessLost(t *testing.T) {
	y := newFakeYandex(t, &fakeYandexServer{
		tokenStatus: http.StatusBadRequest,
		tokenBody:   `{"error":"invalid_grant","error_description":"expired_token"}`,
	})

	if _, err := y.Refresh(context.Background(), "old-rt"); !errors.Is(err, ErrAccessLost) {
		t.Fatalf("err = %v, ожидалось ErrAccessLost", err)
	}
}

// Яндекс в ответ на обновление отдаёт НОВЫЙ refresh-токен — он обязан доехать до
// сервиса, иначе подключение умрёт, когда Яндекс погасит старый.
func TestYandex_RefreshReturnsRotatedToken(t *testing.T) {
	f := &fakeYandexServer{tokenBody: `{"access_token":"ya-at-2","refresh_token":"ya-rt-2","expires_in":31536000}`}
	y := newFakeYandex(t, f)

	tokens, err := y.Refresh(context.Background(), "ya-rt-1")
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if tokens.Refresh != "ya-rt-2" || tokens.Access != "ya-at-2" {
		t.Fatalf("токены = %+v, ожидался новый refresh", tokens)
	}
	if f.tokenForm.Get("grant_type") != "refresh_token" || f.tokenForm.Get("refresh_token") != "ya-rt-1" {
		t.Errorf("форма обновления = %v", f.tokenForm)
	}
}

// Тело отказа токен-ручки в текст ошибки не уезжает: там могут лежать токены, а
// ошибка идёт в лог.
func TestYandex_TokenErrorDoesNotLeakBody(t *testing.T) {
	y := newFakeYandex(t, &fakeYandexServer{
		tokenStatus: http.StatusInternalServerError,
		tokenBody:   `{"error":"server_error","access_token":"leaked-token-value"}`,
	})

	_, err := y.Refresh(context.Background(), "rt")
	if err == nil {
		t.Fatal("ожидалась ошибка")
	}
	if strings.Contains(err.Error(), "leaked-token-value") {
		t.Fatalf("тело ответа попало в ошибку: %v", err)
	}
}

func TestYandex_Account(t *testing.T) {
	f := &fakeYandexServer{}
	y := newFakeYandex(t, f)

	acc, err := y.Account(context.Background(), "ya-at")
	if err != nil {
		t.Fatalf("Account: %v", err)
	}
	if acc.ID != "1130000012345678" || acc.Email != "author@yandex.ru" {
		t.Errorf("аккаунт = %+v", acc)
	}
	if f.authHeader != "OAuth ya-at" {
		t.Errorf("Authorization = %q, ожидалось «OAuth <токен>»", f.authHeader)
	}
}

// Аккаунт без основного адреса подписывается логином, а не пустой строкой.
func TestYandex_AccountWithoutEmail_UsesLogin(t *testing.T) {
	y := newFakeYandex(t, &fakeYandexServer{infoBody: `{"id":"42","login":"author"}`})

	acc, err := y.Account(context.Background(), "ya-at")
	if err != nil {
		t.Fatalf("Account: %v", err)
	}
	if acc.Email != "author" {
		t.Fatalf("подпись аккаунта = %q, ожидался логин", acc.Email)
	}
}
