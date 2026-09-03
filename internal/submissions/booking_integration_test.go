//go:build integration

// Подтверждение записи в приёме ответа (фаза 27, слайс G) против настоящего Postgres.
//
// Проверяется то, чего не видно на фейках: что бронь и ответ ложатся ОДНОЙ
// транзакцией, что ретрай не занимает второго места и что гонка двух приёмов за
// последнее место разрешается локом, а не удачей.
package submissions_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Схема формы с вопросом о записи. Вопрос необязательный: обязательность к
// подтверждению отношения не имеет, а лишний required усложнил бы тела запросов.
const slotSchema = `{"blocks":[
	{"id":"t_s1","groupId":"g_s1","type":"title","text":[{"t":"Когда удобно"}]},
	{"id":"s1","groupId":"g_s1","type":"slot","settings":{}}]}`

// publishedBookingForm — форма с вопросом о записи и выбранным расписанием.
//
// Расписание привязывается ДО публикации намеренно: гейт публикации (фаза 27, слайс D)
// не выпускает форму с вопросом о времени и пустым расписанием, и обойти его тест не
// вправе — он проверяет приём ответа, а не гейт.
func publishedBookingForm(t *testing.T, capacity int) (slug string, scheduleID, formID uuid.UUID) {
	t.Helper()
	slug, _ = publishedFormWithSchedule(t, capacity)
	ctx := context.Background()
	if err := testPool.QueryRow(ctx,
		`SELECT id, schedule_id FROM forms WHERE slug = $1`, slug).Scan(&formID, &scheduleID); err != nil {
		t.Fatalf("read form: %v", err)
	}
	return slug, scheduleID, formID
}

// seedSchedule заводит расписание в пространстве формы и привязывает его к ней.
func seedSchedule(t *testing.T, slug string, capacity int) (scheduleID, formID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	var wsID uuid.UUID
	if err := testPool.QueryRow(ctx,
		`SELECT id, workspace_id FROM forms WHERE slug = $1`, slug).Scan(&formID, &wsID); err != nil {
		t.Fatalf("read form: %v", err)
	}
	scheduleID = uuid.New()
	if _, err := testPool.Exec(ctx,
		`INSERT INTO schedules (id, workspace_id, name, timezone, availability,
		   slot_minutes, buffer_minutes, horizon_days, lead_minutes, capacity, max_seats_per_booking, show_remaining)
		 VALUES ($1, $2, 'Мария', 'Europe/Moscow', '{"weekly":{},"exceptions":[]}'::jsonb,
		         60, 0, 30, 0, $3, $3, false)`,
		scheduleID, wsID, capacity); err != nil {
		t.Fatalf("insert schedule: %v", err)
	}
	if _, err := testPool.Exec(ctx,
		`UPDATE forms SET schedule_id = $1 WHERE id = $2`, scheduleID, formID); err != nil {
		t.Fatalf("attach schedule: %v", err)
	}
	return scheduleID, formID
}

// seedHold кладёт холд напрямую: публичная ручка холда живёт в другом модуле, а
// проверяется здесь именно ПОДТВЕРЖДЕНИЕ.
func seedHold(t *testing.T, scheduleID, formID, clientID uuid.UUID, startsAt time.Time, seats int, expires time.Time) uuid.UUID {
	t.Helper()
	id := uuid.New()
	if _, err := testPool.Exec(context.Background(),
		`INSERT INTO bookings (id, schedule_id, form_id, starts_at, duration_minutes, seats, status, hold_expires_at, client_id)
		 VALUES ($1, $2, $3, $4, 60, $5, 'held', $6, $7)`,
		id, scheduleID, formID, startsAt, seats, expires, clientID); err != nil {
		t.Fatalf("insert hold: %v", err)
	}
	return id
}

func bookingRow(t *testing.T, id uuid.UUID) (status string, submissionID *uuid.UUID) {
	t.Helper()
	var sub *uuid.UUID
	if err := testPool.QueryRow(context.Background(),
		`SELECT status, submission_id FROM bookings WHERE id = $1`, id).Scan(&status, &sub); err != nil {
		t.Fatalf("read booking: %v", err)
	}
	return status, sub
}

func submitWithSlot(t *testing.T, srv *httptest.Server, slug, subID string, bookingID uuid.UUID) *http.Response {
	t.Helper()
	body := fmt.Sprintf(`{"submission_id":%q,"token":%q,"answers":{"s1":%q}}`,
		subID, freshToken(), bookingID.String())
	return postSubmission(t, srv, slug, body)
}

// Приём ответа делает холд записью, а в ОТВЕТЕ оказывается ВРЕМЯ, а не id брони
// (design/booking.md §5.6).
func TestSubmit_ConfirmsBookingAndStoresTime(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingForm(t, 1)

	subID := uuid.New()
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	bookingID := seedHold(t, scheduleID, formID, subID, at, 1, time.Now().Add(10*time.Minute))

	resp := submitWithSlot(t, srv, slug, subID.String(), bookingID)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}

	status, gotSub := bookingRow(t, bookingID)
	if status != "confirmed" {
		t.Fatalf("статус брони %q, ожидался confirmed", status)
	}
	if gotSub == nil || *gotSub != subID {
		t.Fatalf("submission_id брони = %v, ожидался %s", gotSub, subID)
	}

	var answers []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT answers FROM submissions WHERE id = $1`, subID).Scan(&answers); err != nil {
		t.Fatalf("read submission: %v", err)
	}
	var parsed map[string]string
	if err := json.Unmarshal(answers, &parsed); err != nil {
		t.Fatalf("answers не разбираются: %s", answers)
	}
	if parsed["s1"] == bookingID.String() {
		t.Fatal("в ответе лежит id брони — сервер обязан переписать его временем")
	}
	if got, err := time.Parse(time.RFC3339, parsed["s1"]); err != nil || !got.Equal(at) {
		t.Fatalf("в ответе %q, ожидалось время записи %s", parsed["s1"], at.Format(time.RFC3339))
	}
}

// Ретрай отправки (тот же id ответа) второго места не занимает: ни второй строки
// ответа, ни второй брони.
func TestSubmit_RetryDoesNotTakeSecondSeat(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingForm(t, 1)

	subID := uuid.New()
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	bookingID := seedHold(t, scheduleID, formID, subID, at, 1, time.Now().Add(10*time.Minute))

	for i := range 2 {
		resp := submitWithSlot(t, srv, slug, subID.String(), bookingID)
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("отправка %d: статус %d, ожидалось 201", i+1, resp.StatusCode)
		}
	}

	if n := countSubmissions(t); n != 1 {
		t.Fatalf("ответов %d, ожидался один", n)
	}
	var seats int
	if err := testPool.QueryRow(context.Background(),
		`SELECT coalesce(sum(seats), 0) FROM bookings WHERE schedule_id = $1 AND status = 'confirmed'`,
		scheduleID).Scan(&seats); err != nil {
		t.Fatalf("sum seats: %v", err)
	}
	if seats != 1 {
		t.Fatalf("занято мест %d, ожидалось одно — ретрай второго места не занимает", seats)
	}
}

// ИСТЁКШИЙ ХОЛД ПЕРЕЗАНИМАЕТСЯ, если место свободно (решение владельца 2026-09-03):
// длинная анкета и возврат к черновику штатны, а отказ на кнопке «Отправить» —
// ровно то, ради чего холд заводился.
func TestSubmit_ExpiredHoldIsRetaken(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingForm(t, 1)

	subID := uuid.New()
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	// Срок вышел час назад.
	bookingID := seedHold(t, scheduleID, formID, subID, at, 1, time.Now().Add(-time.Hour))

	resp := submitWithSlot(t, srv, slug, subID.String(), bookingID)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201 — место свободно, отказывать не за что", resp.StatusCode)
	}
	if status, _ := bookingRow(t, bookingID); status != "confirmed" {
		t.Fatalf("статус брони %q, ожидался confirmed", status)
	}
}

// Тот же истёкший холд, но место успели занять: отказ, и он правдив.
func TestSubmit_ExpiredHoldRefusedWhenTaken(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingForm(t, 1)

	subID := uuid.New()
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	bookingID := seedHold(t, scheduleID, formID, subID, at, 1, time.Now().Add(-time.Hour))
	// Чужая подтверждённая запись на то же время.
	other := seedHold(t, scheduleID, formID, uuid.New(), at, 1, time.Now().Add(time.Hour))
	if _, err := testPool.Exec(context.Background(),
		`UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL WHERE id = $1`, other); err != nil {
		t.Fatalf("confirm other: %v", err)
	}

	resp := submitWithSlot(t, srv, slug, subID.String(), bookingID)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("статус %d, ожидалось 409", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("ответов %d — при отказе брони ответ не принимается", n)
	}
}

// Чужая бронь по угаданному id не подтверждается: id приезжает в ОТВЕТЕ, то есть
// недоверенным вводом (инвариант 1).
func TestSubmit_ForeignBookingRefused(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingForm(t, 1)

	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	// Бронь другого клиента.
	foreign := seedHold(t, scheduleID, formID, uuid.New(), at, 1, time.Now().Add(time.Hour))

	resp := submitWithSlot(t, srv, slug, uuid.New().String(), foreign)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422", resp.StatusCode)
	}
	if status, _ := bookingRow(t, foreign); status != "held" {
		t.Fatalf("статус чужой брони %q — её не должны были тронуть", status)
	}
}

// ГОНКА ДВУХ ПРИЁМОВ за последнее место: оба холда истекли, свободно одно место.
// Один ответ принят, второй отвергнут, сумма мест равна вместимости.
func TestSubmit_RaceOnExpiredHolds(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingForm(t, 1)

	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	subs := [2]uuid.UUID{uuid.New(), uuid.New()}
	var books [2]uuid.UUID
	for i := range subs {
		books[i] = seedHold(t, scheduleID, formID, subs[i], at, 1, time.Now().Add(-time.Hour))
	}

	var wg sync.WaitGroup
	codes := [2]int{}
	for i := range subs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = submitWithSlot(t, srv, slug, subs[i].String(), books[i]).StatusCode
		}(i)
	}
	wg.Wait()

	created, refused := 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusCreated:
			created++
		case http.StatusConflict:
			refused++
		default:
			t.Fatalf("неожиданный статус %d", c)
		}
	}
	if created != 1 || refused != 1 {
		t.Fatalf("принято %d, отказано %d — ожидалось ровно по одному", created, refused)
	}

	var seats int
	if err := testPool.QueryRow(context.Background(),
		`SELECT coalesce(sum(seats), 0) FROM bookings WHERE schedule_id = $1 AND status = 'confirmed'`,
		scheduleID).Scan(&seats); err != nil {
		t.Fatalf("sum seats: %v", err)
	}
	if seats != 1 {
		t.Fatalf("подтверждено мест %d, вместимость 1 — перебор недопустим", seats)
	}
	if n := countSubmissions(t); n != 1 {
		t.Fatalf("ответов %d, ожидался один", n)
	}
}
