package integrations

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// fakeGoogle — подставной провайдер: готовый *Google, направленный на
// httptest-сервер, плюс запись того, что он получил. Проверять надо не только
// результат, но и параметры запроса: без access_type=offline подключение
// выглядит удачным ровно час, а потом молча умирает.
type fakeGoogle struct {
	tokenForm  url.Values
	authHeader string
	revokeForm url.Values

	sheetsBody  string
	valuesURL   string
	valuesBody  string
	valuesToken string

	tokenStatus int
	tokenBody   string
	infoStatus  int
	infoBody    string
}

func newFakeGoogle(t *testing.T, f *fakeGoogle) *Google {
	t.Helper()
	if f.tokenStatus == 0 {
		f.tokenStatus = http.StatusOK
	}
	if f.infoStatus == 0 {
		f.infoStatus = http.StatusOK
	}
	if f.tokenBody == "" {
		f.tokenBody = `{"access_token":"at","refresh_token":"rt","expires_in":3599,` +
			`"scope":"openid email https://www.googleapis.com/auth/drive.file"}`
	}
	if f.infoBody == "" {
		f.infoBody = `{"sub":"11223344","email":"author@gmail.com"}`
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.tokenForm = r.PostForm
		w.WriteHeader(f.tokenStatus)
		_, _ = w.Write([]byte(f.tokenBody))
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		f.authHeader = r.Header.Get("Authorization")
		w.WriteHeader(f.infoStatus)
		_, _ = w.Write([]byte(f.infoBody))
	})
	mux.HandleFunc("POST /sheets", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.sheetsBody = string(body)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"spreadsheetId":"ss-1",` +
			`"spreadsheetUrl":"https://docs.google.com/spreadsheets/d/ss-1/edit",` +
			`"sheets":[{"properties":{"sheetId":42,"title":"Ответы"}}]}`))
	})
	mux.HandleFunc("PUT /sheets/{id}/values/{rng}", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.valuesBody = string(body)
		f.valuesURL = r.URL.String()
		f.valuesToken = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	})
	mux.HandleFunc("/revoke", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.revokeForm = r.PostForm
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	g := NewGoogle("client-id", "client-secret", "https://app.example/api/v1/integrations/google/callback")
	g.tokenURL = srv.URL + "/token"
	g.userInfoURL = srv.URL + "/userinfo"
	g.revokeURL = srv.URL + "/revoke"
	g.sheetsURL = srv.URL + "/sheets"
	return g
}

// Ссылка согласия несёт offline+consent и оба scope. Проверка не косметическая:
// потеря access_type=offline даёт подключение без refresh-токена, а потеря
// drive.file — подключение, которым нельзя создать таблицу.
func TestGoogle_AuthURL(t *testing.T) {
	g := NewGoogle("client-id", "secret", "https://app.example/cb")

	raw := g.AuthURL("state-value", "verifier-value")
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("ссылка не парсится: %v", err)
	}
	q := u.Query()

	want := map[string]string{
		"response_type":         "code",
		"client_id":             "client-id",
		"redirect_uri":          "https://app.example/cb",
		"state":                 "state-value",
		"access_type":           "offline",
		"prompt":                "consent",
		"code_challenge_method": "S256",
	}
	for k, v := range want {
		if q.Get(k) != v {
			t.Errorf("%s = %q, ожидалось %q", k, q.Get(k), v)
		}
	}
	if !strings.Contains(q.Get("scope"), ScopeDriveFile) {
		t.Errorf("scope = %q, ожидался drive.file", q.Get("scope"))
	}
	// PKCE: в ссылку уезжает ХЭШ verifier'а, а не он сам.
	if q.Get("code_challenge") == "verifier-value" || q.Get("code_challenge") == "" {
		t.Errorf("code_challenge = %q — verifier не хэширован", q.Get("code_challenge"))
	}
}

func TestGoogle_ExchangeAndAccount(t *testing.T) {
	f := &fakeGoogle{}
	g := newFakeGoogle(t, f)

	tokens, err := g.Exchange(context.Background(), "auth-code", "verifier")
	if err != nil {
		t.Fatalf("exchange: %v", err)
	}
	if tokens.Access != "at" || tokens.Refresh != "rt" {
		t.Fatalf("токены = %+v, ожидались at/rt", tokens)
	}
	if f.tokenForm.Get("code_verifier") != "verifier" || f.tokenForm.Get("grant_type") != "authorization_code" {
		t.Errorf("форма обмена = %v", f.tokenForm)
	}

	acc, err := g.Account(context.Background(), tokens.Access)
	if err != nil {
		t.Fatalf("account: %v", err)
	}
	if acc.ID != "11223344" || acc.Email != "author@gmail.com" {
		t.Fatalf("аккаунт = %+v", acc)
	}
	// Токен уезжает заголовком, а не параметром адреса: иначе он осел бы в
	// логах прокси.
	if f.authHeader != "Bearer at" {
		t.Errorf("Authorization = %q, ожидалось «Bearer at»", f.authHeader)
	}
}

// Человек снял галочку доступа к Диску — это не сбой, а осмысленный исход с
// человеческим текстом на экране.
func TestGoogle_Exchange_ScopeDenied(t *testing.T) {
	g := newFakeGoogle(t, &fakeGoogle{
		tokenBody: `{"access_token":"at","refresh_token":"rt","scope":"openid email"}`,
	})

	_, err := g.Exchange(context.Background(), "code", "verifier")
	if !errors.Is(err, ErrScopeDenied) {
		t.Fatalf("ошибка = %v, ожидалась ErrScopeDenied", err)
	}
}

// Подключение без refresh-токена живёт ровно час и умирает молча — поэтому оно
// отвергается сразу, а не сохраняется «как есть».
func TestGoogle_Exchange_NoRefreshToken(t *testing.T) {
	g := newFakeGoogle(t, &fakeGoogle{
		tokenBody: `{"access_token":"at","scope":"openid email ` + ScopeDriveFile + `"}`,
	})

	_, err := g.Exchange(context.Background(), "code", "verifier")
	if !errors.Is(err, ErrNoRefreshToken) {
		t.Fatalf("ошибка = %v, ожидалась ErrNoRefreshToken", err)
	}
}

func TestGoogle_Revoke(t *testing.T) {
	f := &fakeGoogle{}
	g := newFakeGoogle(t, f)

	if err := g.Revoke(context.Background(), "rt"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if f.revokeForm.Get("token") != "rt" {
		t.Errorf("форма отзыва = %v, ожидался token=rt", f.revokeForm)
	}
}

// Провайдер лежит — наверх едет ошибка, а не пустые токены. Тело ответа при
// этом наружу не отдаётся: в нём бывают токены.
func TestGoogle_Exchange_ProviderDown(t *testing.T) {
	g := newFakeGoogle(t, &fakeGoogle{
		tokenStatus: http.StatusBadGateway,
		tokenBody:   `{"error":"secret-ish"}`,
	})

	_, err := g.Exchange(context.Background(), "code", "verifier")
	if err == nil {
		t.Fatal("ошибка провайдера проглочена")
	}
	if strings.Contains(err.Error(), "secret-ish") {
		t.Fatalf("тело ответа провайдера утекло в ошибку: %v", err)
	}
}

func TestHasScope(t *testing.T) {
	cases := []struct {
		granted string
		want    bool
	}{
		{"openid email " + ScopeDriveFile, true},
		{ScopeDriveFile, true},
		{"openid email", false},
		{"", false},
		// Префикс — не совпадение: поиск подстрокой дал бы здесь ложное «да».
		{ScopeDriveFile + ".readonly", false},
	}
	for _, c := range cases {
		if got := HasScope(c.granted, ScopeDriveFile); got != c.want {
			t.Errorf("HasScope(%q) = %v, ожидалось %v", c.granted, got, c.want)
		}
	}
}

// Таблица заводится с нужным именем и листом, а из ответа берётся gid — не имя:
// имя автор волен переименовать, gid нет.
func TestGoogle_CreateSpreadsheet(t *testing.T) {
	f := &fakeGoogle{}
	g := newFakeGoogle(t, f)

	sheet, err := g.CreateSpreadsheet(context.Background(), "at", "Опрос — ответы", "Ответы")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if sheet.ID != "ss-1" || sheet.SheetID != 42 || sheet.Title != "Ответы" {
		t.Fatalf("таблица = %+v", sheet)
	}
	if !strings.Contains(f.sheetsBody, `"title":"Опрос — ответы"`) {
		t.Errorf("тело создания = %s", f.sheetsBody)
	}
}

// Шапка кладётся режимом RAW: USER_ENTERED исполнил бы «=…» из подписи вопроса
// формулой в чужой таблице. Это безопасность, а не оптимизация.
func TestGoogle_WriteHeader(t *testing.T) {
	f := &fakeGoogle{}
	g := newFakeGoogle(t, f)

	sheet := Spreadsheet{ID: "ss-1", SheetID: 42, Title: "Ответы"}
	if err := g.WriteHeader(context.Background(), "at", sheet, []string{"ID ответа", "=не формула"}); err != nil {
		t.Fatalf("write header: %v", err)
	}

	if !strings.Contains(f.valuesURL, "valueInputOption=RAW") {
		t.Errorf("адрес записи = %q, ожидался RAW", f.valuesURL)
	}
	if !strings.Contains(f.valuesURL, url.PathEscape(a1Range("Ответы", "A1"))) {
		t.Errorf("адрес записи = %q, ожидался диапазон листа", f.valuesURL)
	}
	if !strings.Contains(f.valuesBody, `"=не формула"`) {
		t.Errorf("тело записи = %s", f.valuesBody)
	}
	if f.valuesToken != "Bearer at" {
		t.Errorf("Authorization = %q", f.valuesToken)
	}
}

// Имя листа с апострофом не ломает адрес диапазона: A1-нотация требует его
// удвоения, и правило соблюдается там, где адрес строится.
func TestA1Range_EscapesApostrophe(t *testing.T) {
	want := "'Ответы ''за март'''" + "!A1"
	if got := a1Range("Ответы 'за март'", "A1"); got != want {
		t.Fatalf("диапазон = %q, ожидался %q", got, want)
	}
}
