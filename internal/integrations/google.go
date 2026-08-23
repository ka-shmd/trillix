package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ka-shmd/trillix/internal/oauth"
)

// Боевые эндпоинты Google. В структуре они лежат полями, а не читаются отсюда
// напрямую: тесты подменяют их на httptest-сервер (тот же приём, что у Яндекса).
const (
	googleAuthURL     = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenURL    = "https://oauth2.googleapis.com/token"
	googleRevokeURL   = "https://oauth2.googleapis.com/revoke"
	googleUserInfoURL = "https://openidconnect.googleapis.com/v1/userinfo"
)

// ScopeDriveFile — доступ ТОЛЬКО к файлам, созданным этим приложением. Ради него
// таблицу создаёт продукт, а «подключить существующую» не поддерживается: полный
// scope spreadsheets сенситивный и требует проверки приложения в Google (ADR §10).
const ScopeDriveFile = "https://www.googleapis.com/auth/drive.file"

// googleScopes — что просим на экране согласия. openid и email — не «заодно»:
// без них не узнать ни стабильный идентификатор аккаунта (sub), ни адрес,
// который показывается человеку как «подключено как …». Оба несенситивны и
// проверки приложения не требуют.
const googleScopes = "openid email " + ScopeDriveFile

const (
	// Потолок на ответ провайдера: токен и профиль — сотни байт.
	maxResponseBytes = 1 << 20
	// Провайдер в цепочке пользовательского запроса (подключение) либо фоновой
	// доставки: без таймаута его зависание держит наш обработчик.
	requestTimeout = 10 * time.Second
)

// ErrNoRefreshToken — Google не прислал refresh-токен. Штатная причина: человек
// уже давал согласие раньше, и без prompt=consent провайдер второй раз токен не
// отдаёт. Ошибка отдельная, потому что подключение без refresh выглядит удачным
// ровно час, а потом молча умирает.
var ErrNoRefreshToken = errors.New("integrations: провайдер не отдал refresh_token")

// ErrScopeDenied — человек снял на экране согласия галочку доступа к Диску.
// Обычный исход, а не сбой: ему нужен человеческий текст, а не «ошибка 500».
var ErrScopeDenied = errors.New("integrations: доступ к Google Диску не выдан")

// Tokens — что вернул провайдер. Access живёт час и НИКОГДА не пишется в БД:
// он берётся по refresh в момент надобности и остаётся в памяти процесса.
type Tokens struct {
	Access  string
	Refresh string
	// Scopes — то, что реально выдано. Проверяется, а не принимается на веру:
	// запрошенное и выданное — разные множества, решает человек.
	Scopes    string
	ExpiresIn time.Duration
}

// Account — подключённый аккаунт провайдера. Больше о человеке не спрашиваем:
// минимизация ПДн и короткий экран согласия (тот же довод, что в internal/oauth).
type Account struct {
	// ID — sub провайдера: стабилен при смене почты, поэтому именно он ложится
	// в integration_accounts.external_account_id.
	ID    string
	Email string
}

// Google — клиент OAuth-подключения к Google.
type Google struct {
	clientID     string
	clientSecret string
	// redirectURI обязан совпадать байт в байт с зарегистрированным в консоли
	// Google Cloud — иначе провайдер отказывает на первом же шаге.
	redirectURI string

	authURL     string
	tokenURL    string
	revokeURL   string
	userInfoURL string

	http *http.Client
}

func NewGoogle(clientID, clientSecret, redirectURI string) *Google {
	return &Google{
		clientID:     clientID,
		clientSecret: clientSecret,
		redirectURI:  redirectURI,
		authURL:      googleAuthURL,
		tokenURL:     googleTokenURL,
		revokeURL:    googleRevokeURL,
		userInfoURL:  googleUserInfoURL,
		http:         &http.Client{Timeout: requestTimeout},
	}
}

// Provider — имя в колонке integration_accounts.provider и в адресах.
func (g *Google) Provider() string { return "google" }

// AuthURL — ссылка на экран согласия.
//
// access_type=offline и prompt=consent — не перестраховка: без offline
// refresh-токена не будет вовсе, а без consent провайдер не отдаёт его повторно
// тому, кто уже соглашался. Переподключение (сменил аккаунт, отозвал доступ)
// тогда давало бы интеграцию, живущую ровно час.
func (g *Google) AuthURL(state, verifier string) string {
	q := url.Values{
		"response_type":         {"code"},
		"client_id":             {g.clientID},
		"redirect_uri":          {g.redirectURI},
		"scope":                 {googleScopes},
		"state":                 {state},
		"code_challenge":        {oauth.Challenge(verifier)},
		"code_challenge_method": {"S256"},
		"access_type":           {"offline"},
		"prompt":                {"consent"},
	}
	return g.authURL + "?" + q.Encode()
}

// Exchange меняет код на токены и проверяет, что доступ к Диску реально выдан.
func (g *Google) Exchange(ctx context.Context, code, verifier string) (Tokens, error) {
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"client_id":     {g.clientID},
		"client_secret": {g.clientSecret},
		"code_verifier": {verifier},
		"redirect_uri":  {g.redirectURI},
	}
	t, err := g.token(ctx, form)
	if err != nil {
		return Tokens{}, fmt.Errorf("integrations google: exchange code: %w", err)
	}
	if t.Refresh == "" {
		return Tokens{}, ErrNoRefreshToken
	}
	if !HasScope(t.Scopes, ScopeDriveFile) {
		return Tokens{}, ErrScopeDenied
	}
	return t, nil
}

// Refresh обновляет access-токен. Refresh-токен при этом не меняется — Google
// присылает новый лишь в исключительных случаях, и полагаться на это нельзя.
func (g *Google) Refresh(ctx context.Context, refresh string) (Tokens, error) {
	form := url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refresh},
		"client_id":     {g.clientID},
		"client_secret": {g.clientSecret},
	}
	t, err := g.token(ctx, form)
	if err != nil {
		return Tokens{}, fmt.Errorf("integrations google: refresh token: %w", err)
	}
	return t, nil
}

// Account читает, чей это аккаунт. Отдельным запросом, а не разбором id_token:
// разбор JWT потребовал бы качать и держать ключи провайдера ради двух полей,
// которые тот отдаёт готовыми.
func (g *Google) Account(ctx context.Context, accessToken string) (Account, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.userInfoURL, nil)
	if err != nil {
		return Account{}, fmt.Errorf("integrations google: build userinfo request: %w", err)
	}
	// Заголовком, а не query-параметром: токен не должен оседать в логах и
	// истории прокси.
	req.Header.Set("Authorization", "Bearer "+accessToken)

	var body struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
	}
	if err := g.do(req, &body); err != nil {
		return Account{}, fmt.Errorf("integrations google: fetch account: %w", err)
	}
	if body.Sub == "" {
		return Account{}, fmt.Errorf("integrations google: fetch account: пустой sub")
	}
	return Account{ID: body.Sub, Email: body.Email}, nil
}

// Revoke отзывает согласие на стороне Google. Исход не гейтит отключение у нас
// (см. Service.Disconnect): недоступность провайдера не должна запирать человека
// в подключении, которое он разрывает.
func (g *Google) Revoke(ctx context.Context, refresh string) error {
	form := url.Values{"token": {refresh}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.revokeURL, strings.NewReader(form.Encode()))
	if err != nil {
		return fmt.Errorf("integrations google: build revoke request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if err := g.do(req, nil); err != nil {
		return fmt.Errorf("integrations google: revoke: %w", err)
	}
	return nil
}

// token — общий обмен на эндпоинте токенов (код и refresh отличаются только формой).
func (g *Google) token(ctx context.Context, form url.Values) (Tokens, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return Tokens{}, fmt.Errorf("build token request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	var body struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Scope        string `json:"scope"`
		ExpiresIn    int    `json:"expires_in"`
	}
	if err := g.do(req, &body); err != nil {
		return Tokens{}, err
	}
	if body.AccessToken == "" {
		return Tokens{}, fmt.Errorf("пустой access_token")
	}
	return Tokens{
		Access:    body.AccessToken,
		Refresh:   body.RefreshToken,
		Scopes:    body.Scope,
		ExpiresIn: time.Duration(body.ExpiresIn) * time.Second,
	}, nil
}

// do выполняет запрос и разбирает JSON-ответ (out == nil — тело не нужно).
// Тело читается через LimitReader: потолок общий для всех ответов провайдера.
func (g *Google) do(req *http.Request, out any) error {
	resp, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	// Тело ответа наружу не отдаём и в лог не пишем: в нём лежат токены и адрес
	// человека. Наверх едет только статус.
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("статус %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("разбор ответа: %w", err)
	}
	return nil
}

// HasScope отвечает, есть ли scope в выданном провайдером списке. Список —
// строка, разделённая пробелами; поиск подстрокой дал бы ложное «да» на
// префиксе (…/drive.file.readonly), поэтому сравниваются элементы.
func HasScope(granted, want string) bool {
	for _, s := range strings.Fields(granted) {
		if s == want {
			return true
		}
	}
	return false
}
