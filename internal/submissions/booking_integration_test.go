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
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/booking"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/visits"
	"github.com/ka-shmd/trillix/internal/workspaces"
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
	// Почта в ответе обязательна: вопрос о ней есть в каждой форме записи.
	body := fmt.Sprintf(`{"submission_id":%q,"token":%q,"answers":{"s1":%q,"e1":"client@example.com"}}`,
		subID, freshToken(), bookingID.String())
	return postSubmission(t, srv, slug, body)
}

// publishedBookingFormWithEmail — форма с вопросом о записи И вопросом про почту:
// без адреса письма о записи не бывает, а значит, нет и ссылки отмены.
func publishedBookingFormWithEmail(t *testing.T) (slug string, scheduleID, formID uuid.UUID) {
	t.Helper()
	slug, scheduleID, formID = publishedBookingForm(t, 1)
	// Вопрос про почту дописывается в опубликованную версию напрямую: пройти билдер
	// ради одного блока значило бы тестировать не то.
	schema := `{"schemaVersion":1,"blocks":[
		{"id":"t_s1","groupId":"g_s1","type":"title","text":[{"t":"Когда удобно"}]},
		{"id":"s1","groupId":"g_s1","type":"slot","settings":{}},
		{"id":"t_e1","groupId":"g_e1","type":"title","text":[{"t":"Почта"}]},
		{"id":"e1","groupId":"g_e1","type":"email","required":true,"settings":{}}]}`
	if _, err := testPool.Exec(context.Background(),
		`UPDATE form_versions SET schema = $1::jsonb WHERE form_id = $2`, schema, formID); err != nil {
		t.Fatalf("update version schema: %v", err)
	}
	return slug, scheduleID, formID
}

// deleteStack — сервис приёма со стоп-краном и id владельца формы: удаление ответа
// идёт сервисом, а не HTTP, — проверяется правило, а не транспорт.
func deleteStack(t *testing.T, slug string) (*submissions.Service, uuid.UUID) {
	t.Helper()
	plans := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
		plans, "http://localhost:5173")
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{}, wsSvc, plans).
		WithSecret(testSecret)
	visitsSvc := visits.NewService(testPool, formsSvc, plans, visits.Repo{}, nil, nil)
	svc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, visitsSvc,
		pgtest.MailService(testPool), plans, submissions.Repo{}, "http://app.test").
		WithBookingGuard(booking.NewGuard(testPool, booking.Repo{})).
		// Адрес рендерера письму об отмене нужен так же, как письму о записи: его
		// подвал называет форму ссылкой. Без него письма не будет вовсе.
		WithRespondentMail("http://f.test", ratelimit.AllowAll{}).
		WithBookingMail("Trillix <no-reply@trillix.test>")

	var userID uuid.UUID
	if err := testPool.QueryRow(context.Background(),
		`SELECT wm.user_id FROM forms f
		   JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.role = 'owner'
		  WHERE f.slug = $1`, slug).Scan(&userID); err != nil {
		t.Fatalf("read owner: %v", err)
	}
	return svc, userID
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

// СТОП-КРАН УДАЛЕНИЯ ОТВЕТА (фаза 27, ADR §10): живая будущая запись держит, прошлая
// не держит. Проверяется на настоящей базе — счёт делает SQL, а не фейк.
func TestDeleteSubmission_StopCraneOnFutureBooking(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingForm(t, 1)

	subID := uuid.New()
	future := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	bookingID := seedHold(t, scheduleID, formID, subID, future, 1, time.Now().Add(10*time.Minute))
	if resp := submitWithSlot(t, srv, slug, subID.String(), bookingID); resp.StatusCode != http.StatusCreated {
		t.Fatalf("отправка: статус %d", resp.StatusCode)
	}

	svc, userID := deleteStack(t, slug)
	err := svc.DeleteForForm(context.Background(), userID, formID, subID)
	if err == nil {
		t.Fatal("ответ удалён, хотя на него есть будущая запись")
	}
	if !strings.Contains(err.Error(), "будущая запись") {
		t.Fatalf("текст отказа %q — автору нужно сказать, что делать", err.Error())
	}

	// Отменяем запись — и удаление проходит.
	if _, err := testPool.Exec(context.Background(),
		`UPDATE bookings SET status = 'canceled' WHERE id = $1`, bookingID); err != nil {
		t.Fatalf("cancel booking: %v", err)
	}
	if err := svc.DeleteForForm(context.Background(), userID, formID, subID); err != nil {
		t.Fatalf("удаление после отмены отвергнуто: %v", err)
	}
}

// ПИСЬМО О ЗАПИСИ: уходит после принятого ответа, несёт ссылку отмены и приглашение
// календаря методом REQUEST. Не гейтится тарифом и не зависит от тумблеров
// уведомлений — без него у респондента нет ссылки отмены (design/booking.md §4.8).
func TestSubmit_BookingMailWithInvite(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingFormWithEmail(t)

	subID := uuid.New()
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	bookingID := seedHold(t, scheduleID, formID, subID, at, 1, time.Now().Add(10*time.Minute))

	body := fmt.Sprintf(`{"submission_id":%q,"token":%q,"answers":{"s1":%q,"e1":"client@example.com"}}`,
		subID, freshToken(), bookingID.String())
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("отправка: статус %d", resp.StatusCode)
	}

	var payload []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT payload FROM outbox WHERE payload::text LIKE '%booking_confirmed%' LIMIT 1`).Scan(&payload); err != nil {
		t.Fatalf("письмо о записи не поставлено в очередь: %v", err)
	}
	var msg struct {
		To     string            `json:"to"`
		Data   map[string]string `json:"data"`
		Inline []struct {
			Name    string `json:"Name"`
			MIME    string `json:"MIME"`
			Content []byte `json:"Content"`
		} `json:"inline"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil {
		t.Fatalf("payload не разбирается: %v", err)
	}
	if msg.To != "client@example.com" {
		t.Fatalf("адресат %q — ожидался ответ на вопрос-email", msg.To)
	}
	if !strings.Contains(msg.Data["cancel_link"], "/cancel/") {
		t.Fatalf("ссылка отмены %q — без неё место не вернуть в оборот", msg.Data["cancel_link"])
	}
	if len(msg.Inline) != 1 {
		t.Fatalf("вложений %d, ожидалось одно приглашение", len(msg.Inline))
	}
	if !strings.Contains(msg.Inline[0].MIME, "method=REQUEST") {
		t.Fatalf("тип вложения %q — без method клиент не покажет кнопку «Принять»", msg.Inline[0].MIME)
	}
	ics := string(msg.Inline[0].Content)
	if !strings.Contains(ics, "METHOD:REQUEST") || !strings.Contains(ics, "UID:booking-"+bookingID.String()) {
		t.Fatalf("приглашение не то:\n%s", ics)
	}
	assertRenders(t, payload, msg.Data["cancel_link"], "Trillix")
}

// assertRenders — РЕГРЕССИЯ И ГЛАВНАЯ ПРОВЕРКА обоих писем о записи: строка в очереди
// ещё не письмо. Шаблоны заводятся отдельно от констант, и пропущенная запись в карте
// templates даёт ошибку только у Render — то есть у диспетчера, на живом контуре, где
// письмо молча уходит в бесконечный бэкофф. Тест, читающий payload и не зовущий Render,
// такую сборку считает исправной.
func assertRenders(t *testing.T, payload []byte, want ...string) {
	t.Helper()
	var msg mail.EmailMessage
	if err := json.Unmarshal(payload, &msg); err != nil {
		t.Fatalf("payload не разбирается в письмо: %v", err)
	}
	subject, body, err := mail.Render(msg)
	if err != nil {
		t.Fatalf("письмо %q не рендерится, то есть не уйдёт никогда: %v", msg.Template, err)
	}
	if subject == "" {
		t.Error("пустая тема письма")
	}
	for _, w := range want {
		if w == "" {
			continue
		}
		if !strings.Contains(body, w) {
			t.Errorf("тело письма не содержит %q:\n%s", w, body)
		}
	}
}

// ОТМЕНА ГАСИТ СОБЫТИЕ: письмо об отмене несёт тот же UID и БОЛЬШИЙ номер редакции —
// иначе календарь заведёт второе событие вместо того, чтобы убрать первое.
func TestCancel_MailCancelsTheEvent(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingFormWithEmail(t)

	subID := uuid.New()
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	bookingID := seedHold(t, scheduleID, formID, subID, at, 1, time.Now().Add(10*time.Minute))
	body := fmt.Sprintf(`{"submission_id":%q,"token":%q,"answers":{"s1":%q,"e1":"client@example.com"}}`,
		subID, freshToken(), bookingID.String())
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("отправка: статус %d", resp.StatusCode)
	}

	svc, _ := deleteStack(t, slug)
	cancel := booking.NewCancelService(testPool, booking.Repo{},
		booking.DeriveCancelSecret(testSecret)).WithNotifier(svc)
	tok := booking.IssueCancelToken(booking.DeriveCancelSecret(testSecret), bookingID,
		time.Now().Add(booking.CancelTTL))
	if _, err := cancel.Cancel(context.Background(), tok); err != nil {
		t.Fatalf("отмена: %v", err)
	}

	var payload []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT payload FROM outbox WHERE payload::text LIKE '%booking_canceled%' LIMIT 1`).Scan(&payload); err != nil {
		t.Fatalf("письмо об отмене не поставлено: %v", err)
	}
	var msg struct {
		Inline []struct{ Content []byte } `json:"inline"`
	}
	if err := json.Unmarshal(payload, &msg); err != nil || len(msg.Inline) != 1 {
		t.Fatalf("вложение отмены не разобрано: %v", err)
	}
	ics := string(msg.Inline[0].Content)
	for _, want := range []string{"METHOD:CANCEL", "SEQUENCE:1", "UID:booking-" + bookingID.String()} {
		if !strings.Contains(ics, want) {
			t.Fatalf("в отмене нет %q:\n%s", want, ics)
		}
	}
	assertRenders(t, payload, "Trillix")
}

// ОДИН ОТВЕТ ПО ID (2026-09-04, просьба владельца): карточка записи на полотне
// расписания открывает окно ответа тем же компонентом, что и страница ответов, — но
// у неё в руках только id, а страница рисует окно из уже загруженной страницы списка.
//
// Права проверяются так же, как у списка: доступ даёт членство в пространстве ФОРМЫ,
// а id ответа из адреса правом не является — form_id стоит и в самом запросе.
func TestGetSubmission_ByID(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, scheduleID, formID := publishedBookingFormWithEmail(t)

	subID := uuid.New()
	at := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Minute)
	bookingID := seedHold(t, scheduleID, formID, subID, at, 1, time.Now().Add(10*time.Minute))
	body := fmt.Sprintf(`{"submission_id":%q,"token":%q,"answers":{"s1":%q,"e1":"client@example.com"}}`,
		subID, freshToken(), bookingID.String())
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("отправка: статус %d", resp.StatusCode)
	}

	svc, userID := deleteStack(t, slug)
	ctx := context.Background()

	row, _, err := svc.GetForForm(ctx, userID, formID, subID)
	if err != nil {
		t.Fatalf("ответ не отдан: %v", err)
	}
	if row.ID != subID {
		t.Fatalf("отдан ответ %s, спрашивали %s", row.ID, subID)
	}
	if !strings.Contains(string(row.Answers), "client@example.com") {
		t.Fatalf("в ответе нет ответов респондента: %s", row.Answers)
	}
	if row.FormVersion == 0 {
		t.Fatal("номер версии формы не заполнен — окно ответа его показывает")
	}

	// Несуществующий id — 404, а не пустой ответ.
	if _, _, err := svc.GetForForm(ctx, userID, formID, uuid.New()); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("несуществующий ответ: ошибка %v, ожидался ErrNotFound", err)
	}

	// Ответ ЧУЖОЙ формы по верному id не отдаётся: form_id стоит в запросе.
	otherSlug, _ := publishedForm(t, `{"blocks":[{"id":"q1","groupId":"g1","type":"short_text"}]}`)
	var otherFormID uuid.UUID
	if err := testPool.QueryRow(ctx, `SELECT id FROM forms WHERE slug = $1`, otherSlug).Scan(&otherFormID); err != nil {
		t.Fatalf("read other form: %v", err)
	}
	if _, _, err := svc.GetForForm(ctx, userID, otherFormID, subID); err == nil {
		t.Fatal("ответ отдан по чужой форме")
	}

	// Посторонний не получает ничего — и не отличает «нет доступа» от «нет такого»
	// (инварианты 1 и 5). Владелец другой формы здесь и есть посторонний для этой.
	var strangerID uuid.UUID
	if err := testPool.QueryRow(ctx,
		`SELECT wm.user_id FROM forms f
		   JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.role = 'owner'
		  WHERE f.slug = $1`, otherSlug).Scan(&strangerID); err != nil {
		t.Fatalf("read stranger: %v", err)
	}
	if _, _, err := svc.GetForForm(ctx, strangerID, formID, subID); err == nil {
		t.Fatal("чужой ответ отдан постороннему")
	}
}
