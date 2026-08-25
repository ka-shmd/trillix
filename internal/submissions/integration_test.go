//go:build integration

// Интеграционный тест приёма ответов против настоящего Postgres: сквозная вертикаль
// «создать → опубликовать → отправить ответ → проверить БД». Сетап формы идёт через
// сервисы напрямую (быстрее и без HTTP-обвязки auth), а сам публичный эндпоинт приёма
// — через HTTP, как его увидит рендерер. Живая документация DoD фазы 5.
package submissions_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
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
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, form_versions, submissions, outbox CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// newServer поднимает публичный эндпоинт приёма поверх реального сервиса и пула.
// Лимитер пермиссивный (инвариант 6).
func newServer(t *testing.T) *httptest.Server {
	t.Helper()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	visitsSvc := visits.NewService(testPool, formsSvc, entitlements.NewService(testPool, entitlements.Repo{}, time.Now), visits.Repo{}, nil, nil)
	entSvc := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	subSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, visitsSvc, pgtest.MailService(testPool), entSvc, submissions.Repo{}, "http://app.test")
	h := submissions.NewPublicHandler(subSvc, ratelimit.AllowAll{}, testSecret, submissions.DefaultMinFillTime, false)

	mux := http.NewServeMux()
	h.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// publishedForm создаёт пользователя и форму с одним обязательным полем b1, публикует
// её и возвращает slug и id опубликованной версии.
func publishedForm(t *testing.T, schema string) (slug string, versionID uuid.UUID) {
	t.Helper()
	ctx := context.Background()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))

	user, _, err := authSvc.Register(ctx, "resp-"+uuid.NewString()[:8]+"@example.com", "supersecret1")
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
	pf, err := formsSvc.PublicForm(ctx, form.Slug)
	if err != nil {
		t.Fatalf("resolve published: %v", err)
	}
	return form.Slug, pf.VersionID
}

func freshToken() string { return token.Issue(testSecret, time.Now().Add(-5*time.Second)) }

func postSubmission(t *testing.T, srv *httptest.Server, slug, body string) *http.Response {
	t.Helper()
	resp, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/submissions", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post submission: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func countSubmissions(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM submissions`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

const requiredNameSchema = `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`

// Сквозной успех: валидный ответ ложится в БД с id опубликованной версии.
func TestSubmit_EndToEnd_StoresAnswerWithVersion(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, versionID := publishedForm(t, requiredNameSchema)

	subID := uuid.NewString()
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	resp := postSubmission(t, srv, slug, body)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}

	var gotVersion uuid.UUID
	var answers []byte
	err := testPool.QueryRow(context.Background(),
		`SELECT form_version_id, answers FROM submissions WHERE id = $1`, subID).Scan(&gotVersion, &answers)
	if err != nil {
		t.Fatalf("read submission: %v", err)
	}
	if gotVersion != versionID {
		t.Fatalf("form_version_id = %s, ожидался id опубликованной версии %s", gotVersion, versionID)
	}
	var parsed map[string]any
	if err := json.Unmarshal(answers, &parsed); err != nil || parsed["b1"] != "Анна" {
		t.Fatalf("answers в БД неожиданны: %s (err %v)", answers, err)
	}
}

// Идемпотентность: повтор с тем же submission_id (ретрай после сбоя сети) не создаёт
// второй строки — оба ответа успешны.
func TestSubmit_Idempotent_NoDuplicate(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)

	subID := uuid.NewString()
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	for i := 0; i < 2; i++ {
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("отправка #%d: статус %d, ожидалось 201", i+1, resp.StatusCode)
		}
	}
	if n := countSubmissions(t); n != 1 {
		t.Fatalf("в БД %d строк, ожидалась ровно одна (идемпотентность)", n)
	}
}

// Троттлинг (DoD слайса D): шквал ответов не даёт шквала писем. M ответов на форму
// с включённым уведомлением (по умолчанию) → в outbox ОДНА неотправленная строка с
// count = M, а не M писем. Коалесинг по ключу формы при enqueue.
func TestSubmit_NotifyThrottling_CoalescesIntoOneDigest(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema) // notify_on_submission = true (DEFAULT)

	const M = 5
	for i := 0; i < M; i++ {
		body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Имя"}}`
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("ответ #%d: статус %d, ожидалось 201", i+1, resp.StatusCode)
		}
	}

	var rows, count int
	err := testPool.QueryRow(context.Background(),
		`SELECT count(*), coalesce(max((payload#>>'{data,count}')::int), 0)
		 FROM outbox WHERE sent_at IS NULL AND coalesce_key IS NOT NULL`).Scan(&rows, &count)
	if err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	if rows != 1 {
		t.Fatalf("в outbox %d коалесцируемых строк, ожидалась 1 (шквал → одно письмо)", rows)
	}
	if count != M {
		t.Fatalf("счётчик дайджеста = %d, ожидался %d (по числу ответов)", count, M)
	}
}

// Отклонённый по лимиту ответ не шлёт уведомления: у формы с лимитом 1 первый ответ
// принят (дайджест count=1), второй отклонён (410) — счётчик не растёт, второй строки нет.
func TestSubmit_OverLimit_NoExtraNotification(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	if _, err := testPool.Exec(context.Background(),
		`UPDATE forms SET response_limit = 1 WHERE slug = $1`, slug); err != nil {
		t.Fatalf("set limit: %v", err)
	}

	first := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"A"}}`
	if resp := postSubmission(t, srv, slug, first); resp.StatusCode != http.StatusCreated {
		t.Fatalf("первый ответ: статус %d, ожидалось 201", resp.StatusCode)
	}
	second := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"B"}}`
	if resp := postSubmission(t, srv, slug, second); resp.StatusCode != http.StatusGone {
		t.Fatalf("второй ответ (сверх лимита): статус %d, ожидалось 410", resp.StatusCode)
	}

	var rows, count int
	err := testPool.QueryRow(context.Background(),
		`SELECT count(*), coalesce(max((payload#>>'{data,count}')::int), 0)
		 FROM outbox WHERE coalesce_key IS NOT NULL`).Scan(&rows, &count)
	if err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	if rows != 1 || count != 1 {
		t.Fatalf("дайджестов=%d count=%d, ожидалось 1 и 1 (отклонённый ответ не уведомляет)", rows, count)
	}
}

// Выключенный тумблер: ответ принимается, но письма в outbox нет.
func TestSubmit_NotifyOff_NoOutboxRow(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	turnOffNotify(t, slug)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Имя"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}
	// Считаем только дайджесты ответов (coalesce_key задан): письмо подтверждения
	// email от регистрации владельца в publishedForm тоже лежит в outbox, но с NULL.
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbox WHERE coalesce_key IS NOT NULL`).Scan(&n); err != nil {
		t.Fatalf("count outbox: %v", err)
	}
	if n != 0 {
		t.Fatalf("при выключенном тумблере писем-дайджестов быть не должно, в outbox %d", n)
	}
}

// turnOffNotify выключает уведомления формы прямо в БД (тумблер отдельно тестируется
// на уровне forms; здесь нужен лишь эффект).
func turnOffNotify(t *testing.T, slug string) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE forms SET notify_on_submission = false WHERE slug = $1`, slug); err != nil {
		t.Fatalf("turn off notify: %v", err)
	}
}

// Невалидный ответ (пропущено обязательное поле) → 422, в БД ничего.
func TestSubmit_InvalidAnswer_422NoInsert(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{}}`
	resp := postSubmission(t, srv, slug, body)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422", resp.StatusCode)
	}
	var env struct {
		Error struct {
			Fields map[string]string `json:"fields"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&env); err != nil || env.Error.Fields["b1"] == "" {
		t.Fatalf("ожидалась карта полей с b1, тело/ошибка: %v", err)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("невалидный ответ не должен писаться, в БД %d строк", n)
	}
}

// Honeypot: заполненное скрытое поле → молчаливый 200, в БД ничего.
func TestSubmit_Honeypot_NoInsert(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() +
		`","answers":{"b1":"Анна"},"website":"http://spam.example"}`
	resp := postSubmission(t, srv, slug, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200 (молчаливый honeypot)", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("honeypot-ответ не должен писаться, в БД %d строк", n)
	}
}

// Ответ на закрытую/несуществующую форму → 404 (приватное не раскрывается).
func TestSubmit_UnknownSlug_404(t *testing.T) {
	resetDB(t)
	srv := newServer(t)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{}}`
	resp := postSubmission(t, srv, "nope", body)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404", resp.StatusCode)
	}
}

// setQuota включает лимит ответов на плане, по которому работает воркспейс формы:
// с 0016 это план ВЛАДЕЛЬЦА пространства, отсюда джойн через members. UPDATE —
// тот же, каким гейт включит владелец на проде (приезжают выключенными, спека §8).
func setQuota(t *testing.T, slug string, limit int) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, '{submissions_per_month}', to_jsonb($1::int))
		 WHERE code = (SELECT s.plan_code FROM subscriptions s
		               JOIN workspace_members o ON o.user_id = s.user_id AND o.role = 'owner'
		               JOIN forms f ON f.workspace_id = o.workspace_id WHERE f.slug = $2)`,
		limit, slug); err != nil {
		t.Fatalf("set quota: %v", err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE plans SET limits = jsonb_set(limits, '{submissions_per_month}', 'null')`); err != nil {
			t.Fatalf("reset quota: %v", err)
		}
	})
}

func usage(t *testing.T, slug string) int64 {
	t.Helper()
	var n int64
	err := testPool.QueryRow(context.Background(),
		`SELECT coalesce(sum(u.submissions), 0)::bigint FROM workspace_usage u
		 JOIN forms f ON f.workspace_id = u.workspace_id WHERE f.slug = $1`, slug).Scan(&n)
	if err != nil {
		t.Fatalf("usage: %v", err)
	}
	return n
}

func overQuotaCount(t *testing.T) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM submissions WHERE over_quota`).Scan(&n); err != nil {
		t.Fatalf("count over_quota: %v", err)
	}
	return n
}

// Главный сторож фазы: исчерпанная квота ТАРИФА не закрывает форму. Ответ сверх
// лимита принимается (200), ложится в БД и лишь помечается over_quota — скрытие
// живёт в кабинете владельца. Жёсткий кап формы (response_limit) — другая
// семантика, он действительно отдаёт 410; спутать их нельзя (ADR §10).
func TestSubmit_OverPlanQuota_StillAcceptsAndMarks(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	setQuota(t, slug, 2)

	for i := 1; i <= 3; i++ {
		body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Аня"}}`
		resp := postSubmission(t, srv, slug, body)
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("ответ №%d: статус %d, ожидался 201 — квота тарифа не имеет права отказывать", i, resp.StatusCode)
		}
	}

	if got := countSubmissions(t); got != 3 {
		t.Fatalf("в БД %d ответов, ожидалось 3: ни один ответ респондента не теряется", got)
	}
	if got := overQuotaCount(t); got != 1 {
		t.Errorf("помечено сверхлимитными %d, ожидался 1 (третий)", got)
	}
	if got := usage(t, slug); got != 3 {
		t.Errorf("расход = %d, ожидалось 3: считаются все принятые ответы, а не только влезшие в квоту", got)
	}
}

// Идемпотентный ретрай не растит расход: инкремент читает результат вставки, а
// повтор того же id строки не даёт. Иначе сетевой сбой у респондента съедал бы
// чужую квоту.
func TestSubmit_IdempotentRetry_DoesNotGrowUsage(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)

	id := uuid.NewString()
	body := `{"submission_id":"` + id + `","token":"` + freshToken() + `","answers":{"b1":"Аня"}}`
	for i := 0; i < 3; i++ {
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("ретрай №%d: статус %d, ожидался 201", i, resp.StatusCode)
		}
	}

	if got := countSubmissions(t); got != 1 {
		t.Fatalf("в БД %d строк, ожидалась 1 (идемпотентность)", got)
	}
	if got := usage(t, slug); got != 1 {
		t.Errorf("расход = %d, ожидался 1: ретрай квоту не тратит", got)
	}
}

// Приём в пределах квоты расход считает, но строки не метит.
func TestSubmit_WithinQuota_CountsUsageWithoutMarking(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	setQuota(t, slug, 10)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Аня"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидался 201", resp.StatusCode)
	}
	if got := usage(t, slug); got != 1 {
		t.Errorf("расход = %d, ожидался 1", got)
	}
	if got := overQuotaCount(t); got != 0 {
		t.Errorf("помечено сверхлимитными %d, ожидалось 0", got)
	}
}

// Условная логика на приёме (фаза 21, слайс 2). Форма: «Есть питомец?» (single_choice)
// и обязательный «Какой?» за условием «выбрано Да».
const logicSchema = `{"schemaVersion":1,"blocks":[
	{"id":"pet","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"yes","label":"Да"},{"id":"no","label":"Нет"}]}},
	{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"all":[{"blockId":"pet","op":"is","value":"yes"}]},"then":[{"kind":"show","targets":["kind"]}]}},
	{"id":"kind","groupId":"g2","type":"short_text","required":true,"settings":{}}
]}`

// Сервер не верит клиенту: ответ на скрытый вопрос принимается (респондент не виноват,
// что успел его набрать до переключения источника), но в базу не попадает — иначе
// владелец увидел бы в таблице и CSV ответы на вопросы, которых человек не видел.
func TestSubmit_HiddenAnswer_AcceptedButNotStored(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, logicSchema)

	subID := uuid.NewString()
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() +
		`","answers":{"pet":"no","kind":"Барсик"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}

	var answers []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT answers FROM submissions WHERE id = $1`, subID).Scan(&answers); err != nil {
		t.Fatalf("read submission: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(answers, &parsed); err != nil {
		t.Fatalf("answers: %s (%v)", answers, err)
	}
	if _, hidden := parsed["kind"]; hidden {
		t.Fatalf("ответ на скрытый вопрос сохранён: %s", answers)
	}
	if parsed["pet"] != "no" {
		t.Fatalf("видимый ответ пропал: %s", answers)
	}
}

// Обязательность спрашивается только у видимых: «Какой?» обязателен, но при «Нет» его
// не показывали — форма обязана отправиться.
func TestSubmit_HiddenRequired_DoesNotBlock(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, logicSchema)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() +
		`","answers":{"pet":"no"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 1 {
		t.Fatalf("строк в базе %d, ожидалась 1", n)
	}
}

// Обратная сторона: показанный обязательный вопрос по-прежнему обязателен, и 422
// приходит с ошибкой ровно под его id.
func TestSubmit_VisibleRequired_422(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, logicSchema)

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() +
		`","answers":{"pet":"yes"}}`
	resp := postSubmission(t, srv, slug, body)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("невалидный ответ попал в базу: строк %d", n)
	}
}

// Обязательность по условию (слайс 3): телефон обязателен только при выборе «хочу
// звонок». Проверяем сквозь HTTP, а не только в домене: путь ответа проходит через
// нормализацию, и «обязателен» здесь означает 422 респонденту.
const requiredIfSchema = `{"schemaVersion":1,"blocks":[
	{"id":"how","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"call","label":"Звонок"},{"id":"mail","label":"Почта"}]}},
	{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"all":[{"blockId":"how","op":"is","value":"call"}]},"then":[{"kind":"require","targets":["phone"]}]}},
	{"id":"phone","groupId":"g2","type":"phone","settings":{}}
]}`

func TestSubmit_RequiredIf(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredIfSchema)

	// Условие не сработало — пустой телефон принимается.
	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() +
		`","answers":{"how":"mail"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}

	// Сработало — тот же пустой телефон отвергается.
	body = `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() +
		`","answers":{"how":"call"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 1 {
		t.Fatalf("строк в базе %d, ожидалась 1", n)
	}
}

// Скрытие вариантов (слайс 4): выбранный скрытый вариант не принимается — даже если его
// прислать вручную. Проверяем сквозь HTTP: это про то, что попадёт в базу и в выгрузку.
const optionRuleSchema = `{"schemaVersion":1,"blocks":[
	{"id":"pet","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"dog","label":"Собака"},{"id":"cat","label":"Кот"}]}},
	{"id":"L1","groupId":"gL1","type":"logic","logic":{"when":{"all":[{"blockId":"pet","op":"is","value":"dog"}]},"then":[{"kind":"show","targets":["leash"]}]}},
	{"id":"L2","groupId":"gL2","type":"logic","logic":{"when":{"all":[{"blockId":"pet","op":"is","value":"cat"}]},"then":[{"kind":"show","targets":["tray"]}]}},
	{"id":"stuff","groupId":"g2","type":"multi_choice","settings":{"options":[
		{"id":"leash","label":"Поводок"},
		{"id":"tray","label":"Лоток"},
		{"id":"food","label":"Корм"}
	]}}
]}`

func TestSubmit_HiddenOption_StrippedFromAnswer(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, optionRuleSchema)

	subID := uuid.NewString()
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() +
		`","answers":{"pet":"dog","stuff":["leash","tray","food"]}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}

	var answers []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT answers FROM submissions WHERE id = $1`, subID).Scan(&answers); err != nil {
		t.Fatalf("read submission: %v", err)
	}
	var parsed struct {
		Stuff []string `json:"stuff"`
	}
	if err := json.Unmarshal(answers, &parsed); err != nil {
		t.Fatalf("answers: %s (%v)", answers, err)
	}
	// «Лоток» показывают только владельцу кота — в ответе владельца собаки его быть не
	// может, как бы он туда ни попал.
	if len(parsed.Stuff) != 2 || parsed.Stuff[0] != "leash" || parsed.Stuff[1] != "food" {
		t.Fatalf("варианты в базе: %v, ожидались [leash food]", parsed.Stuff)
	}
}

// Переходы между страницами (слайс 5): страница, которую перескочили, не собрана —
// ответы на её вопросы не сохраняются, а её обязательные поля не мешают отправке.
// Сервер считает обход сам: тело запроса ему в этом не указ.
const jumpSchema = `{"schemaVersion":1,"blocks":[
	{"id":"pet","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"yes","label":"Да"},{"id":"no","label":"Нет"}]}},
	{"id":"L","groupId":"gL","type":"logic","logic":{"when":{"all":[{"blockId":"pet","op":"is","value":"no"}]},"then":[{"kind":"jump","to":"br2"}]}},
	{"id":"br1","groupId":"g2","type":"page_break"},
	{"id":"kind","groupId":"g3","type":"short_text","required":true,"settings":{}},
	{"id":"br2","groupId":"g4","type":"page_break"},
	{"id":"phone","groupId":"g5","type":"phone","settings":{}}
]}`

func TestSubmit_JumpedPage_NotCollected(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, jumpSchema)

	subID := uuid.NewString()
	// «Нет» перескакивает страницу с обязательным «Какой?» — форма обязана отправиться,
	// а присланный ответ на пропущенный вопрос в базу не попасть.
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() +
		`","answers":{"pet":"no","kind":"Барсик","phone":"+7 999 000 00 00"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201", resp.StatusCode)
	}

	var answers []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT answers FROM submissions WHERE id = $1`, subID).Scan(&answers); err != nil {
		t.Fatalf("read submission: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(answers, &parsed); err != nil {
		t.Fatalf("answers: %s (%v)", answers, err)
	}
	if _, jumped := parsed["kind"]; jumped {
		t.Fatalf("ответ с перескоченной страницы сохранён: %s", answers)
	}
	if parsed["phone"] != "+7 999 000 00 00" {
		t.Fatalf("ответ с посещённой страницы пропал: %s", answers)
	}

	// Обратная сторона: без перехода тот же обязательный вопрос обязателен.
	body = `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() +
		`","answers":{"pet":"yes"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422", resp.StatusCode)
	}
}
