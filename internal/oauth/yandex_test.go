package oauth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// fakeYandex — подставной провайдер. Возвращает готового Yandex, направленного
// на httptest-сервер, и запись того, что он получил, — проверять надо не только
// результат, но и параметры запроса (PKCE, redirect_uri).
type fakeYandex struct {
	tokenForm  url.Values
	authHeader string

	tokenStatus int
	tokenBody   string
	infoStatus  int
	infoBody    string
}

func newFake(t *testing.T, f *fakeYandex) *Yandex {
	t.Helper()
	if f.tokenStatus == 0 {
		f.tokenStatus = http.StatusOK
	}
	if f.infoStatus == 0 {
		f.infoStatus = http.StatusOK
	}
	if f.tokenBody == "" {
		f.tokenBody = `{"access_token":"secret-token"}`
	}
	if f.infoBody == "" {
		f.infoBody = `{"id":"1234567","default_email":"user@yandex.ru"}`
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
		w.WriteHeader(f.infoStatus)
		_, _ = w.Write([]byte(f.infoBody))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	y := NewYandex("client-id", "client-secret", "https://app.trillix.ru/api/v1/auth/oauth/yandex/callback")
	y.tokenURL = srv.URL + "/token"
	y.infoURL = srv.URL + "/info"
	return y
}

func TestYandex_AuthURL_CarriesPKCEAndState(t *testing.T) {
	y := NewYandex("client-id", "secret", "https://app.trillix.ru/cb")

	raw := y.AuthURL("state-value", "verifier-value")
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("ссылка не разбирается: %v", err)
	}
	q := u.Query()

	if got := q.Get("response_type"); got != "code" {
		t.Fatalf("response_type = %q, want code", got)
	}
	if got := q.Get("state"); got != "state-value" {
		t.Fatalf("state = %q", got)
	}
	if got := q.Get("code_challenge_method"); got != "S256" {
		t.Fatalf("code_challenge_method = %q — plain не даёт защиты, ради которой PKCE вводился", got)
	}
	// В ссылку уезжает challenge, а не сам verifier: иначе PKCE бессмыслен —
	// перехвативший ссылку получил бы всё нужное для обмена кода.
	if got := q.Get("code_challenge"); got != Challenge("verifier-value") {
		t.Fatalf("code_challenge = %q, want S256(verifier)", got)
	}
	if strings.Contains(raw, "verifier-value") {
		t.Fatal("verifier утёк в ссылку авторизации")
	}
	if got := q.Get("redirect_uri"); got != "https://app.trillix.ru/cb" {
		t.Fatalf("redirect_uri = %q", got)
	}
}

func TestYandex_Exchange_ReturnsProfile(t *testing.T) {
	f := &fakeYandex{}
	y := newFake(t, f)

	profile, err := y.Exchange(context.Background(), "auth-code", "verifier-value")
	if err != nil {
		t.Fatalf("Exchange: %v", err)
	}
	if profile.ID != "1234567" || profile.Email != "user@yandex.ru" {
		t.Fatalf("профиль = %+v", profile)
	}

	// Обмен кода обязан нести verifier и тот же redirect_uri: без первого
	// провайдер отвергнет PKCE-запрос, без второго — сам обмен.
	if got := f.tokenForm.Get("code_verifier"); got != "verifier-value" {
		t.Fatalf("code_verifier в обмене = %q", got)
	}
	if got := f.tokenForm.Get("grant_type"); got != "authorization_code" {
		t.Fatalf("grant_type = %q", got)
	}
	if got := f.tokenForm.Get("redirect_uri"); got != "https://app.trillix.ru/api/v1/auth/oauth/yandex/callback" {
		t.Fatalf("redirect_uri в обмене = %q", got)
	}
	// Токен уходит заголовком, а не query-параметром: в query он осел бы в
	// логах прокси и в истории.
	if f.authHeader != "OAuth secret-token" {
		t.Fatalf("Authorization = %q", f.authHeader)
	}
}

func TestYandex_Exchange_NoEmail(t *testing.T) {
	f := &fakeYandex{infoBody: `{"id":"1234567"}`}
	y := newFake(t, f)

	_, err := y.Exchange(context.Background(), "auth-code", "verifier")
	if !errors.Is(err, ErrNoEmail) {
		t.Fatalf("err = %v, want ErrNoEmail", err)
	}
}

func TestYandex_Exchange_ProviderErrors(t *testing.T) {
	cases := map[string]*fakeYandex{
		"токен: отказ провайдера":    {tokenStatus: http.StatusBadRequest, tokenBody: `{"error":"invalid_grant"}`},
		"токен: пустой access_token": {tokenBody: `{}`},
		"токен: не JSON":             {tokenBody: `<html>502</html>`},
		"профиль: отказ":             {infoStatus: http.StatusUnauthorized, infoBody: `{}`},
		"профиль: пустой id":         {infoBody: `{"default_email":"user@yandex.ru"}`},
	}
	for name, f := range cases {
		t.Run(name, func(t *testing.T) {
			y := newFake(t, f)
			if _, err := y.Exchange(context.Background(), "code", "verifier"); err == nil {
				t.Fatal("ошибка провайдера проглочена — вход завершился бы «успехом» без профиля")
			}
		})
	}
}

// Текст ошибки уходит в лог, а тело ответа провайдера может содержать токен или
// адрес пользователя (internal/CLAUDE.md: ни то ни другое в логи не попадает).
func TestYandex_Exchange_ErrorDoesNotLeakBody(t *testing.T) {
	f := &fakeYandex{
		tokenStatus: http.StatusBadRequest,
		tokenBody:   `{"error":"invalid_grant","access_token":"leaked-token","email":"victim@yandex.ru"}`,
	}
	y := newFake(t, f)

	_, err := y.Exchange(context.Background(), "code", "verifier")
	if err == nil {
		t.Fatal("ожидалась ошибка")
	}
	if strings.Contains(err.Error(), "leaked-token") || strings.Contains(err.Error(), "victim@yandex.ru") {
		t.Fatalf("тело ответа провайдера утекло в ошибку: %v", err)
	}
}

func TestSecretsAreRandomAndSized(t *testing.T) {
	seen := make(map[string]bool, 100)
	for range 100 {
		s, err := NewSecret()
		if err != nil {
			t.Fatalf("NewSecret: %v", err)
		}
		// RFC 7636 требует code_verifier длиной 43–128 символов.
		if len(s) < 43 || len(s) > 128 {
			t.Fatalf("длина %d вне диапазона RFC 7636 (43–128)", len(s))
		}
		if seen[s] {
			t.Fatal("повтор значения — источник не случаен")
		}
		seen[s] = true
	}
}

func TestChallenge_IsStableS256(t *testing.T) {
	// Вектор из RFC 7636, приложение B.
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	const want = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if got := Challenge(verifier); got != want {
		t.Fatalf("Challenge = %q, want %q (вектор RFC 7636 B)", got, want)
	}
}
