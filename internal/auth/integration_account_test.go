//go:build integration

package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/pgtest"
)

// profileOf разбирает объект пользователя из ответа /auth/* и отдаёт имя и
// фамилию.
func profileOf(t *testing.T, r *http.Response) (string, string) {
	t.Helper()
	defer func() { _ = r.Body.Close() }()
	var u struct {
		FirstName string `json:"firstName"`
		LastName  string `json:"lastName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		t.Fatalf("разбор объекта пользователя: %v", err)
	}
	return u.FirstName, u.LastName
}

func patch(t *testing.T, c *http.Client, url, jsonBody, csrf string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPatch, url, strings.NewReader(jsonBody))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

// Профиль переживает перезагрузку страницы: PATCH пишет в БД, следующий /auth/me
// читает записанное. Это ровно первый пункт критерия приёмки фазы 23
// (docs/design/account-settings.md §1) на уровне API.
func TestAccountProfile_PersistsAndReturnsInMe(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	resp := post(t, c, srv.URL+"/api/v1/auth/register", `{"email":"user@example.com","password":"supersecret1"}`, "")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: статус %d, ожидалось 201; тело=%s", resp.StatusCode, body(t, resp))
	}
	pgtest.CompleteSignup(t, testPool, "user@example.com")
	// Свежий аккаунт — без имени: колонки nullable, заполнить их при регистрации
	// нечем (парольная регистрация имени не спрашивает).
	if first, last := profileOf(t, get(t, c, srv.URL+"/api/v1/auth/me")); first != "" || last != "" {
		t.Fatalf("у нового аккаунта имя=%q фамилия=%q, ожидались пустые", first, last)
	}

	csrf := csrfHeader(t, c, srv.URL)
	upd := patch(t, c, srv.URL+"/api/v1/account/profile", `{"firstName":"Иван","lastName":"Петров"}`, csrf)
	if upd.StatusCode != http.StatusOK {
		t.Fatalf("patch profile: статус %d, ожидалось 200; тело=%s", upd.StatusCode, body(t, upd))
	}
	if first, last := profileOf(t, upd); first != "Иван" || last != "Петров" {
		t.Fatalf("ответ PATCH: имя=%q фамилия=%q", first, last)
	}

	// Главное: значение приехало из БД, а не из ответа предыдущего запроса.
	if first, last := profileOf(t, get(t, c, srv.URL+"/api/v1/auth/me")); first != "Иван" || last != "Петров" {
		t.Fatalf("me после правки: имя=%q фамилия=%q, ожидались Иван/Петров", first, last)
	}

	// Стирание — законная операция, и пустое значение не должно вернуться
	// строкой из пробелов или прежним именем.
	clr := patch(t, c, srv.URL+"/api/v1/account/profile", `{"firstName":"  ","lastName":""}`, csrf)
	if clr.StatusCode != http.StatusOK {
		t.Fatalf("очистка профиля: статус %d, ожидалось 200; тело=%s", clr.StatusCode, body(t, clr))
	}
	if first, last := profileOf(t, get(t, c, srv.URL+"/api/v1/auth/me")); first != "" || last != "" {
		t.Fatalf("после очистки имя=%q фамилия=%q, ожидались пустые", first, last)
	}
}

// Анти-IDOR: чужой профиль не правится, потому что адреса «правь пользователя N»
// не существует — id берётся из сессии. Проверяем, что аккаунт B правит СВОЙ
// профиль, а профиль A остаётся нетронутым.
func TestAccountProfile_TouchesOnlyOwnAccount(t *testing.T) {
	resetDB(t)
	srv := newStack(t)

	a := newClient(t)
	if r := post(t, a, srv.URL+"/api/v1/auth/register", `{"email":"a@example.com","password":"supersecret1"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("register A: статус %d", r.StatusCode)
	}
	pgtest.CompleteSignup(t, testPool, "a@example.com")
	if r := patch(t, a, srv.URL+"/api/v1/account/profile", `{"firstName":"Анна","lastName":"Аксёнова"}`, csrfHeader(t, a, srv.URL)); r.StatusCode != http.StatusOK {
		t.Fatalf("patch A: статус %d; тело=%s", r.StatusCode, body(t, r))
	}

	b := newClient(t)
	if r := post(t, b, srv.URL+"/api/v1/auth/register", `{"email":"b@example.com","password":"supersecret1"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("register B: статус %d", r.StatusCode)
	}
	pgtest.CompleteSignup(t, testPool, "b@example.com")
	if r := patch(t, b, srv.URL+"/api/v1/account/profile", `{"firstName":"Борис","lastName":"Бирюков"}`, csrfHeader(t, b, srv.URL)); r.StatusCode != http.StatusOK {
		t.Fatalf("patch B: статус %d; тело=%s", r.StatusCode, body(t, r))
	}

	if first, _ := profileOf(t, get(t, a, srv.URL+"/api/v1/auth/me")); first != "Анна" {
		t.Fatalf("профиль A после правки B: имя=%q, ожидалось «Анна»", first)
	}
	if first, _ := profileOf(t, get(t, b, srv.URL+"/api/v1/auth/me")); first != "Борис" {
		t.Fatalf("профиль B: имя=%q, ожидалось «Борис»", first)
	}
}

// Смена пароля: чужие сессии умирают, текущая живёт дальше, письмо ложится в
// outbox. Третий пункт критерия приёмки фазы 23.
func TestAccountPassword_KillsOtherSessionsKeepsCurrent(t *testing.T) {
	resetDB(t)
	srv := newStack(t)

	const email = "user@example.com"
	const oldPassword = "supersecret1"
	const newPassword = "supersecret2"

	// Два браузера одного человека: в первом он сейчас сменит пароль.
	here := newClient(t)
	if r := post(t, here, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"`+oldPassword+`"}`, ""); r.StatusCode != http.StatusCreated {
		t.Fatalf("register: статус %d", r.StatusCode)
	}
	pgtest.CompleteSignup(t, testPool, email)
	elsewhere := newClient(t)
	if r := post(t, elsewhere, srv.URL+"/api/v1/auth/login",
		`{"email":"`+email+`","password":"`+oldPassword+`"}`, ""); r.StatusCode != http.StatusOK {
		t.Fatalf("login во втором браузере: статус %d", r.StatusCode)
	}

	resp := post(t, here, srv.URL+"/api/v1/account/password",
		`{"currentPassword":"`+oldPassword+`","newPassword":"`+newPassword+`"}`, csrfHeader(t, here, srv.URL))
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("смена пароля: статус %d; тело=%s", resp.StatusCode, body(t, resp))
	}
	_ = resp.Body.Close()

	// Тот, кто менял, остаётся внутри: cookie переставлена ответом.
	if me := get(t, here, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusOK {
		t.Fatalf("me в том же браузере: статус %d, ожидалось 200 — человек разлогинен своей же сменой пароля", me.StatusCode)
	}
	// Второй браузер выкинут: ровно ради этого пароль и меняют.
	if me := get(t, elsewhere, srv.URL+"/api/v1/auth/me"); me.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me во втором браузере: статус %d, ожидалось 401", me.StatusCode)
	}

	// Старый пароль больше не пускает, новый пускает.
	fresh := newClient(t)
	if r := post(t, fresh, srv.URL+"/api/v1/auth/login",
		`{"email":"`+email+`","password":"`+oldPassword+`"}`, ""); r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("вход старым паролем: статус %d, ожидалось 401", r.StatusCode)
	}
	if r := post(t, fresh, srv.URL+"/api/v1/auth/login",
		`{"email":"`+email+`","password":"`+newPassword+`"}`, ""); r.StatusCode != http.StatusOK {
		t.Fatalf("вход новым паролем: статус %d, ожидалось 200", r.StatusCode)
	}

	// Письмо-уведомление — единственный способ узнать об угоне; оно обязано
	// лечь в ту же транзакцию, что и смена (transactional outbox).
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbox WHERE payload->>'template' = 'password_changed'`).Scan(&n); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if n != 1 {
		t.Fatalf("писем о смене пароля в outbox: %d, ожидалось 1", n)
	}
}

// avatarKeyOf разбирает ключ аватара из объекта пользователя.
func avatarKeyOf(t *testing.T, r *http.Response) string {
	t.Helper()
	defer func() { _ = r.Body.Close() }()
	var u struct {
		AvatarKey string `json:"avatarKey"`
	}
	if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
		t.Fatalf("разбор объекта пользователя: %v", err)
	}
	return u.AvatarKey
}

func TestAccountAvatar_PersistsAndClears(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := newClient(t)

	resp := post(t, c, srv.URL+"/api/v1/auth/register", `{"email":"user@example.com","password":"supersecret1"}`, "")
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: статус %d, ожидалось 201; тело=%s", resp.StatusCode, body(t, resp))
	}
	pgtest.CompleteSignup(t, testPool, "user@example.com")
	if key := avatarKeyOf(t, get(t, c, srv.URL+"/api/v1/auth/me")); key != "" {
		t.Fatalf("у нового аккаунта ключ аватара %q, ожидался пустой", key)
	}

	csrf := csrfHeader(t, c, srv.URL)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	w, err := mw.CreateFormFile("file", "avatar.png")
	if err != nil {
		t.Fatalf("create form file: %v", err)
	}
	if _, err := w.Write([]byte("байты картинки")); err != nil {
		t.Fatalf("write form file: %v", err)
	}
	if err := mw.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/account/avatar", &buf)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-CSRF-Token", csrf)
	up, err := c.Do(req)
	if err != nil {
		t.Fatalf("upload avatar: %v", err)
	}
	if up.StatusCode != http.StatusOK {
		t.Fatalf("upload avatar: статус %d, ожидалось 200; тело=%s", up.StatusCode, body(t, up))
	}
	if key := avatarKeyOf(t, up); key != "avatars/integration.png" {
		t.Fatalf("ответ загрузки: ключ %q", key)
	}

	// Главное: ключ приехал из БД, а не из ответа предыдущего запроса.
	if key := avatarKeyOf(t, get(t, c, srv.URL+"/api/v1/auth/me")); key != "avatars/integration.png" {
		t.Fatalf("me после загрузки: ключ %q", key)
	}

	del, err := http.NewRequest(http.MethodDelete, srv.URL+"/api/v1/account/avatar", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	del.Header.Set("X-CSRF-Token", csrf)
	rm, err := c.Do(del)
	if err != nil {
		t.Fatalf("delete avatar: %v", err)
	}
	if rm.StatusCode != http.StatusOK {
		t.Fatalf("delete avatar: статус %d, ожидалось 200; тело=%s", rm.StatusCode, body(t, rm))
	}
	if key := avatarKeyOf(t, get(t, c, srv.URL+"/api/v1/auth/me")); key != "" {
		t.Fatalf("me после снятия: ключ %q, ожидался пустой", key)
	}
}
