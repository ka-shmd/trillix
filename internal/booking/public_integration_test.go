//go:build integration

// Публичный контур записи против настоящего Postgres (фаза 27, слайс F): четыре
// отказа, выдача свободного времени, холд и гонка за последнее место.
//
// Гонка проверяется НАСТОЯЩИМИ параллельными запросами к настоящей базе: advisory-lock
// живёт в ней, и на фейках его проверять нечем.
package booking_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/booking"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// Понедельник 2026-09-07, 08:00 МСК — то же «сейчас», что у доменных тестов.
var testNow = time.Date(2026, 9, 7, 5, 0, 0, 0, time.UTC)

// newPublicStack — публичная половина записи поверх контейнерного пула. Лимитеры
// пермиссивные (инвариант 6); тест ведра ставит свои осознанно.
func newPublicStack(t *testing.T, list, hold booking.RateLimiter) *httptest.Server {
	t.Helper()
	plans := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, plans,
		pgtest.MailService(testPool), appOrigin)
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{}, wsSvc, plans)

	svc := booking.NewPublicService(testPool, postgres.TxRunner{Pool: testPool}, booking.Repo{}, formsSvc).
		WithClock(func() time.Time { return testNow })
	h := booking.NewPublicHandler(svc, list, hold, false)

	mux := http.NewServeMux()
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func permissive() booking.RateLimiter { return ratelimit.AllowAll{} }

// seedForm — опубликованная форма с расписанием: пн–пт 10:00–18:00, приём час.
func seedForm(t *testing.T, opts seedOpts) (slug string, scheduleID string) {
	t.Helper()
	ctx := context.Background()
	wsID := uuid.New()
	userID := uuid.New()
	if _, err := testPool.Exec(ctx,
		`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`,
		userID, fmt.Sprintf("owner-%s@example.com", userID)); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`INSERT INTO workspaces (id, name, slug, personal_user_id) VALUES ($1, 'Личное', $2, $3)`,
		wsID, "w-"+uuid.New().String()[:8], userID); err != nil {
		t.Fatalf("insert workspace: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
		wsID, userID); err != nil {
		t.Fatalf("insert member: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`INSERT INTO subscriptions (user_id, plan_code) VALUES ($1, 'free')
		 ON CONFLICT (user_id) DO NOTHING`, userID); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}

	schID := uuid.New()
	if !opts.noSchedule {
		capacity := opts.capacity
		if capacity == 0 {
			capacity = 1
		}
		maxSeats := opts.maxSeats
		if maxSeats == 0 {
			maxSeats = 1
		}
		availability := `{"weekly":{"mon":[{"from":"10:00","to":"18:00"}],"tue":[{"from":"10:00","to":"18:00"}]},"exceptions":[]}`
		if _, err := testPool.Exec(ctx,
			`INSERT INTO schedules (id, workspace_id, name, timezone, availability,
			   slot_minutes, buffer_minutes, horizon_days, lead_minutes, capacity, max_seats_per_booking, show_remaining)
			 VALUES ($1, $2, 'Мария — рисование', 'Europe/Moscow', $3::jsonb, 60, 0, 30, 0, $4, $5, true)`,
			schID, wsID, availability, capacity, maxSeats); err != nil {
			t.Fatalf("insert schedule: %v", err)
		}
	}

	formID := uuid.New()
	slug = "s-" + uuid.New().String()[:8]
	status := "published"
	if opts.draft {
		status = "draft"
	}
	if _, err := testPool.Exec(ctx,
		`INSERT INTO forms (id, workspace_id, slug, title, status, password, schedule_id)
		 VALUES ($1, $2, $3, 'Запись', $4, $5, $6)`,
		formID, wsID, slug, status, opts.password, nullUUID(schID, opts.noSchedule)); err != nil {
		t.Fatalf("insert form: %v", err)
	}
	if !opts.draft {
		versionID := uuid.New()
		if _, err := testPool.Exec(ctx,
			`INSERT INTO form_versions (id, form_id, version, schema) VALUES ($1, $2, 1, $3::jsonb)`,
			versionID, formID, `{"schemaVersion":1,"blocks":[{"id":"s1","groupId":"g1","type":"slot","settings":{}}]}`); err != nil {
			t.Fatalf("insert version: %v", err)
		}
		if _, err := testPool.Exec(ctx,
			`UPDATE forms SET published_version_id = $1 WHERE id = $2`, versionID, formID); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	if opts.closed {
		if _, err := testPool.Exec(ctx, `UPDATE forms SET status = 'closed' WHERE id = $1`, formID); err != nil {
			t.Fatalf("close form: %v", err)
		}
	}
	return slug, schID.String()
}

type seedOpts struct {
	draft      bool
	closed     bool
	noSchedule bool
	password   []byte
	capacity   int
	maxSeats   int
}

func nullUUID(id uuid.UUID, isNull bool) any {
	if isNull {
		return nil
	}
	return id
}

type slotsBody struct {
	Items []struct {
		StartsAt  string `json:"startsAt"`
		Remaining int    `json:"remaining"`
	} `json:"items"`
}

func getSlots(t *testing.T, srv *httptest.Server, slug string, client string) (*http.Response, slotsBody) {
	t.Helper()
	url := srv.URL + "/public/v1/forms/" + slug + "/slots"
	if client != "" {
		url += "?client=" + client
	}
	r, err := http.Get(url) //nolint:noctx // тестовый вызов
	if err != nil {
		t.Fatalf("GET slots: %v", err)
	}
	var body slotsBody
	if r.StatusCode == http.StatusOK {
		defer closeBody(t, r)
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode slots: %v", err)
		}
	}
	return r, body
}

func postHold(t *testing.T, srv *httptest.Server, slug, startsAt string, seats int, client string) *http.Response {
	t.Helper()
	body := fmt.Sprintf(`{"startsAt":%q,"seats":%d,"clientId":%q}`, startsAt, seats, client)
	r, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/slots/hold", "application/json", //nolint:noctx // тестовый вызов
		strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST hold: %v", err)
	}
	return r
}

// Свободное время: рабочий день режется на часы, суббота не предлагается.
func TestSlots_FreeTimeOfWorkingDays(t *testing.T) {
	resetDB(t)
	srv := newPublicStack(t, permissive(), permissive())
	slug, _ := seedForm(t, seedOpts{})

	r, body := getSlots(t, srv, slug, "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", r.StatusCode)
	}
	if r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q — свободное время кэшировать нельзя", r.Header.Get("Cache-Control"))
	}
	if len(body.Items) == 0 {
		t.Fatal("свободного времени нет вовсе")
	}
	// Понедельник 10:00 МСК = 07:00 UTC — первый слот горизонта.
	if got := body.Items[0].StartsAt; got != "2026-09-07T07:00:00Z" {
		t.Fatalf("первый слот %s, ожидался понедельник 10:00 МСК", got)
	}
	for _, it := range body.Items {
		at, err := time.Parse(time.RFC3339, it.StartsAt)
		if err != nil {
			t.Fatalf("время %q не разбирается", it.StartsAt)
		}
		if wd := at.In(time.FixedZone("MSK", 3*3600)).Weekday(); wd == time.Saturday || wd == time.Sunday {
			t.Fatalf("в выдаче выходной: %s", it.StartsAt)
		}
	}
}

// Четыре отказа — те же, что у отдачи формы (design/booking.md §7). Разойдись они,
// ручка стала бы оракулом: отвечала бы иначе там, где отдача формы отвечает 404.
func TestSlots_RefusesLikeFormItself(t *testing.T) {
	cases := []struct {
		name string
		opts seedOpts
		want int
	}{
		{"черновик", seedOpts{draft: true}, http.StatusNotFound},
		{"закрытая форма", seedOpts{closed: true}, http.StatusGone},
		{"форма без расписания", seedOpts{noSchedule: true}, http.StatusNotFound},
		// Пароль — 401, а не 404: форма опубликована, её существование не скрывается,
		// а человеку есть что предъявить (design/form-password.md §2.3). Шифротекст
		// подставной: до расшифровки дело не доходит — токена в запросе нет вовсе.
		{"форма под паролем", seedOpts{password: []byte("шифротекст")}, http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetDB(t)
			srv := newPublicStack(t, permissive(), permissive())
			slug, _ := seedForm(t, tc.opts)

			r, _ := getSlots(t, srv, slug, "")
			closeBody(t, r)
			if r.StatusCode != tc.want {
				t.Fatalf("статус %d, ожидалось %d", r.StatusCode, tc.want)
			}
			// Холд обязан отвечать ТЕМ ЖЕ: два входа, один список отказов.
			rh := postHold(t, srv, slug, "2026-09-07T07:00:00Z", 1, uuid.New().String())
			closeBody(t, rh)
			if rh.StatusCode != tc.want {
				t.Fatalf("холд: статус %d, ожидалось %d", rh.StatusCode, tc.want)
			}
		})
	}
}

// Несуществующая форма неотличима от черновика.
func TestSlots_UnknownSlug404(t *testing.T) {
	resetDB(t)
	srv := newPublicStack(t, permissive(), permissive())

	r, _ := getSlots(t, srv, "нет-такой", "")
	closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404", r.StatusCode)
	}
}

// Холд занимает место: слот с вместимостью 1 уходит из выдачи, а второй клиент
// получает отказ.
func TestHold_TakesTheSlot(t *testing.T) {
	resetDB(t)
	srv := newPublicStack(t, permissive(), permissive())
	slug, _ := seedForm(t, seedOpts{})
	const at = "2026-09-07T07:00:00Z"

	first := postHold(t, srv, slug, at, 1, uuid.New().String())
	closeBody(t, first)
	if first.StatusCode != http.StatusCreated {
		t.Fatalf("первый холд: статус %d, ожидалось 201", first.StatusCode)
	}

	second := postHold(t, srv, slug, at, 1, uuid.New().String())
	closeBody(t, second)
	if second.StatusCode != http.StatusConflict {
		t.Fatalf("второй холд: статус %d, ожидалось 409", second.StatusCode)
	}

	_, body := getSlots(t, srv, slug, "")
	for _, it := range body.Items {
		if it.StartsAt == at {
			t.Fatal("занятое время всё ещё предлагается")
		}
	}
}

// Свой холд не мешает СЕБЕ: человек, вернувшийся к списку, обязан снова увидеть
// время, которое сам же держит, — иначе при вместимости 1 отпущенный слот пропадал бы
// у него на четверть часа.
func TestSlots_OwnHoldStaysVisible(t *testing.T) {
	resetDB(t)
	srv := newPublicStack(t, permissive(), permissive())
	slug, _ := seedForm(t, seedOpts{})
	client := uuid.New().String()
	const at = "2026-09-07T07:00:00Z"

	closeBody(t, postHold(t, srv, slug, at, 1, client))

	_, mine := getSlots(t, srv, slug, client)
	found := false
	for _, it := range mine.Items {
		if it.StartsAt == at {
			found = true
		}
	}
	if !found {
		t.Fatal("собственное придержанное время пропало из выдачи")
	}
}

// Передумавший переносит СВОЮ бронь, а не заводит вторую (частичный уникальный
// индекс 0050).
func TestHold_SameClientMovesItsBooking(t *testing.T) {
	resetDB(t)
	srv := newPublicStack(t, permissive(), permissive())
	slug, scheduleID := seedForm(t, seedOpts{})
	client := uuid.New().String()

	closeBody(t, postHold(t, srv, slug, "2026-09-07T07:00:00Z", 1, client))
	r := postHold(t, srv, slug, "2026-09-07T08:00:00Z", 1, client)
	closeBody(t, r)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("перенос холда: статус %d, ожидалось 201", r.StatusCode)
	}

	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM bookings WHERE schedule_id = $1 AND status = 'held'`, scheduleID).Scan(&n); err != nil {
		t.Fatalf("count bookings: %v", err)
	}
	if n != 1 {
		t.Fatalf("броней %d, ожидалась одна — передумавший переносит свою", n)
	}
}

// ГОНКА: двое берут последнее место одновременно. Один получает 201, другой — 409, и
// сумма занятых мест равна вместимости, НЕ больше (критерий приёмки, спека §1).
func TestHold_RaceForTheLastSeat(t *testing.T) {
	resetDB(t)
	srv := newPublicStack(t, permissive(), permissive())
	slug, scheduleID := seedForm(t, seedOpts{capacity: 3, maxSeats: 3})
	const at = "2026-09-07T07:00:00Z"

	// Два места уже заняты — свободно ровно одно.
	closeBody(t, postHold(t, srv, slug, at, 2, uuid.New().String()))

	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := postHold(t, srv, slug, at, 1, uuid.New().String())
			codes[i] = r.StatusCode
			closeBody(t, r)
		}(i)
	}
	wg.Wait()

	created, refused := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusCreated:
			created++
		case http.StatusConflict, http.StatusUnprocessableEntity:
			refused++
		default:
			t.Fatalf("неожиданный статус %d", c)
		}
	}
	if created != 1 || refused != 1 {
		t.Fatalf("создано %d, отказано %d — ожидалось ровно по одному", created, refused)
	}

	var seats int
	if err := testPool.QueryRow(context.Background(),
		`SELECT coalesce(sum(seats), 0) FROM bookings
		 WHERE schedule_id = $1 AND starts_at = $2 AND status <> 'canceled'`,
		scheduleID, at).Scan(&seats); err != nil {
		t.Fatalf("sum seats: %v", err)
	}
	if seats != 3 {
		t.Fatalf("занято мест %d, вместимость 3 — перебор недопустим", seats)
	}
}

// Время вне окон приёма не придерживается: «свободное» считает сервер, а не браузер.
func TestHold_RefusesTimeOutsideSchedule(t *testing.T) {
	resetDB(t)
	srv := newPublicStack(t, permissive(), permissive())
	slug, _ := seedForm(t, seedOpts{})

	// Понедельник 03:00 МСК — за окном приёма.
	r := postHold(t, srv, slug, "2026-09-07T00:00:00Z", 1, uuid.New().String())
	closeBody(t, r)
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("статус %d, ожидалось 409", r.StatusCode)
	}
}

// Ведро холда списывается ДО любой проверки: перебором нельзя заблокировать форму, но
// и сам перебор упирается в стену.
func TestHold_RateLimited(t *testing.T) {
	resetDB(t)
	// Ведро на одну попытку — инжектируется осознанно, а не ослабляется (инвариант 6).
	srv := newPublicStack(t, permissive(), ratelimit.NewTokenBucket(0, 1))
	slug, _ := seedForm(t, seedOpts{})

	first := postHold(t, srv, slug, "2026-09-07T07:00:00Z", 1, uuid.New().String())
	closeBody(t, first)
	if first.StatusCode != http.StatusCreated {
		t.Fatalf("первый холд: статус %d, ожидалось 201", first.StatusCode)
	}
	second := postHold(t, srv, slug, "2026-09-07T08:00:00Z", 1, uuid.New().String())
	closeBody(t, second)
	if second.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("второй холд: статус %d, ожидалось 429", second.StatusCode)
	}
}
