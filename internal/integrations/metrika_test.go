package integrations

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// fakeMetrika — API управления Метрики на httptest-сервере плюс запись того, что
// ему прислали: проверяются и разбор ответа, и сам запрос.
type fakeMetrika struct {
	countersQuery url.Values
	authHeader    string
	// goalsPath — по какому адресу спрашивали цели: в нём номер счётчика.
	goalsPath string
	// created — тела заведения целей в порядке отправки.
	created []metrikaGoalEnvelope

	countersStatus int
	countersBody   string
	goalsBody      string
	createStatus   int
	createBody     string
}

func newFakeMetrika(t *testing.T, f *fakeMetrika) *Yandex {
	t.Helper()
	if f.countersBody == "" {
		f.countersBody = `{"counters":[]}`
	}
	if f.goalsBody == "" {
		f.goalsBody = `{"goals":[]}`
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/counters", func(w http.ResponseWriter, r *http.Request) {
		f.countersQuery = r.URL.Query()
		f.authHeader = r.Header.Get("Authorization")
		if f.countersStatus != 0 {
			w.WriteHeader(f.countersStatus)
		}
		_, _ = w.Write([]byte(f.countersBody))
	})
	mux.HandleFunc("/counter/{id}/goals", func(w http.ResponseWriter, r *http.Request) {
		f.goalsPath = r.URL.Path
		f.authHeader = r.Header.Get("Authorization")
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(f.goalsBody))
			return
		}
		body, _ := io.ReadAll(r.Body)
		var env metrikaGoalEnvelope
		if err := json.Unmarshal(body, &env); err != nil {
			t.Errorf("тело заведения цели не разбирается: %v", err)
		}
		f.created = append(f.created, env)
		if f.createStatus != 0 {
			w.WriteHeader(f.createStatus)
		}
		if f.createBody != "" {
			_, _ = w.Write([]byte(f.createBody))
			return
		}
		_, _ = w.Write([]byte(`{"goal":{"id":1}}`))
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	y := NewYandex("client-id", "client-secret", "https://app.example/cb")
	y.metrikaURL = srv.URL
	return y
}

// Список счётчиков: только те, где аккаунт вправе править цели, и только живые.
// Счётчик с правом «только просмотр» в списке означал бы отказ Яндекса ПОСЛЕ
// выбора — на шаге, где человек считает настройку законченной.
func TestMetrika_ListCounters(t *testing.T) {
	f := &fakeMetrika{countersBody: `{"counters":[
		{"id":12345678,"name":"Сайт агентства","site2":{"site":"agency.example"}},
		{"id":999,"name":"Лендинг","site2":{"site":"land.example"}}
	]}`}
	y := newFakeMetrika(t, f)

	list, err := y.ListCounters(context.Background(), "ya-at")
	if err != nil {
		t.Fatalf("ListCounters: %v", err)
	}
	want := []MetrikaCounter{
		{ID: 12345678, Name: "Сайт агентства", Site: "agency.example"},
		{ID: 999, Name: "Лендинг", Site: "land.example"},
	}
	if len(list) != len(want) {
		t.Fatalf("счётчики = %+v", list)
	}
	for i := range want {
		if list[i] != want[i] {
			t.Errorf("счётчик %d = %+v, ожидался %+v", i, list[i], want[i])
		}
	}
	if got := f.countersQuery.Get("permission"); got != "own,edit" {
		t.Errorf("permission = %q — в списке окажутся счётчики без права правки", got)
	}
	if got := f.countersQuery.Get("status"); got != "Active" {
		t.Errorf("status = %q, ожидалось Active", got)
	}
	if f.authHeader != "OAuth ya-at" {
		t.Errorf("Authorization = %q, ожидалось «OAuth <токен>»", f.authHeader)
	}
}

// Цели заводятся по одной, в счётчик из аргумента, с типом «JavaScript-событие»
// и условием точного совпадения с идентификатором.
func TestMetrika_EnsureGoals_CreatesAll(t *testing.T) {
	f := &fakeMetrika{}
	y := newFakeMetrika(t, f)

	res, err := y.EnsureGoals(context.Background(), "ya-at", 12345678, metrikaGoals)
	if err != nil {
		t.Fatalf("EnsureGoals: %v", err)
	}
	if res.Created != 3 || res.Existing != 0 {
		t.Fatalf("итог = %+v, ожидалось «завели три»", res)
	}
	if f.goalsPath != "/counter/12345678/goals" {
		t.Fatalf("адрес целей = %q — цели уехали не в тот счётчик", f.goalsPath)
	}
	if len(f.created) != 3 {
		t.Fatalf("заведено тел = %d", len(f.created))
	}
	first := f.created[0].Goal
	if first.Type != "action" {
		t.Errorf("тип цели = %q, ожидалось action (JavaScript-событие)", first.Type)
	}
	if first.Name != "Trillix: форму открыли" {
		t.Errorf("имя цели = %q", first.Name)
	}
	if len(first.Conditions) != 1 || first.Conditions[0].Type != "exact" || first.Conditions[0].URL != "trillix_open" {
		t.Errorf("условие цели = %+v, ожидалось точное совпадение с идентификатором", first.Conditions)
	}
	for i, want := range []string{"trillix_open", "trillix_start", "trillix_submit"} {
		if got := f.created[i].Goal.Conditions[0].URL; got != want {
			t.Errorf("цель %d = %q, ожидалась %q", i, got, want)
		}
	}
}

// Цель, заведённая автором руками, считается заведённой — как бы она ни
// называлась. Иначе второй формой с тем же счётчиком в отчётах Метрики
// появлялись бы два столбца, каждый со своей половиной правды.
func TestMetrika_EnsureGoals_SkipsExistingUnderAnyName(t *testing.T) {
	f := &fakeMetrika{goalsBody: `{"goals":[
		{"id":1,"name":"Открытие формы","type":"action","conditions":[{"type":"exact","url":"trillix_open"}]},
		{"id":2,"name":"Отправка","type":"action","conditions":[{"type":"exact","url":"trillix_submit"}]}
	]}`}
	y := newFakeMetrika(t, f)

	res, err := y.EnsureGoals(context.Background(), "ya-at", 42, metrikaGoals)
	if err != nil {
		t.Fatalf("EnsureGoals: %v", err)
	}
	if res.Created != 1 || res.Existing != 2 {
		t.Fatalf("итог = %+v, ожидалось «одна заведена, две уже были»", res)
	}
	if len(f.created) != 1 || f.created[0].Goal.Conditions[0].URL != "trillix_start" {
		t.Fatalf("заведено = %+v, ожидалась только недостающая цель", f.created)
	}
}

// Похожая, но чужая цель заведённой не считается: событие с другим условием
// (вхождение вместо точного совпадения) или цель другого типа с тем же адресом
// нашего идентификатора не отмечают.
func TestMetrika_EnsureGoals_ForeignGoalIsNotOurs(t *testing.T) {
	f := &fakeMetrika{goalsBody: `{"goals":[
		{"id":1,"name":"Похожая","type":"action","conditions":[{"type":"contain","url":"trillix_open"}]},
		{"id":2,"name":"Страница","type":"url","conditions":[{"type":"exact","url":"trillix_start"}]}
	]}`}
	y := newFakeMetrika(t, f)

	res, err := y.EnsureGoals(context.Background(), "ya-at", 42, metrikaGoals)
	if err != nil {
		t.Fatalf("EnsureGoals: %v", err)
	}
	if res.Created != 3 || res.Existing != 0 {
		t.Fatalf("итог = %+v, ожидалось «завели все три»", res)
	}
}

// Отказ Метрики — окончательный: ждать и повторять нечего, нужен человек. Причина
// из тела доезжает до ЛОГА (на экран ей нельзя — она английская).
func TestMetrika_ListCounters_AccessDenied(t *testing.T) {
	y := newFakeMetrika(t, &fakeMetrika{
		countersStatus: http.StatusForbidden,
		countersBody:   `{"errors":[{"error_type":"access_denied","message":"Access is denied"}],"message":"Access is denied"}`,
	})

	_, err := y.ListCounters(context.Background(), "ya-at")
	if !errors.Is(err, ErrPermanent) {
		t.Fatalf("err = %v, ожидался окончательный отказ", err)
	}
	if !strings.Contains(err.Error(), "Access is denied") {
		t.Fatalf("err = %v — причина отказа не доехала до лога", err)
	}
}

// Отказ на середине не выдаёт заведённое за незаведённое: часть целей уже в
// счётчике, и повтор их не тронет.
func TestMetrika_EnsureGoals_PartialFailure(t *testing.T) {
	f := &fakeMetrika{goalsBody: `{"goals":[
		{"id":1,"name":"Открытие","type":"action","conditions":[{"type":"exact","url":"trillix_open"}]}
	]}`, createStatus: http.StatusForbidden, createBody: `{"message":"Access is denied"}`}
	y := newFakeMetrika(t, f)

	res, err := y.EnsureGoals(context.Background(), "ya-at", 42, metrikaGoals)
	if err == nil {
		t.Fatal("ожидалась ошибка")
	}
	if res.Existing != 1 || res.Created != 0 {
		t.Fatalf("итог = %+v, ожидалось «одна уже была, ни одной не завели»", res)
	}
}
