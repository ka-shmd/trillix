package integrations

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"

	"github.com/ka-shmd/trillix/internal/oauth"
)

// Боевые эндпоинты Яндекс ID. Полями структуры, а не прямым чтением констант:
// тесты подменяют их на httptest-сервер.
const (
	yandexAuthURL  = "https://oauth.yandex.ru/authorize"
	yandexTokenURL = "https://oauth.yandex.ru/token"
	yandexInfoURL  = "https://login.yandex.ru/info"
)

// yandexScopes — права приложения «Trillix — интеграции» (design/yandex-metrika.md
// §13.1): почта — подпись аккаунта в списке, metrika:read — список счётчиков,
// metrika:write — заведение целей. Передаются ЯВНО: без scope Яндекс выдаёт токен
// со всеми правами, заданными приложению в консоли, и лишнее право, добавленное
// туда когда-нибудь, молча уехало бы в каждый токен.
const yandexScopes = "login:email metrika:read metrika:write"

// Yandex — клиент OAuth-подключения аккаунта Яндекса к интеграциям. Это не вход в
// кабинет (internal/oauth): приложение другое, и токен здесь хранится.
type Yandex struct {
	clientID     string
	clientSecret string
	// redirectURI обязан совпадать байт в байт с зарегистрированным в Яндекс ID.
	redirectURI string

	authURL  string
	tokenURL string
	infoURL  string

	http *http.Client
}

func NewYandex(clientID, clientSecret, redirectURI string) *Yandex {
	return &Yandex{
		clientID:     clientID,
		clientSecret: clientSecret,
		redirectURI:  redirectURI,
		authURL:      yandexAuthURL,
		tokenURL:     yandexTokenURL,
		infoURL:      yandexInfoURL,
		http:         &http.Client{Timeout: requestTimeout},
	}
}

// Provider — имя в колонке integration_accounts.provider и в адресах.
func (y *Yandex) Provider() string { return ProviderYandex }

// AuthURL — ссылка на экран согласия Яндекс ID.
//
// force_confirm=yes — всегда, а не только при переподключении: без него Яндекс
// молча выдаёт токен аккаунту, в котором человек уже вошёл, и «подключить ещё
// один» приходило бы тем же аккаунтом. loginHint — почта переподключаемого
// аккаунта; подсказка, а не гарантия, и на возврате не проверяется.
func (y *Yandex) AuthURL(state, verifier, loginHint string) string {
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {y.clientID},
		"redirect_uri":          {y.redirectURI},
		"scope":                 {yandexScopes},
		"state":                 {state},
		"code_challenge":        {oauth.Challenge(verifier)},
		"code_challenge_method": {"S256"},
		"force_confirm":         {"yes"},
	}
	if loginHint != "" {
		q.Set("login_hint", loginHint)
	}
	return y.authURL + "?" + q.Encode()
}

// Exchange меняет код на токены.
func (y *Yandex) Exchange(ctx context.Context, code, verifier string) (Tokens, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {y.clientID},
		"client_secret": {y.clientSecret},
		"code_verifier": {verifier},
		"redirect_uri":  {y.redirectURI},
	}
	t, err := postToken(ctx, y.http, y.tokenURL, form)
	if err != nil {
		return Tokens{}, fmt.Errorf("integrations yandex: exchange code: %w", err)
	}
	if t.Refresh == "" {
		return Tokens{}, ErrNoRefreshToken
	}
	return t, nil
}

// Refresh обновляет access-токен. Яндекс отдаёт в ответ и НОВЫЙ refresh-токен —
// его сохраняет keepRotatedToken сервиса.
func (y *Yandex) Refresh(ctx context.Context, refresh string) (Tokens, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
		"client_id":     {y.clientID},
		"client_secret": {y.clientSecret},
	}
	t, err := postToken(ctx, y.http, y.tokenURL, form)
	if err != nil {
		// invalid_grant у обновления — отозванное или протухшее согласие, то есть
		// смерть подключения; у обмена кода тот же код значил бы негодный код.
		if errors.Is(err, errRefusedGrant) {
			return Tokens{}, fmt.Errorf("integrations yandex: refresh token: %w", ErrAccessLost)
		}
		return Tokens{}, fmt.Errorf("integrations yandex: refresh token: %w", err)
	}
	return t, nil
}

// Account читает, чей это аккаунт.
func (y *Yandex) Account(ctx context.Context, accessToken string) (Account, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, y.infoURL+"?format=json", nil)
	if err != nil {
		return Account{}, fmt.Errorf("integrations yandex: build info request: %w", err)
	}
	// Заголовком, а не query-параметром: токен не должен оседать в логах прокси.
	req.Header.Set("Authorization", "OAuth "+accessToken)

	var body struct {
		ID           string `json:"id"`
		DefaultEmail string `json:"default_email"`
		Login        string `json:"login"`
	}
	if err := providerRequest(y.http, req, &body, false); err != nil {
		return Account{}, fmt.Errorf("integrations yandex: fetch account: %w", err)
	}
	if body.ID == "" {
		return Account{}, fmt.Errorf("integrations yandex: fetch account: пустой id")
	}
	// Почта — подпись аккаунта на экране, не идентификатор. У аккаунта без
	// основного адреса подписью служит логин.
	email := body.DefaultEmail
	if email == "" {
		email = body.Login
	}
	return Account{ID: body.ID, Email: email}, nil
}

// Revoke ничего не делает, и это не упущение: Яндекс отзывает только токены,
// выданные с идентификатором устройства (yandex.ru/dev/id/doc/ru/tokens/token-invalidate).
// Отключение аккаунта удаляет токен у нас, а доступ приложения человек снимает в
// настройках Яндекс ID — окно отключения говорит это текстом (спека §13.2).
func (y *Yandex) Revoke(_ context.Context, _ string) error { return nil }
