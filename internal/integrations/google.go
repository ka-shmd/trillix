package integrations

import (
	"bytes"
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
	googleSheetsURL   = "https://sheets.googleapis.com/v4/spreadsheets"
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

// ErrPermanent — провайдер отказал так, что ретраить бессмысленно: доступ
// отозван, таблица удалена, аккаунт закрыт. Отличать это от «полежал и встал»
// обязательно: у outbox нет dead-letter, и безнадёжная строка иначе дёргала бы
// чужой API до конца времён.
var ErrPermanent = errors.New("integrations: провайдер отказал окончательно")

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
	sheetsURL   string

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
		sheetsURL:    googleSheetsURL,
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
		// 401/403 — доступ отозван или его не выдавали; 404 — таблицы больше
		// нет. Ждать и повторять тут нечего: нужен человек.
		switch resp.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
			return fmt.Errorf("%w: статус %d", ErrPermanent, resp.StatusCode)
		}
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

// Spreadsheet — таблица, созданная продуктом в Диске человека.
type Spreadsheet struct {
	ID  string
	URL string
	// SheetID — gid листа. Храним его, а не имя: имя автор волен переименовать,
	// и запись «по имени» после этого пошла бы мимо (или завела бы новый лист).
	SheetID int32
	// Title — имя листа на момент создания. Нужно для адресации диапазона
	// (A1-нотация оперирует именем), поэтому перед записью сверяется с gid.
	Title string
}

// CreateSpreadsheet заводит таблицу в Диске человека. Создаём мы, а не выбирает
// автор, — из-за scope drive.file: он даёт доступ ровно к созданным нами файлам
// и потому не требует проверки приложения в Google (ADR §10).
func (g *Google) CreateSpreadsheet(ctx context.Context, accessToken, title, sheetTitle string) (Spreadsheet, error) {
	body := map[string]any{
		"properties": map[string]any{"title": title},
		"sheets":     []any{map[string]any{"properties": map[string]any{"title": sheetTitle}}},
	}
	var out struct {
		SpreadsheetID  string `json:"spreadsheetId"`
		SpreadsheetURL string `json:"spreadsheetUrl"`
		Sheets         []struct {
			Properties struct {
				SheetID int32  `json:"sheetId"`
				Title   string `json:"title"`
			} `json:"properties"`
		} `json:"sheets"`
	}
	if err := g.apiJSON(ctx, http.MethodPost, g.sheetsURL, accessToken, body, &out); err != nil {
		return Spreadsheet{}, fmt.Errorf("integrations google: create spreadsheet: %w", err)
	}
	if out.SpreadsheetID == "" || len(out.Sheets) == 0 {
		return Spreadsheet{}, fmt.Errorf("integrations google: create spreadsheet: пустой ответ")
	}
	return Spreadsheet{
		ID:      out.SpreadsheetID,
		URL:     out.SpreadsheetURL,
		SheetID: out.Sheets[0].Properties.SheetID,
		Title:   out.Sheets[0].Properties.Title,
	}, nil
}

// WriteHeader кладёт строку заголовков в первую строку листа.
//
// valueInputOption=RAW обязателен и здесь, и при доставке ответов: USER_ENTERED
// разбирает «=…» как формулу, то есть подпись вопроса (её пишет автор) или
// ответ респондента исполнялись бы в чужой таблице.
func (g *Google) WriteHeader(ctx context.Context, accessToken string, s Spreadsheet, header []string) error {
	values := make([]any, 0, len(header))
	for _, h := range header {
		values = append(values, h)
	}
	body := map[string]any{"values": []any{values}}

	u := g.sheetsURL + "/" + url.PathEscape(s.ID) + "/values/" +
		url.PathEscape(a1Range(s.Title, "A1")) + "?valueInputOption=RAW"
	if err := g.apiJSON(ctx, http.MethodPut, u, accessToken, body, nil); err != nil {
		return fmt.Errorf("integrations google: write header: %w", err)
	}
	return nil
}

// AppendRow дописывает строку в конец листа.
//
// values.append, а не запись в вычисленную строку: номер следующей строки нам
// неизвестен (автор мог дописать своё руками, отсортировать, вставить строку), и
// вычисленный индекс однажды затёр бы чужие данные. Ключа идемпотентности у
// append нет — доставка at-least-once, дубль лечится перезаливом (ADR §10).
func (g *Google) AppendRow(ctx context.Context, accessToken string, s Spreadsheet, row []string) error {
	return g.AppendRows(ctx, accessToken, s, [][]string{row})
}

// AppendRows дописывает пачку строк одним запросом. Догрузка накопленных
// ответов идёт пачками, а не по строке: у Google 60 запросов в минуту на
// пользователя, и форма с двадцатью тысячами ответов упёрлась бы в лимит.
func (g *Google) AppendRows(ctx context.Context, accessToken string, s Spreadsheet, rows [][]string) error {
	values := make([]any, 0, len(rows))
	for _, row := range rows {
		cells := make([]any, 0, len(row))
		for _, v := range row {
			cells = append(cells, v)
		}
		values = append(values, cells)
	}
	body := map[string]any{"values": values}

	u := g.sheetsURL + "/" + url.PathEscape(s.ID) + "/values/" +
		url.PathEscape(a1Range(s.Title, "A1")) +
		":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS"
	if err := g.apiJSON(ctx, http.MethodPost, u, accessToken, body, nil); err != nil {
		return fmt.Errorf("integrations google: append rows: %w", err)
	}
	return nil
}

// ClearSheet вычищает лист целиком — перезалив начинается с пустого листа,
// иначе он удваивал бы то, что уже доехало.
//
// Чистятся ЗНАЧЕНИЯ, а не лист: формат, ширина колонок и закрепление шапки,
// которые автор настроил, остаются. Шапку после чистки пишет вызывающий.
func (g *Google) ClearSheet(ctx context.Context, accessToken string, s Spreadsheet) error {
	u := g.sheetsURL + "/" + url.PathEscape(s.ID) + "/values/" +
		url.PathEscape(a1Range(s.Title, "A:ZZZ")) + ":clear"
	if err := g.apiJSON(ctx, http.MethodPost, u, accessToken, map[string]any{}, nil); err != nil {
		return fmt.Errorf("integrations google: clear sheet: %w", err)
	}
	return nil
}

// a1Range собирает адрес диапазона с именем листа. Апостроф в имени удваивается:
// имя листа задаём мы, но правило A1-нотации соблюдается там, где строится адрес,
// а не там, где надеются на аккуратность вызывающего.
func a1Range(sheetTitle, cells string) string {
	return "'" + strings.ReplaceAll(sheetTitle, "'", "''") + "'!" + cells
}

// apiJSON — запрос к API провайдера с телом JSON и bearer-токеном.
func (g *Google) apiJSON(ctx context.Context, method, u, accessToken string, body, out any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal body: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+accessToken)
	return g.do(req, out)
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
