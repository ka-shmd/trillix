package oauth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Боевые эндпоинты Яндекс ID (сверено 2026-07-22, DEV-PLAN фаза 11 шаг 1).
// В структуре они лежат полями, а не читаются отсюда напрямую: тесты подменяют
// их на httptest-сервер, иначе проверить обмен кода можно было бы только живым
// походом в интернет.
const (
	yandexAuthURL  = "https://oauth.yandex.ru/authorize"
	yandexTokenURL = "https://oauth.yandex.ru/token"
	yandexInfoURL  = "https://login.yandex.ru/info"
)

// Yandex — вход через Яндекс ID.
type Yandex struct {
	clientID     string
	clientSecret string
	// redirectURI собирается из APP_ORIGIN и обязан совпадать байт в байт с
	// зарегистрированным в консоли — иначе провайдер отказывает на первом же шаге.
	redirectURI string

	authURL  string
	tokenURL string
	infoURL  string

	http *http.Client
}

// NewYandex собирает провайдера. redirectURI передаётся снаружи (собирается из
// cfg.AppOrigin), чтобы пакет не знал про конфигурацию приложения.
func NewYandex(clientID, clientSecret, redirectURI string) *Yandex {
	return &Yandex{
		clientID:     clientID,
		clientSecret: clientSecret,
		redirectURI:  redirectURI,
		authURL:      yandexAuthURL,
		tokenURL:     yandexTokenURL,
		infoURL:      yandexInfoURL,
		http:         newHTTPClient(),
	}
}

func (y *Yandex) Name() string { return "yandex" }

func (y *Yandex) AuthURL(state, verifier string) string {
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {y.clientID},
		"redirect_uri":          {y.redirectURI},
		"state":                 {state},
		"code_challenge":        {Challenge(verifier)},
		"code_challenge_method": {"S256"},
	}
	return y.authURL + "?" + q.Encode()
}

func (y *Yandex) Exchange(ctx context.Context, code, verifier string) (Profile, error) {
	token, err := y.exchangeCode(ctx, code, verifier)
	if err != nil {
		return Profile{}, err
	}
	return y.fetchProfile(ctx, token)
}

func (y *Yandex) exchangeCode(ctx context.Context, code, verifier string) (string, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {y.clientID},
		"client_secret": {y.clientSecret},
		"code_verifier": {verifier},
		"redirect_uri":  {y.redirectURI},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, y.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", fmt.Errorf("oauth yandex: build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	var body struct {
		AccessToken string `json:"access_token"`
	}
	if err := y.do(req, &body); err != nil {
		return "", fmt.Errorf("oauth yandex: exchange code: %w", err)
	}
	if body.AccessToken == "" {
		return "", fmt.Errorf("oauth yandex: exchange code: пустой access_token")
	}
	return body.AccessToken, nil
}

func (y *Yandex) fetchProfile(ctx context.Context, token string) (Profile, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, y.infoURL+"?format=json", nil)
	if err != nil {
		return Profile{}, fmt.Errorf("oauth yandex: build info request: %w", err)
	}
	// Заголовком, а не query-параметром: токен не должен оседать в логах и
	// истории прокси.
	req.Header.Set("Authorization", "OAuth "+token)

	var body struct {
		ID           string `json:"id"`
		DefaultEmail string `json:"default_email"`
	}
	if err := y.do(req, &body); err != nil {
		return Profile{}, fmt.Errorf("oauth yandex: fetch profile: %w", err)
	}
	if body.ID == "" {
		return Profile{}, fmt.Errorf("oauth yandex: fetch profile: пустой id")
	}
	if body.DefaultEmail == "" {
		return Profile{}, ErrNoEmail
	}
	return Profile{ID: body.ID, Email: body.DefaultEmail}, nil
}

// do выполняет запрос и разбирает JSON-ответ. Тело читается через LimitReader:
// потолок общий для всех ответов провайдера.
func (y *Yandex) do(req *http.Request, out any) error {
	resp, err := y.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	// Тело ответа наружу не отдаём и в лог не пишем: в нём может лежать токен
	// или адрес пользователя. Наверх едет только статус.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("статус %d", resp.StatusCode)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("разбор ответа: %w", err)
	}
	return nil
}
