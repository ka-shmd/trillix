//go:build integration

// Счётчики аккаунта Яндекса и заведение целей против настоящего Postgres (фаза 29,
// design/yandex-metrika.md §13.3–13.4): порядок проверок прав, границы аккаунта,
// отсутствие дублей и отказ Яндекса человеческим текстом. Провайдер подставной —
// живая Метрика означала бы тест, зелёный только с ключами и интернетом.
package integrations_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"unicode"

	"github.com/ka-shmd/trillix/internal/integrations"
)

type goalsDTO struct {
	Created  int `json:"created"`
	Existing int `json:"existing"`
}

type metrikaCounterDTO struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Site string `json:"site"`
}

func ensureGoals(t *testing.T, c *http.Client, srv *httptest.Server, formID, accountID string) *http.Response {
	t.Helper()
	return postBodyWithCSRF(t, c, srv, "/api/v1/forms/"+formID+"/counters/yandex-metrika/goals",
		`{"accountId":"`+accountID+`"}`)
}

// errorMessage — текст ошибки из конверта ответа.
func errorMessage(t *testing.T, r *http.Response) string {
	t.Helper()
	var got struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	decode(t, r, &got)
	return got.Error.Message
}

// Первый заход заводит все три цели, второй не заводит ни одной: заведённое
// живёт в Метрике, и у второй формы с тем же счётчиком дублей не появляется.
func TestMetrikaGoals_CreatedOnceThenExisting(t *testing.T) {
	resetDB(t)
	yandex := newFakeYandexProvider()
	// Google отказывает в обновлении токена: аккаунт Яндекса обязан обменивать
	// свой refresh у ЯНДЕКСА, и подмена провайдера здесь падала бы, а не работала
	// молча на чужом токене.
	google := &fakeProvider{refreshErr: errors.New("токен Яндекса ушёл на обмен в Google")}
	srv := newStackWith(t, google, yandex, testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	accountID := connectYandex(t, owner, srv)

	formID := newForm(t, wsID, "f-goals")
	closeBody(t, putMetrika(t, owner, srv, formID, `{"counter":"12345678"}`))

	r := ensureGoals(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("заведение целей: статус %d, ожидалось 200", r.StatusCode)
	}
	var got goalsDTO
	decode(t, r, &got)
	if got != (goalsDTO{Created: 3, Existing: 0}) {
		t.Fatalf("итог = %+v, ожидалось «завели три»", got)
	}

	// Вторая форма с ТЕМ ЖЕ счётчиком: цели уже есть, заводить нечего.
	second := newForm(t, wsID, "f-goals-2")
	closeBody(t, putMetrika(t, owner, srv, second, `{"counter":"12345678"}`))
	r = ensureGoals(t, owner, srv, second, accountID)
	decode(t, r, &got)
	if got != (goalsDTO{Created: 0, Existing: 3}) {
		t.Fatalf("итог повтора = %+v, ожидалось «все три уже были»", got)
	}
}

// Чужая форма — 404, и отказ случается РАНЬШЕ похода в Яндекс: иначе посторонний
// по id формы узнавал бы и о её существовании, и о том, что у неё есть счётчик.
func TestMetrikaGoals_ForeignFormRefusedBeforeYandex(t *testing.T) {
	resetDB(t)
	yandex := newFakeYandexProvider()
	srv := newStackWith(t, &fakeProvider{}, yandex, testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	ownerForm := newForm(t, personalWorkspace(t), "f-owner")
	closeBody(t, putMetrika(t, owner, srv, ownerForm, `{"counter":"12345678"}`))

	stranger := registerUser(t, srv, "stranger@example.com")
	strangerAccount := connectYandex(t, stranger, srv)
	before := yandex.calls

	r := ensureGoals(t, stranger, srv, ownerForm, strangerAccount)
	closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("чужая форма: статус %d, ожидалось 404", r.StatusCode)
	}
	if yandex.calls != before {
		t.Fatalf("походов в Яндекс = %d — постороннего пустили к провайдеру", yandex.calls-before)
	}
}

// У формы нет счётчика — заводить цели некуда, и это отказ по вводу, а не поход
// в Яндекс: номер целей берётся у формы, а не из тела запроса.
func TestMetrikaGoals_WithoutCounter(t *testing.T) {
	resetDB(t)
	yandex := newFakeYandexProvider()
	srv := newStackWith(t, &fakeProvider{}, yandex, testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-no-counter")
	accountID := connectYandex(t, owner, srv)
	before := yandex.calls

	r := ensureGoals(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusUnprocessableEntity {
		closeBody(t, r)
		t.Fatalf("форма без счётчика: статус %d, ожидалось 422", r.StatusCode)
	}
	if msg := errorMessage(t, r); msg == "" {
		t.Fatal("отказ без текста — человеку нечего делать")
	}
	if yandex.calls != before {
		t.Fatal("ходили в Яндекс, не зная номера счётчика")
	}
}

// Чужой аккаунт целей не заводит: id приезжает в теле и правом доступа не
// является. Отказ неотличим от «такого аккаунта нет».
func TestMetrikaGoals_ForeignAccountRefused(t *testing.T) {
	resetDB(t)
	yandex := newFakeYandexProvider()
	srv := newStackWith(t, &fakeProvider{}, yandex, testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	stranger := registerUser(t, srv, "stranger@example.com")
	strangerAccount := connectYandex(t, stranger, srv)

	formID := newForm(t, wsID, "f-foreign-account")
	closeBody(t, putMetrika(t, owner, srv, formID, `{"counter":"12345678"}`))
	before := yandex.calls

	r := ensureGoals(t, owner, srv, formID, strangerAccount)
	closeBody(t, r)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("чужой аккаунт: статус %d, ожидалось 422", r.StatusCode)
	}
	if yandex.calls != before {
		t.Fatal("ходили в Яндекс чужим аккаунтом")
	}
}

// Отказ Яндекса доезжает до человека РУССКИМ текстом: латиницы в сообщении нет,
// а причина от Яндекса остаётся в логе.
func TestMetrikaGoals_YandexRefusedInRussian(t *testing.T) {
	resetDB(t)
	yandex := newFakeYandexProvider()
	yandex.refuse = integrations.ErrPermanent
	srv := newStackWith(t, &fakeProvider{}, yandex, testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	accountID := connectYandex(t, owner, srv)

	formID := newForm(t, personalWorkspace(t), "f-refused")
	closeBody(t, putMetrika(t, owner, srv, formID, `{"counter":"12345678"}`))

	r := ensureGoals(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusUnprocessableEntity {
		closeBody(t, r)
		t.Fatalf("отказ Яндекса: статус %d, ожидалось 422", r.StatusCode)
	}
	msg := errorMessage(t, r)
	for _, ru := range msg {
		if unicode.In(ru, unicode.Latin) {
			t.Fatalf("сообщение = %q — до экрана доехала латиница провайдера", msg)
		}
	}
}

// Список счётчиков — из СВОЕГО аккаунта Яндекса. Чужой аккаунт неотличим от
// несуществующего, и в Яндекс за ним не ходят.
func TestMetrikaCounters_OwnAccountOnly(t *testing.T) {
	resetDB(t)
	yandex := newFakeYandexProvider()
	srv := newStackWith(t, &fakeProvider{}, yandex, testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	personalWorkspace(t)
	accountID := connectYandex(t, owner, srv)

	r := do(t, owner, http.MethodGet, srv.URL+"/api/v1/integrations/yandex/accounts/"+accountID+"/counters")
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("список счётчиков: статус %d, ожидалось 200", r.StatusCode)
	}
	var got struct {
		Counters []metrikaCounterDTO `json:"counters"`
	}
	decode(t, r, &got)
	if len(got.Counters) != 1 || got.Counters[0] != (metrikaCounterDTO{ID: 12345678, Name: "Сайт агентства", Site: "agency.example"}) {
		t.Fatalf("счётчики = %+v", got.Counters)
	}

	stranger := registerUser(t, srv, "stranger@example.com")
	before := yandex.calls
	r = do(t, stranger, http.MethodGet, srv.URL+"/api/v1/integrations/yandex/accounts/"+accountID+"/counters")
	closeBody(t, r)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("чужой аккаунт: статус %d, ожидалось 422", r.StatusCode)
	}
	if yandex.calls != before {
		t.Fatal("ходили в Яндекс чужим аккаунтом")
	}
}

// Контур без приложения Яндекса: ручек нет вовсе, а ручной номер работает.
func TestMetrikaGoals_NotConfigured(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-manual")
	closeBody(t, putMetrika(t, owner, srv, formID, `{"counter":"12345678"}`))

	r := ensureGoals(t, owner, srv, formID, "00000000-0000-0000-0000-000000000001")
	closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("заведение целей без приложения: статус %d, ожидалось 404", r.StatusCode)
	}
	if got := metrikaOf(t, owner, srv, formID); got == nil || got.Counter != "12345678" {
		t.Fatalf("счётчик = %+v — ручной номер перестал работать", got)
	}
}

func createCounter(t *testing.T, c *http.Client, srv *httptest.Server, formID, accountID string) *http.Response {
	t.Helper()
	return postBodyWithCSRF(t, c, srv, "/api/v1/forms/"+formID+"/counters/yandex-metrika/counter",
		`{"accountId":"`+accountID+`"}`)
}

// Создание счётчика — одно действие: счётчик в аккаунте, номер у формы, три цели.
// По отдельности половинки бессмысленны, поэтому и проверяются вместе.
func TestMetrikaCounter_CreatedWithNumberAndGoals(t *testing.T) {
	resetDB(t)
	yandex := newFakeYandexProvider()
	srv := newStackWith(t, &fakeProvider{}, yandex, testEgress())
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	accountID := connectYandex(t, owner, srv)
	formID := newForm(t, wsID, "f-new-counter")

	r := createCounter(t, owner, srv, formID, accountID)
	if r.StatusCode != http.StatusCreated {
		closeBody(t, r)
		t.Fatalf("создание счётчика: статус %d, ожидалось 201", r.StatusCode)
	}
	var got struct {
		Counter  string `json:"counter"`
		Created  int    `json:"created"`
		Existing int    `json:"existing"`
	}
	decode(t, r, &got)
	if got.Counter == "" || got.Created != 3 || got.Existing != 0 {
		t.Fatalf("ответ = %+v, ожидался номер и три заведённые цели", got)
	}
	// Номер стоит у формы: счётчик без него не работает, а связать его с формой
	// потом человеку нечем.
	if c := metrikaOf(t, owner, srv, formID); c == nil || c.Counter != got.Counter || !c.Enabled {
		t.Fatalf("счётчик формы = %+v, ожидался включённый %s", c, got.Counter)
	}
	// Имя и сайт задаёт продукт: название формы в имени и домен страниц форм.
	if yandex.createdName != "Trillix: Опрос" {
		t.Errorf("имя счётчика = %q", yandex.createdName)
	}
	if yandex.createdSite != "f.example" {
		t.Errorf("сайт счётчика = %q, ожидался хост страниц форм без схемы и порта", yandex.createdSite)
	}
}

// Чужая форма — 404 раньше похода в Яндекс: счётчик в чужом аккаунте не заводится
// и наружу ничего не рассказывает.
func TestMetrikaCounter_ForeignFormRefusedBeforeYandex(t *testing.T) {
	resetDB(t)
	yandex := newFakeYandexProvider()
	srv := newStackWith(t, &fakeProvider{}, yandex, testEgress())
	registerUser(t, srv, "owner@example.com")
	ownerForm := newForm(t, personalWorkspace(t), "f-owner-counter")

	stranger := registerUser(t, srv, "stranger@example.com")
	strangerAccount := connectYandex(t, stranger, srv)
	before := yandex.calls

	r := createCounter(t, stranger, srv, ownerForm, strangerAccount)
	closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("чужая форма: статус %d, ожидалось 404", r.StatusCode)
	}
	if yandex.calls != before {
		t.Fatal("постороннего пустили заводить счётчик в Яндексе")
	}
}
