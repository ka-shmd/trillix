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

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/geo"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/token"
	"github.com/ka-shmd/trillix/internal/visits"
	"github.com/ka-shmd/trillix/internal/workspaces"
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
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	visitsSvc := visits.NewService(testPool, formsSvc, entitlements.NewService(testPool, entitlements.Repo{}, time.Now), visits.Repo{}, testGeo(), []byte("dev-only-visitor-secret-not-real"))
	subSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, visitsSvc, pgtest.MailService(testPool),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now), submissions.Repo{}, "http://app.test")

	mux := http.NewServeMux()
	visits.NewPublicHandler(visitsSvc, ratelimit.AllowAll{}, testSecret, false).Routes(mux)
	submissions.NewPublicHandler(subSvc, ratelimit.AllowAll{}, testSecret, submissions.DefaultMinFillTime, false).Routes(mux)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

const oneQuestionSchema = `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`

// twoPageSchema — две страницы: «Имя» на первой, «Телефон» на второй «Контакты».
const twoPageSchema = `{"blocks":[` +
	`{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","settings":{}},` +
	`{"id":"pb1","groupId":"g_pb1","type":"page_break","settings":{"pageName":"Контакты"}},` +
	`{"id":"t_b2","groupId":"g_b2","type":"title","text":[{"t":"Телефон"}]},{"id":"b2","groupId":"g_b2","type":"phone","settings":{}}]}`

// publishedForm создаёт пользователя, форму и публикует её; возвращает slug.
func publishedForm(t *testing.T) string {
	t.Helper()
	return publishedFormWith(t, oneQuestionSchema)
}

// publishedFormWith — то же с заданной схемой.
func publishedFormWith(t *testing.T, schema string) string {
	t.Helper()
	ctx := context.Background()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))

	user, _, err := authSvc.Register(ctx, "vis-"+uuid.NewString()[:8]+"@example.com", "supersecret1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	form, err := formsSvc.Create(ctx, user.ID, "Анкета", nil)
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, user.ID, form.ID, json.RawMessage(schema), form.UpdatedAt); err != nil {
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

// pageBeacon — бикон перехода на страницу: тот же, что beacon, с флагом page.
func pageBeacon(t *testing.T, srv *httptest.Server, slug, visitID string, seq int, blockID string) int {
	t.Helper()
	body := `{"visit_id":"` + visitID + `","token":"` + freshToken() + `","version":1,"seq":` +
		strconv.Itoa(seq) + `,"last_block_id":"` + blockID + `","page":true}`
	resp, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/visits", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post page visit: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

func pathRows(t *testing.T, visitID string) []string {
	t.Helper()
	rows, err := testPool.Query(context.Background(),
		`SELECT block_id FROM form_visit_pages WHERE visit_id = $1 ORDER BY block_id`, visitID)
	if err != nil {
		t.Fatalf("read path: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var b string
		if err := rows.Scan(&b); err != nil {
			t.Fatalf("scan path: %v", err)
		}
		out = append(out, b)
	}
	return out
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
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	return visits.NewService(testPool, formsSvc, entitlements.NewService(testPool, entitlements.Repo{}, time.Now), visits.Repo{}, testGeo(), []byte("dev-only-visitor-secret-not-real"))
}

// setFunnelGate закрывает/открывает воронку на плане воркспейса формы — тем же
// UPDATE, каким владелец включит гейт на проде (гейты приезжают выключенными).
func setFunnelGate(t *testing.T, slug string, allowed bool) {
	t.Helper()
	setGate(t, slug, "analytics_funnel", allowed)
}

// setSourcesGate — то же для источников трафика.
func setSourcesGate(t *testing.T, slug string, allowed bool) {
	t.Helper()
	setGate(t, slug, "analytics_sources", allowed)
}

func setGate(t *testing.T, slug, key string, allowed bool) {
	t.Helper()
	value := "false"
	if allowed {
		value = "true"
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, array[$3::text], $1::jsonb)
		 WHERE code = (SELECT s.plan_code FROM subscriptions s
		               JOIN workspace_members o ON o.user_id = s.user_id AND o.role = 'owner'
		               JOIN forms f ON f.workspace_id = o.workspace_id WHERE f.slug = $2)`,
		value, slug, key); err != nil {
		t.Fatalf("set gate %s: %v", key, err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE plans SET limits = jsonb_set(limits, array[$1::text], 'true')`, key); err != nil {
			t.Fatalf("reset gate %s: %v", key, err)
		}
	})
}

// Воронка закрыта тарифом: чтение отказано (ErrPlanRequired → 402), но ВИЗИТЫ
// продолжают собираться. Это не мелочь, а условие апселла: если бесплатным не
// собирать, в момент показа плашки показывать будет нечего.
func TestFunnel_ClosedByPlan_StillCollectsVisits(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)
	setFunnelGate(t, slug, false)

	for i := 0; i < 3; i++ {
		beacon(t, srv, slug, domain.NewID().String(), 0, "")
	}

	_, err := funnelService().Funnel(context.Background(), userID, formID, domain.Period{}, domain.Segment{})
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("ошибка = %v, ждали domain.ErrPlanRequired", err)
	}

	var visitCount int
	if e := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM form_visits WHERE form_id = $1`, formID).Scan(&visitCount); e != nil {
		t.Fatalf("count visits: %v", e)
	}
	if visitCount != 3 {
		t.Errorf("собрано визитов %d, ожидалось 3: гейт стоит на ЧТЕНИИ, а не на записи", visitCount)
	}

	// Открыли тариф — те же данные показываются, ничего не потеряно.
	setFunnelGate(t, slug, true)
	f, err := funnelService().Funnel(context.Background(), userID, formID, domain.Period{}, domain.Segment{})
	if err != nil {
		t.Fatalf("Funnel после открытия тарифа: %v", err)
	}
	if f.Visits != 3 {
		t.Errorf("воронка показала %d визитов, ожидалось 3", f.Visits)
	}
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

	f, err := funnelService().Funnel(context.Background(), userID, formID, domain.Period{}, domain.Segment{})
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

// Многостраничная форма: шаги-страницы с именем с разрыва, вопросы по страницам.
func TestFunnel_Pages(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedFormWith(t, twoPageSchema)
	formID, userID := formOwner(t, slug)

	// Двое бросили на первой странице, трое дошли до второй, из них один отправил.
	for i := 0; i < 2; i++ {
		id := domain.NewID().String()
		beacon(t, srv, slug, id, 0, "")
		beacon(t, srv, slug, id, 1, "b1")
	}
	for i := 0; i < 3; i++ {
		id := domain.NewID().String()
		beacon(t, srv, slug, id, 0, "")
		beacon(t, srv, slug, id, 1, "b2")
	}

	f, err := funnelService().Funnel(context.Background(), userID, formID, domain.Period{}, domain.Segment{})
	if err != nil {
		t.Fatalf("Funnel: %v", err)
	}
	want := []domain.FunnelPage{
		{Key: "", Label: "Страница 1", Reached: 5, DroppedHere: 2},
		{Key: "pb1", Label: "Контакты", Reached: 3, DroppedHere: 3},
	}
	if len(f.Pages) != len(want) {
		t.Fatalf("страниц %d, ждали %d: %+v", len(f.Pages), len(want), f.Pages)
	}
	for i, w := range want {
		got := f.Pages[i]
		if got.Key != w.Key || got.Label != w.Label || got.Reached != w.Reached || got.DroppedHere != w.DroppedHere {
			t.Errorf("страница %d = %+v, ждали %+v", i, got, w)
		}
	}
	if len(f.Steps) != 2 || f.Steps[1].BlockID != "b2" || f.Steps[1].Page != "pb1" {
		t.Errorf("шаги-вопросы: %+v", f.Steps)
	}
}

// Бикон перехода пишет строку пути; повтор той же страницы второй строки не даёт,
// обычный бикон строк не пишет вовсе.
func TestPath_PageBeaconWritesOneRow(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedFormWith(t, twoPageSchema)

	id := domain.NewID().String()
	for i, send := range []func() int{
		func() int { return beacon(t, srv, slug, id, 0, "") },
		func() int { return beacon(t, srv, slug, id, 1, "b1") },
		func() int { return pageBeacon(t, srv, slug, id, 2, "b2") },
		func() int { return pageBeacon(t, srv, slug, id, 3, "b2") },
		func() int { return beacon(t, srv, slug, id, 4, "b2") },
	} {
		if code := send(); code != http.StatusNoContent {
			t.Fatalf("бикон %d: статус %d, ждали 204", i, code)
		}
	}
	if got := pathRows(t, id); len(got) != 1 || got[0] != "b2" {
		t.Errorf("путь = %v, ждали [b2]", got)
	}
}

// id визита выбирает клиент: бикон перехода ручкой ДРУГОЙ формы с чужим visit_id
// строку пути к чужому визиту не дописывает.
func TestPath_ForeignVisitGetsNoRow(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	victim := publishedFormWith(t, twoPageSchema)
	attacker := publishedFormWith(t, twoPageSchema)

	id := domain.NewID().String()
	beacon(t, srv, victim, id, 0, "")
	pageBeacon(t, srv, attacker, id, 5, "b2")

	if got := pathRows(t, id); len(got) != 0 {
		t.Errorf("к чужому визиту дописан путь %v", got)
	}
}

// Воронка по пути и время на странице — через настоящий SQL. Время бикона ставит
// сервер, поэтому отрезки задаются правкой меток после записи.
func TestFunnel_PathAndPageTimes(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedFormWith(t, twoPageSchema)
	formID, userID := formOwner(t, slug)
	ctx := context.Background()

	// Двое перешли на вторую страницу за 30 и 50 секунд и ушли с неё через 20.
	for _, firstPage := range []int{30, 50} {
		id := domain.NewID().String()
		beacon(t, srv, slug, id, 0, "")
		pageBeacon(t, srv, slug, id, 1, "b2")
		if _, err := testPool.Exec(ctx, `
			UPDATE form_visits SET created_at = now() - make_interval(secs => $2 + 20),
			                       updated_at = now() WHERE id = $1`, id, firstPage); err != nil {
			t.Fatalf("shift visit: %v", err)
		}
		if _, err := testPool.Exec(ctx, `
			UPDATE form_visit_pages SET reached_at = now() - interval '20 seconds',
			       visit_created_at = (SELECT created_at FROM form_visits WHERE id = $1)
			WHERE visit_id = $1`, id); err != nil {
			t.Fatalf("shift path: %v", err)
		}
	}
	// Один ушёл с первой страницы через 7 секунд, пути нет.
	id := domain.NewID().String()
	beacon(t, srv, slug, id, 0, "")
	beacon(t, srv, slug, id, 1, "b1")
	if _, err := testPool.Exec(ctx, `
		UPDATE form_visits SET created_at = now() - interval '7 seconds', updated_at = now() WHERE id = $1`, id); err != nil {
		t.Fatalf("shift visit: %v", err)
	}

	f, err := funnelService().Funnel(ctx, userID, formID, domain.Period{}, domain.Segment{})
	if err != nil {
		t.Fatalf("Funnel: %v", err)
	}
	if len(f.Pages) != 2 {
		t.Fatalf("страниц %d, ждали 2", len(f.Pages))
	}
	first, second := f.Pages[0], f.Pages[1]
	if first.Reached != 3 || first.DroppedHere != 1 || second.Reached != 2 || second.DroppedHere != 2 {
		t.Errorf("страницы: %+v / %+v", first, second)
	}
	if first.TimeSec != 30 || first.TimeSamples != 2 {
		t.Errorf("время первой страницы %d с по %d, ждали 30 по 2 (нижняя медиана 30 и 50)", first.TimeSec, first.TimeSamples)
	}
	if first.LeftTimeSec != 7 || first.LeftSamples != 1 {
		t.Errorf("ушедшие с первой: %d с по %d, ждали 7 по 1", first.LeftTimeSec, first.LeftSamples)
	}
	if second.LeftTimeSec != 20 || second.LeftSamples != 2 {
		t.Errorf("ушедшие со второй: %d с по %d, ждали 20 по 2", second.LeftTimeSec, second.LeftSamples)
	}
}

// Сегменты через настоящий SQL: ключ сегмента в запросах обязан совпасть с тем, как
// Go собирает список сырых значений (domain.SourceKey, CityKey, строки user-agent).
func TestSegment_EndToEnd(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedFormWith(t, twoPageSchema)
	formID, userID := formOwner(t, slug)
	ctx := context.Background()
	const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

	send := func(ua, body string) {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/public/v1/forms/"+slug+"/visits", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", ua)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("post visit: %v", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("бикон: статус %d", resp.StatusCode)
		}
	}
	visit := func(ua string, page bool) string {
		id := domain.NewID().String()
		head := `{"visit_id":"` + id + `","token":"` + freshToken() + `","version":1,`
		send(ua, head+`"seq":0,"last_block_id":null}`)
		if page {
			send(ua, head+`"seq":1,"last_block_id":"b2","page":true}`)
		} else {
			send(ua, head+`"seq":1,"last_block_id":"b1"}`)
		}
		return id
	}
	a := visit(phone, false) // телефон, ушёл с первой страницы
	b := visit(desktop, true)
	c := visit(phone, true) // телефон, дошёл до второй и отправил
	if code := submit(t, srv, slug, c); code != http.StatusCreated {
		t.Fatalf("приём ответа: %d", code)
	}
	if _, err := testPool.Exec(ctx, `UPDATE form_visits SET meta = meta || '{"referer":"https://vk.com/feed"}' WHERE id = $1`, b); err != nil {
		t.Fatal(err)
	}
	if _, err := testPool.Exec(ctx, `UPDATE form_visits SET country_code = 'RU', country = 'Россия', city = 'Москва' WHERE id = $1`, a); err != nil {
		t.Fatal(err)
	}

	svc := funnelService()
	seg := func(raw string) domain.Segment {
		s, err := domain.ParseSegment(raw)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}

	f, err := svc.Funnel(ctx, userID, formID, domain.Period{}, seg("device:Телефон"))
	if err != nil {
		t.Fatalf("Funnel: %v", err)
	}
	if f.Visits != 2 || f.Submitted != 1 || f.Pages[0].Reached != 2 || f.Pages[0].DroppedHere != 1 || f.Pages[1].Reached != 1 {
		t.Errorf("телефоны: визитов %d, отправили %d, страницы %+v", f.Visits, f.Submitted, f.Pages)
	}
	in, err := svc.Insights(ctx, userID, formID, domain.Period{}, seg("device:Компьютер"))
	if err != nil || in.Visits != 1 || in.Submitted != 0 {
		t.Errorf("карточки компьютеров: %+v, %v", in, err)
	}
	for raw, want := range map[string]int{
		"source:vk.com":        1,
		"source:Прямые заходы": 2,
		"country:RU":           1,
		"city:RU:Москва":       1,
		"version:1":            3,
		"version:2":            0,
		"os:BeOS":              0,
	} {
		f, err := svc.Funnel(ctx, userID, formID, domain.Period{}, seg(raw))
		if err != nil || f.Visits != want {
			t.Errorf("%s: визитов %d, ошибка %v; ждали %d", raw, f.Visits, err, want)
		}
	}

	vs, err := svc.Versions(ctx, userID, formID, domain.Period{}, domain.Segment{})
	if err != nil || len(vs) != 1 || vs[0].Number != 1 || vs[0].Visits != 3 || vs[0].Submitted != 1 {
		t.Errorf("версии: %+v, %v", vs, err)
	}
}

// Прошлое окно тем же сканом: визит суточной давности не попадает в текущие сутки,
// но попадает в прошлые; «начали» — тронули вопрос или отправили.
func TestInsights_PreviousWindowSQL(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)
	ctx := context.Background()

	fresh := domain.NewID().String()
	beacon(t, srv, slug, fresh, 0, "")
	beacon(t, srv, slug, fresh, 1, "b1")
	for i := 0; i < 2; i++ {
		old := domain.NewID().String()
		beacon(t, srv, slug, old, 0, "")
		if _, err := testPool.Exec(ctx, `UPDATE form_visits SET created_at = now() - interval '30 hours', updated_at = now() - interval '30 hours' WHERE id = $1`, old); err != nil {
			t.Fatal(err)
		}
	}

	day := domain.Period{From: time.Now().Add(-24 * time.Hour)}
	in, err := funnelService().Insights(ctx, userID, formID, day, domain.Segment{})
	if err != nil {
		t.Fatalf("Insights: %v", err)
	}
	if in.Visits != 1 || in.Started != 1 || in.Previous == nil || in.Previous.Visits != 2 || in.Previous.Started != 0 {
		t.Errorf("сутки: %+v, прошлые: %+v", in, in.Previous)
	}
	all, err := funnelService().Insights(ctx, userID, formID, domain.Period{}, domain.Segment{})
	if err != nil || all.Visits != 3 || all.Previous != nil {
		t.Errorf("всё время: %+v, %v", all, err)
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

	if _, err := funnelService().Funnel(context.Background(), strangerID, formID, domain.Period{}, domain.Segment{}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали ErrNotFound", err)
	}
}

// Форма без визитов: воронка не падает, шаги известны из схемы и нулевые.
func TestFunnel_NoVisits(t *testing.T) {
	resetDB(t)
	newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	f, err := funnelService().Funnel(context.Background(), userID, formID, domain.Period{}, domain.Segment{})
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

// ageVisit отодвигает визит в прошлое: created_at и updated_at сдвигаются на d
// назад, разница между ними сохраняется. Иначе окно наблюдения нечем проверить —
// тест не может ждать сутки.
func ageVisit(t *testing.T, id string, d time.Duration) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`UPDATE form_visits SET created_at = created_at - $2::interval,
		                        updated_at = updated_at - $2::interval
		 WHERE id = $1`, id, d.String())
	if err != nil {
		t.Fatalf("age visit %s: %v", id, err)
	}
}

// Окно наблюдения режет и карточки, и воронку — по created_at визита. Проверяется
// на настоящем SQL: границы едут в запрос как ±бесконечность или как времена, и
// перепутанная граница (>= вместо <) юнитом не ловится вовсе.
func TestInsights_PeriodCutsOldVisits(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	old := domain.NewID().String()
	beacon(t, srv, slug, old, 0, "")
	beacon(t, srv, slug, old, 1, "b1")
	ageVisit(t, old, 10*24*time.Hour)

	fresh := domain.NewID().String()
	beacon(t, srv, slug, fresh, 0, "")
	beacon(t, srv, slug, fresh, 1, "b1")

	svc := funnelService()
	ctx := context.Background()

	all, err := svc.Insights(ctx, userID, formID, domain.Period{}, domain.Segment{})
	if err != nil {
		t.Fatalf("Insights (всё время): %v", err)
	}
	if all.Visits != 2 {
		t.Errorf("визитов за всё время = %d, ждали 2", all.Visits)
	}

	window := domain.Period{From: time.Now().Add(-48 * time.Hour)}
	recent, err := svc.Insights(ctx, userID, formID, window, domain.Segment{})
	if err != nil {
		t.Fatalf("Insights (48 часов): %v", err)
	}
	if recent.Visits != 1 {
		t.Errorf("визитов за 48 часов = %d, ждали 1: старый визит должен выпасть", recent.Visits)
	}

	f, err := svc.Funnel(ctx, userID, formID, window, domain.Segment{})
	if err != nil {
		t.Fatalf("Funnel (48 часов): %v", err)
	}
	if f.Visits != 1 {
		t.Errorf("воронка за 48 часов = %d визитов, ждали 1", f.Visits)
	}
}

// Длительность визита считается по двум биконам, а визит с одним биконом в медиану
// не входит — иначе потерянный pagehide занижал бы её тем сильнее, чем хуже связь
// у респондентов. TimedVisits — знаменатель, который экран показывает рядом.
func TestInsights_DurationCountsOnlyVisitsWithTwoBeacons(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	// Визит с одним биконом: updated_at == created_at.
	beacon(t, srv, slug, domain.NewID().String(), 0, "")

	// Визит с двумя биконами, разведёнными во времени: 30 секунд.
	timed := domain.NewID().String()
	beacon(t, srv, slug, timed, 0, "")
	beacon(t, srv, slug, timed, 1, "b1")
	if _, err := testPool.Exec(context.Background(),
		`UPDATE form_visits SET updated_at = created_at + interval '30 seconds' WHERE id = $1`, timed); err != nil {
		t.Fatalf("set duration: %v", err)
	}

	in, err := funnelService().Insights(context.Background(), userID, formID, domain.Period{}, domain.Segment{})
	if err != nil {
		t.Fatalf("Insights: %v", err)
	}
	if in.Visits != 2 {
		t.Fatalf("визитов = %d, ждали 2", in.Visits)
	}
	if in.TimedVisits != 1 {
		t.Errorf("TimedVisits = %d, ждали 1: визит с одним биконом в медиану не входит", in.TimedVisits)
	}
	if in.MedianDurationSec != 30 {
		t.Errorf("медиана = %v с, ждали 30", in.MedianDurationSec)
	}
}

// Пустая форма отдаёт нули, и ноль медианы при нулевом TimedVisits означает «данных
// нет», а не «визиты длиной ноль» — экран обязан различать это, поэтому знаменатель
// приезжает наружу.
func TestInsights_EmptyFormIsZeroWithoutData(t *testing.T) {
	resetDB(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	in, err := funnelService().Insights(context.Background(), userID, formID, domain.Period{}, domain.Segment{})
	if err != nil {
		t.Fatalf("Insights: %v", err)
	}
	if in.Visits != 0 || in.TimedVisits != 0 || in.MedianDurationSec != 0 {
		t.Fatalf("карточки пустой формы = %+v, ждали нули", in)
	}
}

// beaconFromIP шлёт бикон, представляясь заданным адресом. Заголовок X-Forwarded-For
// читается сервером только при trustedProxy=true — так же, как на проде за Caddy.
func beaconFromIP(t *testing.T, srv *httptest.Server, slug, visitID, ip string) {
	t.Helper()
	body := `{"visit_id":"` + visitID + `","token":"` + freshToken() + `","version":1,"seq":0,"last_block_id":null}`
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/public/v1/forms/"+slug+"/visits", strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", ip)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post visit: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("бикон: статус %d, ждали 204", resp.StatusCode)
	}
}

// beaconWith шлёт бикон с заголовками и метками источника — тем же путём, каким их
// шлёт рендерер. Обычный beacon их не несёт: заголовков у него нет, и в мете
// оказывались бы только пустые строки.
func beaconWith(t *testing.T, srv *httptest.Server, slug, visitID, userAgent, referer string, utm map[string]string) {
	t.Helper()
	utmJSON, err := json.Marshal(utm)
	if err != nil {
		t.Fatalf("marshal utm: %v", err)
	}
	body := `{"visit_id":"` + visitID + `","token":"` + freshToken() +
		`","version":1,"seq":0,"last_block_id":null,"utm":` + string(utmJSON) + `}`
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/public/v1/forms/"+slug+"/visits", strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post visit: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("бикон: статус %d, ждали 204", resp.StatusCode)
	}
}

// Вкладка «Визиты» целиком на настоящих данных: что записал бикон, то и читает
// разбивка. Юнитами это не покрыть — между ними лежат JSONB-мета, group by по
// выражениям и date_trunc.
func TestBreakdown_EndToEnd(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	beaconWith(t, srv, slug, domain.NewID().String(),
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
		"https://vk.com/wall-1", nil)
	beaconWith(t, srv, slug, domain.NewID().String(),
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
		"", map[string]string{"utm_source": "newsletter", "utm_medium": "email"})

	b, err := funnelService().Breakdown(context.Background(), userID, formID, domain.Period{})
	if err != nil {
		t.Fatalf("Breakdown: %v", err)
	}

	if len(b.Timeseries) != 1 || b.Timeseries[0].Visits != 2 {
		t.Errorf("ряд = %+v, ждали одну корзину на 2 визита", b.Timeseries)
	}
	if b.Step != domain.StepDay {
		t.Errorf("шаг = %q, ждали сутки для «всего времени»", b.Step)
	}
	if b.KnownSources != 2 {
		t.Errorf("визитов с источником = %d, ждали 2 (vk.com и newsletter)", b.KnownSources)
	}
	if !hasSource(b.Sources, "newsletter", "email", 1) || !hasSource(b.Sources, "vk.com", "Нет", 1) {
		t.Errorf("источники = %+v, ждали newsletter/email и vk.com", b.Sources)
	}
	if !hasLabel(b.Devices, "Компьютер", 1) || !hasLabel(b.Devices, "Телефон", 1) {
		t.Errorf("устройства = %+v, ждали компьютер и телефон", b.Devices)
	}
	if !hasLabel(b.Browsers, "Chrome", 1) || !hasLabel(b.Browsers, "Safari", 1) {
		t.Errorf("браузеры = %+v, ждали Chrome и Safari", b.Browsers)
	}
	if !hasLabel(b.Systems, "Windows", 1) || !hasLabel(b.Systems, "iOS", 1) {
		t.Errorf("ОС = %+v, ждали Windows и iOS", b.Systems)
	}
}

func hasSource(rows []domain.SourceCount, source, medium string, visits int) bool {
	for _, r := range rows {
		if r.Source == source && r.Medium == medium && r.Visits == visits {
			return true
		}
	}
	return false
}

func hasLabel(rows []domain.LabelCount, label string, visits int) bool {
	for _, r := range rows {
		if r.Label == label && r.Visits == visits {
			return true
		}
	}
	return false
}

// Гейт источников закрывает секцию, но не вкладку — и визиты продолжают
// собираться: платным стал показ разбивки, а не запись (ADR §10).
func TestBreakdown_SourcesClosedByPlan(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)
	beaconWith(t, srv, slug, domain.NewID().String(),
		"Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36", "https://vk.com/x", nil)

	setSourcesGate(t, slug, false)

	b, err := funnelService().Breakdown(context.Background(), userID, formID, domain.Period{})
	if err != nil {
		t.Fatalf("Breakdown: %v", err)
	}
	if !b.SourcesLocked || len(b.Sources) != 0 {
		t.Errorf("источники = %+v (locked=%v), ждали закрытые", b.Sources, b.SourcesLocked)
	}
	if b.KnownSources != 1 {
		t.Errorf("визитов с источником = %d, ждали 1: число показывается и под замком", b.KnownSources)
	}
	if len(b.Browsers) == 0 {
		t.Error("браузеры обязаны остаться — платными объявлялись только источники")
	}
}

// testGeo — справочник для интеграционных тестов. Настоящий файл весит 37 МБ и в
// репозиторий не кладётся, поэтому здесь стоит подделка на два адреса: путь
// «бикон → колонки страны и города» она проверяет ровно так же, а свежесть данных
// справочника тестам не принадлежит (её проверяет отдельный тест в internal/geo,
// когда файл на машине есть).
type testGeoService struct{}

func (testGeoService) Configured() bool { return true }

func (testGeoService) Lookup(ip string) geo.Place {
	switch ip {
	case "77.94.1.1":
		return geo.Place{CountryCode: "RU", Country: "Россия", City: "Москва"}
	case "8.8.8.8":
		return geo.Place{CountryCode: "US", Country: "США", City: "Маунтин-Вью"}
	}
	return geo.Place{}
}

func testGeo() testGeoService { return testGeoService{} }

// newProxiedServer — тот же публичный транспорт, но с trustedProxy=true: только так
// сервер читает адрес из X-Forwarded-For, а тест может представиться чужим IP.
func newProxiedServer(t *testing.T) *httptest.Server {
	t.Helper()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	visitsSvc := visits.NewService(testPool, formsSvc,
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now), visits.Repo{}, testGeo(), []byte("dev-only-visitor-secret-not-real"))

	mux := http.NewServeMux()
	visits.NewPublicHandler(visitsSvc, ratelimit.AllowAll{}, testSecret, true).Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// Сквозной путь гео: бикон с адресом → колонки страны и города → списки на экране.
// Юнитами не покрыть — между ними колонки, частичный индекс и группировка.
//
// И главное, ради чего тест написан: после всего этого в строке визита НЕТ адреса.
func TestGeo_EndToEnd(t *testing.T) {
	resetDB(t)
	srv := newProxiedServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	beaconFromIP(t, srv, slug, domain.NewID().String(), "77.94.1.1")
	beaconFromIP(t, srv, slug, domain.NewID().String(), "77.94.1.1")
	beaconFromIP(t, srv, slug, domain.NewID().String(), "8.8.8.8")
	// Адрес, которого справочник не знает (в тестовой подделке — любой другой):
	// такой визит не попадает ни в одну страну и считается «не определено».
	beaconFromIP(t, srv, slug, domain.NewID().String(), "203.0.113.7")

	b, err := funnelService().Breakdown(context.Background(), userID, formID, domain.Period{})
	if err != nil {
		t.Fatalf("Breakdown: %v", err)
	}

	if len(b.Countries) != 2 {
		t.Fatalf("страны = %+v, ждали две", b.Countries)
	}
	if b.Countries[0].Name != "Россия" || b.Countries[0].Visits != 2 || b.Countries[0].CountryCode != "RU" {
		t.Errorf("первая страна = %+v, ждали Россию с 2 визитами", b.Countries[0])
	}
	if !hasPlace(b.Cities, "Москва", 2) || !hasPlace(b.Cities, "Маунтин-Вью", 1) {
		t.Errorf("города = %+v, ждали Москву (2) и Маунтин-Вью (1)", b.Cities)
	}
	if b.UnknownPlace != 1 {
		t.Errorf("без места = %d, ждали 1: неизвестный адрес не приписывается к соседней стране", b.UnknownPlace)
	}

	// Инвариант приватности: адрес не сохранён ни в одной колонке визита.
	var dump string
	if err := testPool.QueryRow(context.Background(),
		`SELECT coalesce(string_agg(to_jsonb(v)::text, ' '), '') FROM form_visits v WHERE form_id = $1`,
		formID).Scan(&dump); err != nil {
		t.Fatalf("dump visits: %v", err)
	}
	for _, ip := range []string{"77.94.1.1", "8.8.8.8", "203.0.113.7"} {
		if strings.Contains(dump, ip) {
			t.Fatalf("адрес %s сохранён в строке визита — это нарушение ADR §10:\n%s", ip, dump)
		}
	}
}

func hasPlace(rows []domain.PlaceCount, name string, visits int) bool {
	for _, r := range rows {
		if r.Name == name && r.Visits == visits {
			return true
		}
	}
	return false
}

// Сквозной счёт уникальных: три визита одного человека за сутки — один уникальный,
// визит другого — второй. Проверяется на настоящем SQL, потому что вся суть в
// count(DISTINCT ...) и в том, что NULL-ключи он не считает.
func TestUniqueVisitors_EndToEnd(t *testing.T) {
	resetDB(t)
	srv := newProxiedServer(t)
	slug := publishedForm(t)
	formID, userID := formOwner(t, slug)

	// Один человек, три визита (разные id визита — как три открытия страницы).
	for i := 0; i < 3; i++ {
		beaconFromIP(t, srv, slug, domain.NewID().String(), "77.94.1.1")
	}
	// Второй человек.
	beaconFromIP(t, srv, slug, domain.NewID().String(), "8.8.8.8")

	in, err := funnelService().Insights(context.Background(), userID, formID, domain.Period{}, domain.Segment{})
	if err != nil {
		t.Fatalf("Insights: %v", err)
	}
	if in.Visits != 4 {
		t.Fatalf("визитов = %d, ждали 4", in.Visits)
	}
	if in.UniqueVisitors != 2 {
		t.Errorf("уникальных = %d, ждали 2: три визита одного человека — один уникальный",
			in.UniqueVisitors)
	}

	// Инвариант: в строке визита лежит ключ, а не адрес и не user-agent, из которых
	// он собран. Ключ 16 сырых байт и обратно не разворачивается.
	var keys int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM form_visits WHERE form_id = $1 AND length(visitor_key) = 16`,
		formID).Scan(&keys); err != nil {
		t.Fatalf("count keys: %v", err)
	}
	if keys != 4 {
		t.Errorf("ключей = %d, ждали 4 — по одному на визит", keys)
	}
	var dump string
	if err := testPool.QueryRow(context.Background(),
		`SELECT coalesce(string_agg(to_jsonb(v)::text, ' '), '') FROM form_visits v WHERE form_id = $1`,
		formID).Scan(&dump); err != nil {
		t.Fatalf("dump visits: %v", err)
	}
	if strings.Contains(dump, "77.94.1.1") || strings.Contains(dump, "8.8.8.8") {
		t.Fatalf("адрес сохранён в строке визита — нарушение ADR §10:\n%s", dump)
	}
}
