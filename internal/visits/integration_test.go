//go:build integration

// Интеграционный тест визитов против настоящего Postgres. Проверяет то, что нельзя
// проверить юнитом: поведение апсерта на конкурентных и не по порядку приехавших
// биконах, изоляцию визитов разных форм и сквозную конверсию «бикон → ответ».
package visits_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/forms"
	"github.com/ka-shmd/trierra/internal/pgtest"
	"github.com/ka-shmd/trierra/internal/postgres"
	"github.com/ka-shmd/trierra/internal/ratelimit"
	"github.com/ka-shmd/trierra/internal/submissions"
	"github.com/ka-shmd/trierra/internal/token"
	"github.com/ka-shmd/trierra/internal/visits"
)

var (
	testPool   *pgxpool.Pool
	testSecret = []byte("dev-only-form-token-secret-not-a-real-key")
)

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

func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, form_versions, submissions, form_visits CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newServer поднимает обе публичные ручки — визитов и приёма ответа — поверх
// реальных сервисов: конверсия проверяется ровно тем путём, которым ходит рендерер.
// Лимитеры пермиссивные (инвариант 6: лимит не ослабляется, а подменяется).
func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})
	visitsSvc := visits.NewService(testPool, formsSvc, visits.Repo{})
	subSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, visitsSvc, submissions.Repo{})

	mux := http.NewServeMux()
	visits.NewPublicHandler(visitsSvc, ratelimit.AllowAll{}, testSecret, false).Routes(mux)
	submissions.NewPublicHandler(subSvc, ratelimit.AllowAll{}, testSecret, submissions.DefaultMinFillTime, false).Routes(mux)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

const oneQuestionSchema = `{"blocks":[{"id":"b1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}}]}`

// publishedForm создаёт пользователя, форму и публикует её; возвращает slug.
func publishedForm(t *testing.T) string {
	t.Helper()
	ctx := context.Background()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, time.Hour)
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})

	user, _, err := authSvc.Register(ctx, "vis-"+uuid.NewString()[:8]+"@example.com", "supersecret1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	form, err := formsSvc.Create(ctx, user.ID, "Анкета")
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, user.ID, form.ID, json.RawMessage(oneQuestionSchema), form.UpdatedAt); err != nil {
		t.Fatalf("save schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, user.ID, form.ID); err != nil {
		t.Fatalf("publish: %v", err)
	}
	return form.Slug
}

func freshToken() string { return token.Issue(testSecret, time.Now()) }

// beacon шлёт бикон визита и возвращает статус.
func beacon(t *testing.T, srv *httptest.Server, slug, visitID string, seq int, lastBlockID string) int {
	t.Helper()
	body := `{"visit_id":"` + visitID + `","token":"` + freshToken() + `","version":1,"seq":` +
		strconv.Itoa(seq) + `,"last_block_id":` + jsonBlock(lastBlockID) + `}`
	resp, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/visits", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post visit: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

func jsonBlock(id string) string {
	if id == "" {
		return "null"
	}
	return `"` + id + `"`
}

// visitRow — состояние визита в БД.
type visitRow struct {
	lastBlockID *string
	seq         int16
	submitted   bool
}

func readVisit(t *testing.T, id string) visitRow {
	t.Helper()
	var row visitRow
	err := testPool.QueryRow(context.Background(),
		`SELECT last_block_id, seq, submitted FROM form_visits WHERE id = $1`, id).
		Scan(&row.lastBlockID, &row.seq, &row.submitted)
	if err != nil {
		t.Fatalf("read visit %s: %v", id, err)
	}
	return row
}

// Бикон «открыли» создаёт визит; второй бикон двигает его до последнего вопроса.
// Это нормальный путь: одна строка на визит, а не две.
func TestVisit_SecondBeaconMovesVisitForward(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	visitID := domain.NewID().String()

	if code := beacon(t, srv, slug, visitID, 0, ""); code != http.StatusNoContent {
		t.Fatalf("бикон открытия: статус %d, ждали 204", code)
	}
	if code := beacon(t, srv, slug, visitID, 1, "b1"); code != http.StatusNoContent {
		t.Fatalf("бикон ухода: статус %d, ждали 204", code)
	}

	got := readVisit(t, visitID)
	if got.lastBlockID == nil || *got.lastBlockID != "b1" {
		t.Errorf("last_block_id = %v, ждали b1", got.lastBlockID)
	}
	if got.seq != 1 {
		t.Errorf("seq = %d, ждали 1", got.seq)
	}
	if n := countVisits(t); n != 1 {
		t.Errorf("визитов в БД = %d, ждали 1 (апсерт, а не вставка)", n)
	}
}

// Ради этого заведена колонка seq: бикон с меньшим номером, доехавший последним
// (sendBeacon порядок не гарантирует, visibilitychange шлёт по одному на каждое
// переключение вкладки), НЕ обязан отбрасывать визит назад по воронке.
func TestVisit_OutOfOrderBeaconDoesNotRewind(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	visitID := domain.NewID().String()

	beacon(t, srv, slug, visitID, 0, "")
	beacon(t, srv, slug, visitID, 2, "b1") // дошёл до вопроса
	beacon(t, srv, slug, visitID, 1, "")   // ранний бикон, доехавший позже

	got := readVisit(t, visitID)
	if got.lastBlockID == nil || *got.lastBlockID != "b1" {
		t.Fatalf("last_block_id = %v, ждали b1: поздний ранний бикон откатил визит назад", got.lastBlockID)
	}
	if got.seq != 2 {
		t.Errorf("seq = %d, ждали 2", got.seq)
	}
}

// id визита выбирает клиент, а UUIDv7 угадываем по временно́му префиксу. Бикон,
// отправленный на ЧУЖУЮ форму с тем же id, не должен править существующий визит.
func TestVisit_CrossFormUpsertIsIgnored(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slugA, slugB := publishedForm(t), publishedForm(t)
	visitID := domain.NewID().String()

	beacon(t, srv, slugA, visitID, 0, "")
	beacon(t, srv, slugB, visitID, 5, "b1") // атака: тот же id, другая форма

	got := readVisit(t, visitID)
	if got.lastBlockID != nil {
		t.Errorf("last_block_id = %v, ждали nil: визит формы A изменён ручкой формы B", got.lastBlockID)
	}
	if got.seq != 0 {
		t.Errorf("seq = %d, ждали 0", got.seq)
	}
	if n := countVisits(t); n != 1 {
		t.Errorf("визитов = %d, ждали 1", n)
	}
}

// Сквозная конверсия: визит → ответ с visit_id → submitted = true. Это и есть
// «точная конверсия вместо деления двух независимых счётчиков».
func TestVisit_SubmitMarksConversion(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	visitID := domain.NewID().String()

	beacon(t, srv, slug, visitID, 0, "")
	if code := submit(t, srv, slug, visitID); code != http.StatusCreated {
		t.Fatalf("приём ответа: статус %d, ждали 201", code)
	}

	if got := readVisit(t, visitID); !got.submitted {
		t.Fatal("submitted = false: конверсия визита не отмечена")
	}
}

// Поздний бикон (человек закрыл вкладку уже после отправки) не имеет права снять
// уже засчитанную конверсию: апсерт трогает только last_block_id и seq.
func TestVisit_LateBeaconDoesNotResetSubmitted(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	visitID := domain.NewID().String()

	beacon(t, srv, slug, visitID, 0, "")
	submit(t, srv, slug, visitID)
	beacon(t, srv, slug, visitID, 3, "b1") // pagehide уже после отправки

	got := readVisit(t, visitID)
	if !got.submitted {
		t.Fatal("submitted сброшен поздним биконом — конверсия потеряна")
	}
	if got.lastBlockID == nil || *got.lastBlockID != "b1" {
		t.Errorf("last_block_id = %v, ждали b1 (продвижение работать должно)", got.lastBlockID)
	}
}

// Ответ без visit_id (бикон не дошёл, страница из кэша прежней версии рендерера)
// принимается как раньше — аналитика не влияет на приём данных.
func TestVisit_SubmitWithoutVisitIDStillAccepted(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)

	if code := submit(t, srv, slug, ""); code != http.StatusCreated {
		t.Fatalf("статус %d, ждали 201: ответ без visit_id обязан приниматься", code)
	}
}

// Подделанный/неизвестный visit_id тоже не отклоняет ответ: 0 помеченных строк —
// штатный исход, а не ошибка.
func TestVisit_SubmitWithUnknownVisitIDStillAccepted(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)

	if code := submit(t, srv, slug, domain.NewID().String()); code != http.StatusCreated {
		t.Fatalf("статус %d, ждали 201: неизвестный visit_id не повод потерять ответ", code)
	}
	if n := countVisits(t); n != 0 {
		t.Errorf("визитов = %d, ждали 0: чужой id не должен создавать строк", n)
	}
}

func submit(t *testing.T, srv *httptest.Server, slug, visitID string) int {
	t.Helper()
	// Токен приёма ответа обязан быть старше minFillTime (антиспам) — в отличие от
	// бикона, который уходит сразу после выдачи.
	tok := token.Issue(testSecret, time.Now().Add(-5*time.Second))
	body := `{"submission_id":"` + domain.NewID().String() + `","token":"` + tok +
		`","answers":{"b1":"Анна"},"visit_id":"` + visitID + `"}`
	resp, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/submissions", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post submission: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

func countVisits(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM form_visits`).Scan(&n); err != nil {
		t.Fatalf("count visits: %v", err)
	}
	return n
}

// --- Воронка (шаг 6б) ---

// formOwner возвращает id формы и её владельца по slug: воронку читает автор, и
// сервис авторизует доступ по членству в воркспейсе.
func formOwner(t *testing.T, slug string) (formID, userID uuid.UUID) {
	t.Helper()
	err := testPool.QueryRow(context.Background(),
		`SELECT f.id, m.user_id FROM forms f
		 JOIN workspace_members m ON m.workspace_id = f.workspace_id
		 WHERE f.slug = $1`, slug).Scan(&formID, &userID)
	if err != nil {
		t.Fatalf("form owner by slug: %v", err)
	}
	return formID, userID
}

func funnelService() *visits.Service {
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})
	return visits.NewService(testPool, formsSvc, visits.Repo{})
}

// Сквозная воронка: визиты с разной дальней точкой раскладываются по шагам, а
// отправивший НЕ считается отвалом на последнем вопросе, которого коснулся.
func TestFunnel_EndToEnd(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	// Трое ушли, не тронув вопросов.
	for i := 0; i < 3; i++ {
		beacon(t, srv, slug, domain.NewID().String(), 0, "")
	}
	// Двое дошли до вопроса и бросили.
	for i := 0; i < 2; i++ {
		id := domain.NewID().String()
		beacon(t, srv, slug, id, 0, "")
		beacon(t, srv, slug, id, 1, "b1")
	}
	// Один дошёл до того же вопроса и отправил форму.
	sender := domain.NewID().String()
	beacon(t, srv, slug, sender, 0, "")
	beacon(t, srv, slug, sender, 1, "b1")
	if code := submit(t, srv, slug, sender); code != http.StatusCreated {
		t.Fatalf("приём ответа: статус %d, ждали 201", code)
	}

	f, err := funnelService().Funnel(context.Background(), userID, formID)
	if err != nil {
		t.Fatalf("Funnel: %v", err)
	}

	if f.Visits != 6 || f.Submitted != 1 {
		t.Errorf("верх воронки = %d визитов / %d отправок, ждали 6/1", f.Visits, f.Submitted)
	}
	if f.LeftBeforeFirst != 3 {
		t.Errorf("LeftBeforeFirst = %d, ждали 3", f.LeftBeforeFirst)
	}
	if len(f.Steps) == 0 {
		t.Fatal("шагов нет — модель вопросов пуста")
	}
	step := f.Steps[0]
	if step.BlockID != "b1" {
		t.Fatalf("первый шаг = %q, ждали b1", step.BlockID)
	}
	if step.Reached != 3 {
		t.Errorf("Reached = %d, ждали 3 (двое бросили + один отправил)", step.Reached)
	}
	// Ядро шага: отправивший коснулся b1 последним, но отвалом не является.
	if step.DroppedHere != 2 {
		t.Errorf("DroppedHere = %d, ждали 2: отправивший не отвал", step.DroppedHere)
	}
}

// Воронка чужой формы недоступна — 404, существование формы не раскрывается.
func TestFunnel_ForeignFormIsNotFound(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	formID, _ := formOwner(t, slug)
	beacon(t, srv, slug, domain.NewID().String(), 0, "")

	// Владелец другой формы — посторонний для этой.
	_, strangerID := formOwner(t, publishedForm(t))

	if _, err := funnelService().Funnel(context.Background(), strangerID, formID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали ErrNotFound", err)
	}
}

// Форма без визитов: воронка не падает, шаги известны из схемы и нулевые.
func TestFunnel_NoVisits(t *testing.T) {
	resetDB(t)
	newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	f, err := funnelService().Funnel(context.Background(), userID, formID)
	if err != nil {
		t.Fatalf("Funnel: %v", err)
	}
	if f.Visits != 0 || f.LeftBeforeFirst != 0 {
		t.Errorf("ждали нули наверху воронки, получили %+v", f)
	}
	if len(f.Steps) == 0 {
		t.Fatal("шаги обязаны быть известны из схемы даже без визитов")
	}
	if f.Steps[0].Reached != 0 || f.Steps[0].DroppedHere != 0 {
		t.Errorf("шаг не нулевой: %+v", f.Steps[0])
	}
}
