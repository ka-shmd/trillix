//go:build integration

// Интеграционные тесты расписаний против настоящего Postgres: реальная вертикаль
// auth + workspaces + booking. Проверяется то, чего не видно на фейках, — права
// двух ролей на живых членствах, анти-IDOR и стоп-кран удаления.
package booking_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/booking"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	pool, stop, err := pgtest.Start(ctx)
	if err != nil {
		panic(err)
	}
	testPool = pool
	code := m.Run()
	stop()
	os.Exit(code)
}

const appOrigin = "http://localhost:5173"

func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, schedules CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newStack — реальная вертикаль поверх контейнерного пула. Лимитеры auth —
// пермиссивные (инвариант 6: лимит не ослабляется ради теста, а инжектируется).
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, appOrigin, false)

	plans := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	wsSvc := workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, plans,
		pgtest.MailService(testPool), appOrigin)

	svc := booking.NewService(testPool, booking.Repo{}, wsSvc, plans)
	h := booking.NewHandler(svc, authH.RequireAuth, authH.RequireCSRF)

	mux := http.NewServeMux()
	authH.Routes(mux)
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// Тело заведения расписания из критерия приёмки: пн–пт 10:00–18:00 с перерывом.
const scheduleBody = `{
  "name": "Мария — рисование",
  "timezone": "Europe/Moscow",
  "availability": {
    "weekly": {
      "mon": [{"from":"10:00","to":"13:00"},{"from":"14:00","to":"18:00"}],
      "tue": [{"from":"10:00","to":"18:00"}]
    },
    "exceptions": [{"date":"2026-09-14","windows":[]}]
  },
  "slotMinutes": 60, "bufferMinutes": 10, "horizonDays": 30, "leadMinutes": 120,
  "capacity": 1, "maxSeatsPerBooking": 1, "showRemaining": false
}`

type scheduleDTO struct {
	ID            string `json:"id"`
	WorkspaceID   string `json:"workspaceId"`
	Name          string `json:"name"`
	Timezone      string `json:"timezone"`
	SlotMinutes   int    `json:"slotMinutes"`
	Capacity      int    `json:"capacity"`
	HorizonDays   int    `json:"horizonDays"`
	ShowRemaining bool   `json:"showRemaining"`
	Availability  struct {
		Weekly     map[string][]struct{ From, To string } `json:"weekly"`
		Exceptions []struct {
			Date    string                      `json:"date"`
			Windows []struct{ From, To string } `json:"windows"`
		} `json:"exceptions"`
	} `json:"availability"`
}

type listDTO struct {
	Items []scheduleDTO `json:"items"`
}

// Полный круг кабинета: завести, прочитать списком, поправить, удалить.
func TestSchedules_CRUD(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	created := createSchedule(t, owner, srv, wsID, scheduleBody)
	if created.Name != "Мария — рисование" || created.SlotMinutes != 60 {
		t.Fatalf("создано %+v — не то, что просили", created)
	}
	if len(created.Availability.Weekly["mon"]) != 2 {
		t.Fatalf("окон понедельника %d, ожидалось 2 (день с перерывом)", len(created.Availability.Weekly["mon"]))
	}
	if len(created.Availability.Exceptions) != 1 {
		t.Fatalf("исключений %d, ожидалось 1", len(created.Availability.Exceptions))
	}

	var got listDTO
	decode(t, do(t, owner, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/schedules"), &got)
	if len(got.Items) != 1 || got.Items[0].ID != created.ID {
		t.Fatalf("список = %+v, ожидалось одно только что заведённое расписание", got.Items)
	}

	patched := patchSchedule(t, owner, srv, created.ID,
		strings.Replace(scheduleBody, `"capacity": 1`, `"capacity": 8`, 1))
	if patched.Capacity != 8 {
		t.Fatalf("вместимость %d, ожидалось 8", patched.Capacity)
	}

	r := deleteWithCSRF(t, owner, srv, "/api/v1/schedules/"+created.ID)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("удаление: статус %d, ожидалось 204", r.StatusCode)
	}
	decode(t, do(t, owner, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/schedules"), &got)
	if len(got.Items) != 0 {
		t.Fatalf("после удаления осталось %d расписаний", len(got.Items))
	}
}

// Битое правило отвергается сервером независимо от фронта (инвариант 3).
func TestSchedules_ValidationRejects(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	cases := []struct {
		name string
		body string
	}{
		{"пересекающиеся окна", strings.Replace(scheduleBody,
			`"mon": [{"from":"10:00","to":"13:00"},{"from":"14:00","to":"18:00"}]`,
			`"mon": [{"from":"10:00","to":"15:00"},{"from":"14:00","to":"18:00"}]`, 1)},
		{"неизвестный пояс", strings.Replace(scheduleBody, `"Europe/Moscow"`, `"Europe/Атлантида"`, 1)},
		{"мест в записи больше вместимости", strings.Replace(scheduleBody,
			`"maxSeatsPerBooking": 1`, `"maxSeatsPerBooking": 4`, 1)},
		{"приём в ноль минут", strings.Replace(scheduleBody, `"slotMinutes": 60`, `"slotMinutes": 0`, 1)},
		{"имя пустое", strings.Replace(scheduleBody, `"Мария — рисование"`, `"   "`, 1)},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			r := postWithCSRF(t, owner, srv, "/api/v1/workspaces/"+wsID+"/schedules", tt.body)
			closeBody(t, r)
			if r.StatusCode != http.StatusUnprocessableEntity {
				t.Fatalf("статус %d, ожидалось 422", r.StatusCode)
			}
		})
	}
}

// Анти-IDOR: id расписания из адреса правом доступа не является. Чужое
// расписание для постороннего неотличимо от несуществующего (инвариант 1 и 5).
func TestSchedules_ForeignWorkspace404(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	created := createSchedule(t, owner, srv, wsID, scheduleBody)

	stranger := registerUser(t, srv, "stranger@example.com")
	for _, tc := range []struct {
		name, method, path, body string
	}{
		{"чтение", http.MethodGet, "/api/v1/schedules/" + created.ID, ""},
		{"правка", http.MethodPatch, "/api/v1/schedules/" + created.ID, scheduleBody},
		{"блокировки", http.MethodGet, "/api/v1/schedules/" + created.ID + "/blocks", ""},
		{"записи", http.MethodGet, "/api/v1/schedules/" + created.ID + "/bookings", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var r *http.Response
			if tc.body == "" {
				r = do(t, stranger, tc.method, srv.URL+tc.path)
			} else {
				r = patchRaw(t, stranger, srv, tc.path, tc.body)
			}
			closeBody(t, r)
			if r.StatusCode != http.StatusNotFound {
				t.Fatalf("статус %d, ожидалось 404", r.StatusCode)
			}
		})
	}

	// И список чужого пространства — тоже 404, а не пустой массив: пустота
	// сообщала бы, что пространство существует.
	r := do(t, stranger, http.MethodGet, srv.URL+"/api/v1/workspaces/"+wsID+"/schedules")
	closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("список чужого пространства: статус %d, ожидалось 404", r.StatusCode)
	}
}

// Редактор пространства расписаниями распоряжается наравне с владельцем: спека
// §9 говорит «как у форм», а форму редактор и правит, и удаляет.
func TestSchedules_EditorMayManage(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")

	created := createSchedule(t, editor, srv, wsID, scheduleBody)
	if created.WorkspaceID != wsID {
		t.Fatalf("расписание заведено в %s, ожидалось %s", created.WorkspaceID, wsID)
	}
	_ = owner

	r := deleteWithCSRF(t, editor, srv, "/api/v1/schedules/"+created.ID)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("удаление редактором: статус %d, ожидалось 204", r.StatusCode)
	}
}

// Ручные блокировки: поставить, увидеть, снять. Чужую снять нельзя.
func TestScheduleBlocks(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	sch := createSchedule(t, owner, srv, wsID, scheduleBody)

	start := time.Now().Add(24 * time.Hour).UTC().Truncate(time.Minute)
	body := fmt.Sprintf(`{"startsAt":%q,"endsAt":%q,"note":"занят"}`,
		start.Format(time.RFC3339), start.Add(time.Hour).Format(time.RFC3339))
	var block struct {
		ID   string `json:"id"`
		Note string `json:"note"`
	}
	r := postWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID+"/blocks", body)
	if r.StatusCode != http.StatusCreated {
		closeBody(t, r)
		t.Fatalf("блокировка: статус %d, ожидалось 201", r.StatusCode)
	}
	decode(t, r, &block)

	var blocks struct {
		Items []struct {
			ID   string `json:"id"`
			Note string `json:"note"`
		} `json:"items"`
	}
	decode(t, do(t, owner, http.MethodGet, srv.URL+"/api/v1/schedules/"+sch.ID+"/blocks"), &blocks)
	if len(blocks.Items) != 1 || blocks.Items[0].ID != block.ID {
		t.Fatalf("блокировки = %+v, ожидалась одна поставленная", blocks.Items)
	}

	// Вывернутая блокировка отвергается.
	bad := fmt.Sprintf(`{"startsAt":%q,"endsAt":%q,"note":""}`,
		start.Add(time.Hour).Format(time.RFC3339), start.Format(time.RFC3339))
	rb := postWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID+"/blocks", bad)
	closeBody(t, rb)
	if rb.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("вывернутая блокировка: статус %d, ожидалось 422", rb.StatusCode)
	}

	rd := deleteWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID+"/blocks/"+block.ID)
	closeBody(t, rd)
	if rd.StatusCode != http.StatusNoContent {
		t.Fatalf("снятие блокировки: статус %d, ожидалось 204", rd.StatusCode)
	}
	// Повторное снятие — 404: снимать больше нечего.
	rd2 := deleteWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID+"/blocks/"+block.ID)
	closeBody(t, rd2)
	if rd2.StatusCode != http.StatusNotFound {
		t.Fatalf("повторное снятие: статус %d, ожидалось 404", rd2.StatusCode)
	}
}

// Стоп-кран удаления: живая БУДУЩАЯ запись отказывает 409, прошлая — не мешает
// (решение владельца 2026-09-03, ADR §10).
func TestSchedules_DeleteBlockedByFutureBooking(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	sch := createSchedule(t, owner, srv, wsID, scheduleBody)
	formID := newForm(t, wsID, "f-booking")

	seedBooking(t, sch.ID, formID, time.Now().Add(48*time.Hour), "confirmed")
	r := deleteWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID)
	body := readAll(t, r)
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("удаление с будущей записью: статус %d, ожидалось 409", r.StatusCode)
	}
	if !strings.Contains(body, "будущая запись") {
		t.Fatalf("текст отказа %q — в нём должно быть число записей человеческими словами", body)
	}

	// Отменённая будущая больше не держит.
	if _, err := testPool.Exec(context.Background(),
		`UPDATE bookings SET status = 'canceled' WHERE schedule_id = $1`, sch.ID); err != nil {
		t.Fatalf("отмена брони: %v", err)
	}
	r2 := deleteWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID)
	closeBody(t, r2)
	if r2.StatusCode != http.StatusNoContent {
		t.Fatalf("удаление после отмены: статус %d, ожидалось 204", r2.StatusCode)
	}
}

func TestSchedules_PastBookingDoesNotBlockDelete(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	sch := createSchedule(t, owner, srv, wsID, scheduleBody)
	formID := newForm(t, wsID, "f-past")

	seedBooking(t, sch.ID, formID, time.Now().Add(-48*time.Hour), "confirmed")
	r := deleteWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("прошлая запись помешала удалению: статус %d, ожидалось 204", r.StatusCode)
	}
}

// Форма со ссылкой на расписание тоже держит удаление — но своим текстом:
// ошибка внешнего ключа автору ничего не объясняет.
func TestSchedules_DeleteBlockedByForm(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	sch := createSchedule(t, owner, srv, wsID, scheduleBody)
	formID := newForm(t, wsID, "f-linked")
	if _, err := testPool.Exec(context.Background(),
		`UPDATE forms SET schedule_id = $1 WHERE id = $2`, sch.ID, formID); err != nil {
		t.Fatalf("привязка формы: %v", err)
	}

	r := deleteWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID)
	body := readAll(t, r)
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("статус %d, ожидалось 409", r.StatusCode)
	}
	if !strings.Contains(body, "1 форма") {
		t.Fatalf("текст отказа %q — ожидалось согласованное число форм", body)
	}
}

// Ближайшие записи и отмена из кабинета. Отменённая из списка уходит, место
// возвращается в оборот, повторная отмена даёт 404.
func TestBookings_UpcomingAndCancel(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	sch := createSchedule(t, owner, srv, wsID, scheduleBody)
	formID := newForm(t, wsID, "f-upcoming")

	future := seedBooking(t, sch.ID, formID, time.Now().Add(24*time.Hour), "confirmed")
	seedBooking(t, sch.ID, formID, time.Now().Add(-24*time.Hour), "confirmed")
	seedBooking(t, sch.ID, formID, time.Now().Add(36*time.Hour), "held")

	var list struct {
		Items []struct {
			ID        string `json:"id"`
			FormTitle string `json:"formTitle"`
			Seats     int    `json:"seats"`
		} `json:"items"`
	}
	decode(t, do(t, owner, http.MethodGet, srv.URL+"/api/v1/schedules/"+sch.ID+"/bookings"), &list)
	if len(list.Items) != 1 || list.Items[0].ID != future {
		// Прошлая не показывается (экран отвечает «кто придёт»), холд — тоже:
		// он ещё не договорённость.
		t.Fatalf("ближайшие = %+v, ожидалась одна будущая подтверждённая", list.Items)
	}
	if list.Items[0].FormTitle == "" {
		t.Fatal("название формы пустое — по столбику времён не понять, откуда запись")
	}

	r := postWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID+"/bookings/"+future+"/cancel", "")
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("отмена: статус %d, ожидалось 204", r.StatusCode)
	}
	decode(t, do(t, owner, http.MethodGet, srv.URL+"/api/v1/schedules/"+sch.ID+"/bookings"), &list)
	if len(list.Items) != 0 {
		t.Fatalf("после отмены осталось %d записей", len(list.Items))
	}

	r2 := postWithCSRF(t, owner, srv, "/api/v1/schedules/"+sch.ID+"/bookings/"+future+"/cancel", "")
	closeBody(t, r2)
	if r2.StatusCode != http.StatusNotFound {
		t.Fatalf("повторная отмена: статус %d, ожидалось 404", r2.StatusCode)
	}
}

// Квота расписаний: ключ приезжает открытым, но включается одним UPDATE — и
// сервис обязан её соблюдать, а не игнорировать.
func TestSchedules_QuotaRefuses(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)

	createSchedule(t, owner, srv, wsID, scheduleBody)
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = limits || '{"booking_schedules_max": 1}'::jsonb`); err != nil {
		t.Fatalf("включение лимита: %v", err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(),
			`UPDATE plans SET limits = limits || '{"booking_schedules_max": null}'::jsonb`)
	})

	r := postWithCSRF(t, owner, srv, "/api/v1/workspaces/"+wsID+"/schedules",
		strings.Replace(scheduleBody, "Мария — рисование", "Пётр — пение", 1))
	body := readAll(t, r)
	if r.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("сверх лимита: статус %d, ожидалось 402", r.StatusCode)
	}
	if !strings.Contains(body, "тариф") {
		t.Fatalf("текст отказа %q — он обязан объяснять, что упёрлись в тариф", body)
	}
}

// --- вспомогательное -------------------------------------------------------

func createSchedule(t *testing.T, c *http.Client, srv *httptest.Server, wsID, body string) scheduleDTO {
	t.Helper()
	r := postWithCSRF(t, c, srv, "/api/v1/workspaces/"+wsID+"/schedules", body)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создание расписания: статус %d (%s), ожидалось 201", r.StatusCode, readAll(t, r))
	}
	var got scheduleDTO
	decode(t, r, &got)
	return got
}

func patchSchedule(t *testing.T, c *http.Client, srv *httptest.Server, id, body string) scheduleDTO {
	t.Helper()
	r := patchRaw(t, c, srv, "/api/v1/schedules/"+id, body)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("правка расписания: статус %d (%s), ожидалось 200", r.StatusCode, readAll(t, r))
	}
	var got scheduleDTO
	decode(t, r, &got)
	return got
}

// seedBooking кладёт бронь напрямую: публичного пути её создания в этом слайсе
// ещё нет (он приезжает слайсами F и G), а кабинету бронь нужна уже сейчас.
func seedBooking(t *testing.T, scheduleID, formID string, startsAt time.Time, status string) string {
	t.Helper()
	id := uuid.New()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO bookings (id, schedule_id, form_id, starts_at, duration_minutes, seats, status, client_id)
		 VALUES ($1, $2, $3, $4, 60, 1, $5, $6)`,
		id, scheduleID, formID, startsAt, status, uuid.New())
	if err != nil {
		t.Fatalf("insert booking: %v", err)
	}
	return id.String()
}

func newForm(t *testing.T, wsID, slug string) string {
	t.Helper()
	id := uuid.New().String()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO forms (id, workspace_id, slug, title) VALUES ($1, $2, $3, 'Запись к мастеру')`,
		id, wsID, slug)
	if err != nil {
		t.Fatalf("insert form: %v", err)
	}
	return id
}

func personalWorkspace(t *testing.T) string {
	t.Helper()
	var id string
	err := testPool.QueryRow(context.Background(),
		`SELECT id FROM workspaces WHERE personal_user_id IS NOT NULL ORDER BY created_at LIMIT 1`).Scan(&id)
	if err != nil {
		t.Fatalf("личное пространство не найдено: %v", err)
	}
	return id
}

func addMember(t *testing.T, wsID, email, role string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO workspace_members (workspace_id, user_id, role)
		 SELECT $1, id, $3 FROM users WHERE email = $2`,
		wsID, email, role)
	if err != nil {
		t.Fatalf("добавление участника: %v", err)
	}
}

func registerUser(t *testing.T, srv *httptest.Server, email string) *http.Client {
	t.Helper()
	c := newClient(t)
	r := doBody(t, c, http.MethodPost, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"supersecret1"}`)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: статус %d, ожидалось 201", email, r.StatusCode)
	}
	closeBody(t, r)
	return c
}

func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	return &http.Client{Jar: jar}
}

func postWithCSRF(t *testing.T, c *http.Client, srv *httptest.Server, path, body string) *http.Response {
	t.Helper()
	return withCSRF(t, c, srv, http.MethodPost, path, body)
}

func patchRaw(t *testing.T, c *http.Client, srv *httptest.Server, path, body string) *http.Response {
	t.Helper()
	return withCSRF(t, c, srv, http.MethodPatch, path, body)
}

func deleteWithCSRF(t *testing.T, c *http.Client, srv *httptest.Server, path string) *http.Response {
	t.Helper()
	return withCSRF(t, c, srv, http.MethodDelete, path, "")
}

func withCSRF(t *testing.T, c *http.Client, srv *httptest.Server, method, path, body string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, srv.URL+path, rdr)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-CSRF-Token", csrf(t, c, srv.URL))
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

func csrf(t *testing.T, c *http.Client, base string) string {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	for _, ck := range c.Jar.Cookies(u) {
		if ck.Name == "csrf_token" {
			return ck.Value
		}
	}
	t.Fatal("csrf_token cookie не выдан")
	return ""
}

func do(t *testing.T, c *http.Client, method, u string) *http.Response {
	return doBody(t, c, method, u, "")
}

func doBody(t *testing.T, c *http.Client, method, u, jsonBody string) *http.Response {
	t.Helper()
	var rdr io.Reader
	if jsonBody != "" {
		rdr = strings.NewReader(jsonBody)
	}
	req, err := http.NewRequest(method, u, rdr)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if jsonBody != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, u, err)
	}
	return resp
}

func decode(t *testing.T, r *http.Response, v any) {
	t.Helper()
	defer closeBody(t, r)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		t.Fatalf("decode тела: %v", err)
	}
}

func readAll(t *testing.T, r *http.Response) string {
	t.Helper()
	defer closeBody(t, r)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return string(b)
}

func closeBody(t *testing.T, r *http.Response) {
	t.Helper()
	if err := r.Body.Close(); err != nil {
		t.Errorf("close body: %v", err)
	}
}
