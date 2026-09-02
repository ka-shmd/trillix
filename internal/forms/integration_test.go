//go:build integration

// Интеграционный тест forms против настоящего Postgres в контейнере: реальная
// вертикаль auth+forms (регистрация → CRUD форм), с упором на изоляцию
// воркспейсов (анти-IDOR: пользователь A не видит и не трогает форму B → 404).
package forms_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/ai"
	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/token"
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

func resetDB(t *testing.T) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`TRUNCATE users, workspaces, workspace_members, sessions, forms, form_versions CASCADE`)
	if err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// testTokenSecret — ключ подписи токена формы на весь стек теста.
var testTokenSecret = []byte("dev-only-form-token-secret-not-a-real-key")

// Лимит не ослабляется ради теста, а инжектируется пермиссивной реализацией
// (инвариант безопасности 6).
type allowLimiter struct{}

func (allowLimiter) Allow(string) bool { return true }

// newStack собирает реальную вертикаль auth+forms поверх контейнерного пула.
// fixtureIndexPath кладёт минимальный собранный index.html рендерера (с обеими
// точками вставки — оформления в теге <html> и головы формы в <head>) во временный
// файл — так же, как его получит api из смонтированной статики в проде. Нужен, чтобы
// Go регистрировал и обслуживал /r в этом стеке.
func fixtureIndexPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "index.html")
	const html = `<!doctype html><html lang="ru" data-form-shell><head>` +
		`<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` +
		`<!--og-meta-->` +
		`<script type="module" crossorigin src="/assets/index-ByZMBI6C.js"></script>` +
		`<link rel="stylesheet" crossorigin href="/assets/index-mIztBLt-.css">` +
		`</head><body><div id="root"></div></body></html>`
	if err := os.WriteFile(path, []byte(html), 0o600); err != nil {
		t.Fatalf("запись фикстуры index.html: %v", err)
	}
	return path
}

// Лимитер auth — пермиссивный (инвариант 6).
func newStack(t *testing.T) *httptest.Server { return newStackWithAI(t, nil) }

// newStackWithAI — та же вертикаль с подключённой моделью. nil = модели на контуре
// нет, и ручка генерации отвечает 404 (фаза 26).
func newStackWithAI(t *testing.T, gen forms.Generator) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now)).
		WithSecret(testTokenSecret)
	if gen != nil {
		formsSvc.WithAI(gen)
	}
	formsH := forms.NewHandler(formsSvc, authH.RequireAuth, authH.RequireCSRF).
		WithNotifyMail("no-reply@trillix.test", "Trillix", "Новый ответ в Trillix").
		WithAILimiter(allowLimiter{})
	formsPublic, err := forms.NewPublicHandler(formsSvc, testTokenSecret,
		"http://localhost:5174", "http://localhost:5174/og-preview.png", fixtureIndexPath(t),
		allowLimiter{}, false)
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}

	mux := http.NewServeMux()
	authH.Routes(mux)
	formsH.Routes(mux)
	formsPublic.WithUnlockLimiter(allowLimiter{}, allowLimiter{}).Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// registerUser регистрирует пользователя и возвращает клиент с его сессией.
func registerUser(t *testing.T, srv *httptest.Server, email string) *http.Client {
	t.Helper()
	c := newClient(t)
	r := do(t, c, http.MethodPost, srv.URL+"/api/v1/auth/register",
		`{"email":"`+email+`","password":"supersecret1"}`, "")
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("register %s: статус %d, ожидалось 201", email, r.StatusCode)
	}
	closeBody(t, r)
	return c
}

func TestForms_CRUDFlow(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")

	// Создать форму без названия → дефолтный title, статус draft, slug выдан.
	created := createForm(t, c, srv, "")
	if created.Title != "Untitled form" {
		t.Fatalf("title = %q, ожидался дефолт", created.Title)
	}
	if created.Status != "draft" || created.Slug == "" {
		t.Fatalf("неожиданная форма: %+v", created)
	}

	// GET → отдаёт draft_schema, канонизированный до текущей версии (CanonicalDraftV4).
	// У новой формы блоков нет, но заголовок сервер СИНТЕЗИРУЕТ из колонки (фаза 15) —
	// редактор обязан увидеть его строкой полотна. Служебное имя новой формы в
	// документ не попадает: автор его не писал, и текст блока пуст.
	detail := getFormDetail(t, c, srv, created.ID, http.StatusOK)
	got := parseSchema(t, detail.DraftSchema)
	if got.SchemaVersion != domain.SchemaVersion || len(got.Blocks) != 1 {
		t.Fatalf("draftSchema = %s, ожидался каркас с одним блоком заголовка", detail.DraftSchema)
	}
	if b := got.Blocks[0]; b.Type != domain.BlockFormTitle || domain.PlainText(b.Text) != "" {
		t.Fatalf("синтезированный заголовок собран неверно: %+v", b)
	}

	// Заголовок формы правится ДОКУМЕНТОМ (фаза 15): блок form_title в схеме, а
	// колонка forms.title — его плоское зеркало. Проверяем весь путь целиком, до
	// настоящей БД: ручки PATCH {title} больше нет вовсе.
	titled := patchDraftSchema(t, c, srv, created.ID,
		`{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Опрос клиентов"}]}]}`,
		detail.UpdatedAt, http.StatusOK)
	if titled.Title != "Опрос клиентов" {
		t.Fatalf("зеркало заголовка в колонке = %q", titled.Title)
	}

	// Список содержит форму.
	if list := listForms(t, c, srv, ""); len(list.Forms) != 1 || list.Forms[0].ID != created.ID {
		t.Fatalf("список = %+v, ожидалась одна форма %s", list.Forms, created.ID)
	}

	// Удаление → потом 404.
	deleteForm(t, c, srv, created.ID, http.StatusNoContent)
	getFormDetail(t, c, srv, created.ID, http.StatusNotFound)
}

// Бланк письма в настройках показывает НАСТОЯЩЕЕ письмо: служебный адрес отправителя
// и его имя приезжают из конфига контура, тема — из шаблона письма, адресат — почта
// владельца пространства. Ничего из этого фронт вычислить не может, поэтому всё
// живёт в детали формы; копия темы на фронте разошлась бы с шаблоном молча.
//
// Проверяется и второй вход в ту же деталь — резолв по slug: страница настроек
// адресует форму именно им, и забытое поле там выглядело бы как «адреса пропали на
// одном экране из двух».
func TestForms_Detail_NotifyAddresses(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")
	created := createForm(t, c, srv, "Анкета")

	byID := getFormDetail(t, c, srv, created.ID, http.StatusOK).NotifyMail
	if byID.From != "no-reply@trillix.test" {
		t.Errorf("from = %q, ожидался служебный адрес контура", byID.From)
	}
	if byID.To != "owner@example.com" {
		t.Errorf("to = %q, ожидалась почта владельца пространства", byID.To)
	}
	if byID.FromName != "Trillix" || byID.Subject == "" {
		t.Errorf("умолчания письма не доехали: fromName=%q subject=%q", byID.FromName, byID.Subject)
	}

	if bySlug := getFormDetailBySlug(t, c, srv, created.Slug, http.StatusOK).NotifyMail; bySlug != byID {
		t.Errorf("резолв по slug отдал другое письмо: %+v", bySlug)
	}
}

// Генерация формы текстом (фаза 26): вертикаль «ручка → квота → модель → черновик»
// против настоящей базы. Модель — ai.Fake: сети в тестах не бывает, а проверяется
// здесь не она, а связка вокруг неё.
func TestForms_Generate(t *testing.T) {
	resetDB(t)
	const plan = `{"title":"Запись в барбершоп","items":[` +
		`{"type":"short_text","text":"Ваше имя","required":true,"options":[],"scaleMin":0,"scaleMax":0},` +
		`{"type":"single_choice","text":"Мастер","required":false,"options":["Иван","Пётр"],"scaleMin":0,"scaleMax":0}]}`
	srv := newStackWithAI(t, ai.NewFake(plan))
	alice := registerUser(t, srv, "alice@example.com")

	r := do(t, alice, http.MethodPost, srv.URL+"/api/v1/forms/generate",
		`{"prompt":"анкета записи в барбершоп"}`, csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("генерация: статус %d, ожидалось 201", r.StatusCode)
	}
	var created formDTO
	decode(t, r, &created)
	if created.Title != "Запись в барбершоп" {
		t.Errorf("заголовок формы = %q, ожидался из плана модели", created.Title)
	}

	// Черновик доехал до базы целым: деталь отдаёт схему, которую собрал сервер.
	detail := getFormDetail(t, alice, srv, created.ID, http.StatusOK)
	schema, err := domain.ValidateSchema(detail.DraftSchema)
	if err != nil {
		t.Fatalf("черновик из базы не проходит ValidateSchema: %v", err)
	}
	if len(schema.Blocks) != 1+2+2 {
		t.Fatalf("блоков в черновике = %d, ожидалось 5", len(schema.Blocks))
	}

	// Расход списан ровно один раз и в текущем периоде.
	var used int64
	err = testPool.QueryRow(context.Background(),
		`SELECT ai_generations FROM workspace_usage
		  WHERE period = date_trunc('month', now() AT TIME ZONE 'Europe/Moscow')::date`).Scan(&used)
	if err != nil {
		t.Fatalf("чтение расхода: %v", err)
	}
	if used != 1 {
		t.Errorf("расход генераций = %d, ожидался 1", used)
	}
}

// Исчерпанная квота отвечает 402 и НЕ доходит до модели: за отказ не платят.
func TestForms_Generate_QuotaExhausted(t *testing.T) {
	resetDB(t)
	fake := ai.NewFake(`{"title":"А","items":[{"type":"email","text":"Почта","required":true,"options":[],"scaleMin":0,"scaleMax":0}]}`)
	srv := newStackWithAI(t, fake)
	alice := registerUser(t, srv, "alice@example.com")

	// Лимиты живут в plans и TRUNCATE их не сбрасывает — возвращаем на место, иначе
	// обнулённая квота протечёт в соседние тесты пакета.
	restore := func() {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE plans SET limits = jsonb_set(limits, '{ai_generations}', '10'::jsonb)`); err != nil {
			t.Fatalf("возврат квоты: %v", err)
		}
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, '{ai_generations}', '0'::jsonb)`); err != nil {
		t.Fatalf("обнуление квоты: %v", err)
	}
	t.Cleanup(restore)

	r := do(t, alice, http.MethodPost, srv.URL+"/api/v1/forms/generate",
		`{"prompt":"анкета"}`, csrf(t, alice, srv.URL))
	defer closeBody(t, r)
	if r.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("статус %d, ожидалось 402", r.StatusCode)
	}
	if n := len(fake.Requests()); n != 0 {
		t.Errorf("вызовов модели = %d, ожидалось ноль: за отказ по квоте платить нечем", n)
	}
}

// Контур без провайдера: ручки нет вовсе — 404, как у непрописанного OAuth.
func TestForms_Generate_ProviderNotConfigured(t *testing.T) {
	resetDB(t)
	srv := newStackWithAI(t, ai.Disabled{})
	alice := registerUser(t, srv, "alice@example.com")

	r := do(t, alice, http.MethodPost, srv.URL+"/api/v1/forms/generate",
		`{"prompt":"анкета"}`, csrf(t, alice, srv.URL))
	defer closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404", r.StatusCode)
	}
}

// Чужое пространство в теле — 404 (анти-IDOR: id из запроса правом не является),
// и модель об этом не спрашивают.
func TestForms_Generate_ForeignWorkspace(t *testing.T) {
	resetDB(t)
	fake := ai.NewFake(`{"title":"А","items":[{"type":"email","text":"Почта","required":true,"options":[],"scaleMin":0,"scaleMax":0}]}`)
	srv := newStackWithAI(t, fake)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	// Пространство боба берём из базы: тест про доступ, а не про формат листинга.
	bobForm := createForm(t, bob, srv, "Форма боба")
	var bobWS string
	if err := testPool.QueryRow(context.Background(),
		`SELECT workspace_id::text FROM forms WHERE id = $1`, bobForm.ID).Scan(&bobWS); err != nil {
		t.Fatalf("чтение пространства боба: %v", err)
	}

	r := do(t, alice, http.MethodPost, srv.URL+"/api/v1/forms/generate",
		`{"prompt":"анкета","workspaceId":"`+bobWS+`"}`, csrf(t, alice, srv.URL))
	defer closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404", r.StatusCode)
	}
	if n := len(fake.Requests()); n != 0 {
		t.Errorf("вызовов модели = %d, ожидалось ноль", n)
	}
}

// Провайдер не ответил — 503 и ни формы, ни расхода.
func TestForms_Generate_ProviderDown(t *testing.T) {
	resetDB(t)
	srv := newStackWithAI(t, ai.NewFakeReplies(ai.FakeReply{Err: ai.ErrProvider}))
	alice := registerUser(t, srv, "alice@example.com")

	r := do(t, alice, http.MethodPost, srv.URL+"/api/v1/forms/generate",
		`{"prompt":"анкета"}`, csrf(t, alice, srv.URL))
	defer closeBody(t, r)
	if r.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("статус %d, ожидалось 503", r.StatusCode)
	}

	var forms64 int64
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM forms`).Scan(&forms64); err != nil {
		t.Fatalf("счёт форм: %v", err)
	}
	if forms64 != 0 {
		t.Errorf("форм в базе = %d, ожидалось ноль", forms64)
	}
	var usage int64
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM workspace_usage`).Scan(&usage); err != nil {
		t.Fatalf("счёт расхода: %v", err)
	}
	if usage != 0 {
		t.Errorf("строк расхода = %d, ожидалось ноль: несостоявшийся вызов не списывается", usage)
	}
}

// Разговор с ассистентом над формой (фаза 26, слайс E): вертикаль «ручка → право →
// квота → модель → правка» против настоящей базы. Модель — ai.Fake.
func TestForms_Chat(t *testing.T) {
	resetDB(t)
	const reply = `{"action":"edit_form","reply":"Добавил телефон.","title":{"text":"","bold":false,"color":"","bg":""},` +
		`"add":[{"after":"q1","item":{"type":"phone","text":"Телефон","required":true,"options":[],"scaleMin":0,"scaleMax":0}}],` +
		`"update":[],"remove":[],"move":[]}`
	srv := newStackWithAI(t, ai.NewFake(reply))
	alice := registerUser(t, srv, "alice@example.com")
	form := createForm(t, alice, srv, "Запись")

	// Документ приходит В ТЕЛЕ: правится то, что автор видит сейчас.
	schema := `{"schemaVersion":1,"blocks":[` +
		`{"id":"blk_c","groupId":"g_blk_n","type":"title","text":[{"t":"Ваше имя"}],"settings":{}},` +
		`{"id":"blk_n","groupId":"g_blk_n","type":"short_text","required":true,"settings":{}}]}`
	body := `{"message":"добавь телефон","history":[],"schema":` + schema + `}`

	r := do(t, alice, http.MethodPost, srv.URL+"/api/v1/forms/"+form.ID+"/ai/chat", body, csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusOK {
		t.Fatalf("чат: статус %d, ожидалось 200; тело=%s", r.StatusCode, body2(t, r))
	}
	var got struct {
		Reply  string          `json:"reply"`
		Schema json.RawMessage `json:"schema"`
	}
	decode(t, r, &got)
	if got.Reply != "Добавил телефон." {
		t.Errorf("ответ ассистента = %q", got.Reply)
	}
	parsed, err := domain.ValidateSchema(got.Schema)
	if err != nil {
		t.Fatalf("правленый документ не проходит ValidateSchema: %v", err)
	}
	if len(parsed.Blocks) != 4 {
		t.Fatalf("блоков после правки = %d, ожидалось 4", len(parsed.Blocks))
	}
	if parsed.Blocks[0].ID != "blk_c" || parsed.Blocks[1].ID != "blk_n" {
		t.Errorf("правка не сохранила id прежних блоков: %s, %s", parsed.Blocks[0].ID, parsed.Blocks[1].ID)
	}

	// Ручка чата в базу не пишет: черновик остаётся тем, что сохранил автосейв.
	// Пустым он при этом не бывает — заголовок формы синтезируется на чтении
	// (EnsureFormTitle), поэтому смотрим на отсутствие того, что добавил ассистент.
	detail := getFormDetail(t, alice, srv, form.ID, http.StatusOK)
	stored, err := domain.ValidateSchema(detail.DraftSchema)
	if err != nil {
		t.Fatalf("черновик из базы не разобрался: %v", err)
	}
	for _, b := range stored.Blocks {
		if b.Type == domain.BlockPhone {
			t.Fatalf("чат записал правку в базу — этого он делать не должен: %s", detail.DraftSchema)
		}
	}

	// Сообщение списано ровно одно.
	var used int64
	err = testPool.QueryRow(context.Background(),
		`SELECT ai_generations FROM workspace_usage
		  WHERE period = date_trunc('month', now() AT TIME ZONE 'Europe/Moscow')::date`).Scan(&used)
	if err != nil {
		t.Fatalf("чтение расхода: %v", err)
	}
	if used != 1 {
		t.Errorf("расход = %d, ожидалось 1", used)
	}
}

// Чужая форма — 404, и модель об этом не спрашивают (инвариант 1).
func TestForms_Chat_ForeignForm(t *testing.T) {
	resetDB(t)
	fake := ai.NewFake(`{"action":"answer","reply":"ок","title":{"text":"","bold":false,"color":"","bg":""},"add":[],"update":[],"remove":[],"move":[]}`)
	srv := newStackWithAI(t, fake)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")
	bobForm := createForm(t, bob, srv, "Форма боба")

	r := do(t, alice, http.MethodPost, srv.URL+"/api/v1/forms/"+bobForm.ID+"/ai/chat",
		`{"message":"что тут спрашивается?","history":[],"schema":null}`, csrf(t, alice, srv.URL))
	defer closeBody(t, r)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404", r.StatusCode)
	}
	if n := len(fake.Requests()); n != 0 {
		t.Errorf("вызовов модели = %d, ожидалось ноль", n)
	}
}

// Приватный резолв формы по slug (URL кабинета адресует форму slug'ом, как
// рендерер /r/{slug}): владелец получает тот же detail, что по id; чужой/
// несуществующий slug → 404 (не 403, существование не раскрываем).
func TestForms_GetBySlug(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	form := createForm(t, alice, srv, "Опрос")

	// Владелец по slug получает ту же форму, что по id.
	d := getFormDetailBySlug(t, alice, srv, form.Slug, http.StatusOK)
	if d.ID != form.ID || d.Slug != form.Slug || d.Title != "Опрос" {
		t.Fatalf("by-slug detail = %+v, ожидалась форма %s", d, form.ID)
	}

	// Чужой видит форму A по slug как отсутствующую (404).
	getFormDetailBySlug(t, bob, srv, form.Slug, http.StatusNotFound)
	// Несуществующий slug → 404.
	getFormDetailBySlug(t, alice, srv, "no-such-slug", http.StatusNotFound)
}

// Главный тест фазы: изоляция воркспейсов. Пользователь B не имеет доступа к
// форме A — ни чтения, ни правки, ни удаления; всё → 404 (не 403).
func TestForms_WorkspaceIsolation(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	form := createForm(t, alice, srv, "Секрет Алисы")

	// B читает форму A → 404.
	getFormDetail(t, bob, srv, form.ID, http.StatusNotFound)
	// B переименовывает форму A → 404 (и не меняет её). Публичный заголовок с фазы 15
	// правится только документом, поэтому анти-IDOR по нему сторожит patchDraftSchema
	// строкой ниже, а здесь остаётся внутреннее имя.
	patchName(t, bob, srv, form.ID, "взломано", http.StatusNotFound)
	// B сохраняет схему в форму A → 404 (проверка членства бьёт раньше блокировки:
	// не 409, чтобы не раскрывать существование чужой формы).
	patchDraftSchema(t, bob, srv, form.ID, `{"blocks":[]}`, "2020-01-01T00:00:00Z", http.StatusNotFound)
	// B удаляет форму A → 404.
	deleteForm(t, bob, srv, form.ID, http.StatusNotFound)

	// Список B пуст — чужая форма туда не попадает.
	if list := listForms(t, bob, srv, ""); len(list.Forms) != 0 {
		t.Fatalf("список B = %+v, ожидался пустой", list.Forms)
	}
	// А форма A цела и с исходным названием.
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.Title != "Секрет Алисы" {
		t.Fatalf("форму A изменили: title = %q", d.Title)
	}
}

// Дубликация формы: копия в том же воркспейсе с «(копия)» в названии, скопированным
// черновиком и новыми id/slug; всегда черновик. Чужую форму дублировать нельзя (404).
func TestForms_Duplicate(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	form := createForm(t, alice, srv, "Анкета")
	schema := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`
	patchDraftSchema(t, alice, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)

	dup := duplicateForm(t, alice, srv, form.ID, http.StatusCreated)
	// Публичный заголовок копируется ДОСЛОВНО (чистый), суффикс «(копия)» — во
	// внутреннем имени (дашборд). ADR §10: разъезд name/title.
	if dup.Title != "Анкета" {
		t.Fatalf("title копии = %q, ожидался чистый \"Анкета\"", dup.Title)
	}
	if dup.Name == nil || *dup.Name != "Анкета (копия)" {
		t.Fatalf("name копии = %v, ожидалось \"Анкета (копия)\"", dup.Name)
	}
	if dup.Status != "draft" {
		t.Fatalf("status копии = %q, ожидался draft", dup.Status)
	}
	if dup.ID == form.ID || dup.Slug == form.Slug || dup.Slug == "" {
		t.Fatalf("копия должна иметь новые id/slug: %+v (оригинал %s/%s)", dup, form.ID, form.Slug)
	}

	// Черновик копии = черновик оригинала (канонизированный, апгрейд v1→v2:
	// вопрос разложен на подпись title + поле b1). Первым идёт заголовок формы: он
	// СИНТЕЗИРУЕТСЯ на чтении у каждой формы своей (id детерминирован от id формы),
	// поэтому в сравнении участвуют блоки после него — копируется содержимое, а не
	// эта служебная строка.
	got := parseSchema(t, getFormDetail(t, alice, srv, dup.ID, http.StatusOK).DraftSchema)
	if len(got.Blocks) != 3 || got.Blocks[0].Type != domain.BlockFormTitle {
		t.Fatalf("ожидались заголовок + два блока вопроса: %+v", got)
	}
	if domain.PlainText(got.Blocks[0].Text) != "Анкета" {
		t.Fatalf("копия потеряла заголовок оригинала: %+v", got.Blocks[0])
	}
	if got.Blocks[1].Type != "title" || domain.PlainText(got.Blocks[1].Text) != "Имя" || got.Blocks[2].ID != "b1" {
		t.Fatalf("схема копии не совпадает с оригиналом: %+v", got)
	}

	// Вторая копия — нумерация без коллизий: «(копия 2)».
	dup2 := duplicateForm(t, alice, srv, form.ID, http.StatusCreated)
	if dup2.Name == nil || *dup2.Name != "Анкета (копия 2)" {
		t.Fatalf("name второй копии = %v, ожидалось \"Анкета (копия 2)\"", dup2.Name)
	}

	// Три формы (оригинал + две копии) в списке владельца.
	if list := listForms(t, alice, srv, ""); len(list.Forms) != 3 {
		t.Fatalf("у владельца ожидалось 3 формы, получено %d", len(list.Forms))
	}

	// Изоляция: bob не дублирует форму alice → 404, его список пуст.
	duplicateForm(t, bob, srv, form.ID, http.StatusNotFound)
	if list := listForms(t, bob, srv, ""); len(list.Forms) != 0 {
		t.Fatalf("список bob не пуст: %+v", list.Forms)
	}
}

// Внутреннее имя (PATCH {name}): задаётся и сбрасывается, публичный заголовок (title)
// при этом не меняется. Чужую форму переименовать нельзя (404).
func TestForms_UpdateName(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	form := createForm(t, alice, srv, "Публичный заголовок")

	named := patchName(t, alice, srv, form.ID, "Рабочее имя", http.StatusOK)
	if named.Name == nil || *named.Name != "Рабочее имя" {
		t.Fatalf("name = %v, ожидалось \"Рабочее имя\"", named.Name)
	}
	if named.Title != "Публичный заголовок" {
		t.Fatalf("title изменился при переименовании: %q", named.Title)
	}

	// Пустое имя → сброс в null (кабинет снова показывает заголовок).
	reset := patchName(t, alice, srv, form.ID, "", http.StatusOK)
	if reset.Name != nil {
		t.Fatalf("name = %v, ожидался null после сброса", reset.Name)
	}

	// Чужую форму переименовать нельзя.
	patchName(t, bob, srv, form.ID, "взлом", http.StatusNotFound)
}

// Бейдж «Сделано в Trillix» — ЖИВОЕ свойство формы (ADR §10, миграция 0038): тумблер
// доезжает до респондента БЕЗ перепубликации, и это единственное, ради чего намерение
// уехало из схемы в колонку. Проверяется снаружи, тем же путём, каким пойдёт
// респондент: публичная выдача до и после переключения при одной публикации.
func TestForms_Branding_AppliesWithoutRepublish(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-branding@example.com")
	bob := registerUser(t, srv, "bob-branding@example.com")
	anon := newClient(t)

	form := createForm(t, alice, srv, "Анкета")
	publishForm(t, alice, srv, form.ID, http.StatusOK)
	// План с правом снимать бейдж: у free его нет (0019), и без этой строки тест
	// доказывал бы гейт, а не переезд намерения в колонку.
	setBrandingGate(t, form.Slug, true)

	// Новая форма — бейдж стоит.
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); !d.Branding {
		t.Fatal("у новой формы тумблер бейджа обязан быть включён")
	}
	pub, etag := getPublicOK(t, anon, srv, form.Slug)
	if !pub.ShowBadge {
		t.Fatal("публичная форма отдана без бейджа до всякой настройки")
	}

	// Снимаем бейдж и НЕ публикуем заново.
	patchBranding(t, alice, srv, form.ID, false, http.StatusOK)
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.Branding {
		t.Fatal("тумблер не сохранился")
	}

	after, etagAfter := getPublicOK(t, anon, srv, form.Slug)
	if after.ShowBadge {
		t.Fatal("бейдж остался на публичной форме после переключения — намерение снова ждёт публикации")
	}
	if after.Version != pub.Version {
		t.Fatalf("версия формы изменилась (%d → %d) — тумблер не имеет права публиковать", pub.Version, after.Version)
	}
	// ETag обязан разойтись: состояние бейджа — часть представления, и без этого
	// уже открывавший форму респондент получал бы 304 с прежним телом.
	if etag == etagAfter {
		t.Fatalf("ETag не изменился вместе с бейджем: %s", etag)
	}

	// Даунгрейд возвращает бейдж на уже опубликованную форму сам: право
	// спрашивается при заходе, а не при публикации. Намерение при этом не
	// стирается — апгрейд обязан оживить его без единой правки.
	setBrandingGate(t, form.Slug, false)
	downgraded, _ := getPublicOK(t, anon, srv, form.Slug)
	if !downgraded.ShowBadge {
		t.Fatal("после даунгрейда бейдж обязан вернуться без перепубликации")
	}
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.Branding {
		t.Fatal("даунгрейд стёр намерение автора — апгрейд его не оживит")
	}
	setBrandingGate(t, form.Slug, true)

	// Включить обратно — так же, одним PATCH.
	patchBranding(t, alice, srv, form.ID, true, http.StatusOK)
	back, _ := getPublicOK(t, anon, srv, form.Slug)
	if !back.ShowBadge {
		t.Fatal("бейдж не вернулся после обратного переключения")
	}

	// Два фасета за один PATCH → 422; чужая форма → 404 (существование не
	// раскрывается), как у остальных живых настроек.
	r := do(t, alice, http.MethodPatch, srv.URL+"/api/v1/forms/"+form.ID,
		`{"branding":false,"collectPartial":true}`, csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("два фасета: статус %d, ожидалось 422; тело=%s", r.StatusCode, body2(t, r))
	}
	closeBody(t, r)
	patchBranding(t, bob, srv, form.ID, false, http.StatusNotFound)
}

// Раздел «Поведение» (0044): фасет доезжает набором, доходит до публичной выдачи без
// перепубликации и меняет ETag. Тарифа у него нет — план в тесте не трогается.
func TestForms_Behavior_AppliesWithoutRepublish(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-behavior@example.com")
	bob := registerUser(t, srv, "bob-behavior@example.com")
	anon := newClient(t)

	form := createForm(t, alice, srv, "Анкета")
	publishForm(t, alice, srv, form.ID, http.StatusOK)

	// У новой формы обе настройки выключены: ни прыжки по страницам, ни хранение
	// ответов дольше сессии не включаются за автора.
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.AutoJump || d.SaveLocally {
		t.Fatal("у новой формы «Поведение» обязано быть выключено")
	}
	before, etag := getPublicOK(t, anon, srv, form.Slug)
	if before.AutoJump || before.SaveLocally {
		t.Fatal("публичная форма отдана с включённым поведением до всякой настройки")
	}

	patchBehavior(t, alice, srv, form.ID, `{"autoJump":true,"saveLocally":true}`, http.StatusOK)
	d := getFormDetail(t, alice, srv, form.ID, http.StatusOK)
	if !d.AutoJump || !d.SaveLocally {
		t.Fatal("настройки не сохранились")
	}

	after, etagAfter := getPublicOK(t, anon, srv, form.Slug)
	if !after.AutoJump || !after.SaveLocally {
		t.Fatal("поведение не доехало до публичной формы без перепубликации")
	}
	if after.Version != before.Version {
		t.Fatalf("версия изменилась (%d → %d) — настройка не имеет права публиковать", before.Version, after.Version)
	}
	if etag == etagAfter {
		t.Fatalf("ETag не изменился вместе с поведением: %s", etag)
	}

	// Набор заменяется целиком: половина раздела снимается тем же фасетом.
	patchBehavior(t, alice, srv, form.ID, `{"autoJump":false,"saveLocally":true}`, http.StatusOK)
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.AutoJump || !d.SaveLocally {
		t.Fatalf("набор не заменился целиком: autoJump=%v saveLocally=%v", d.AutoJump, d.SaveLocally)
	}

	// Два фасета за запрос → 422; чужая форма → 404.
	r := do(t, alice, http.MethodPatch, srv.URL+"/api/v1/forms/"+form.ID,
		`{"behavior":{"autoJump":true,"saveLocally":true},"progress":true}`, csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("два фасета: статус %d, ожидалось 422; тело=%s", r.StatusCode, body2(t, r))
	}
	closeBody(t, r)
	patchBehavior(t, bob, srv, form.ID, `{"autoJump":true,"saveLocally":true}`, http.StatusNotFound)
}

func patchBehavior(t *testing.T, c *http.Client, srv *httptest.Server, id, behavior string, wantStatus int) {
	t.Helper()
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id,
		`{"behavior":`+behavior+`}`, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH behavior: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	closeBody(t, r)
}

// Шкала прогресса — живая колонка (миграция 0040) и та же проверка, что у бейджа:
// тумблер обязан доезжать до респондента без перепубликации. Отличие одно, и оно
// здесь главное: ТАРИФА У ШКАЛЫ НЕТ — план в тесте не трогается вовсе, и снять её
// вправе бесплатный автор.
func TestForms_Progress_AppliesWithoutRepublish(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-progress@example.com")
	bob := registerUser(t, srv, "bob-progress@example.com")
	anon := newClient(t)

	form := createForm(t, alice, srv, "Анкета")
	publishForm(t, alice, srv, form.ID, http.StatusOK)

	// У новой формы шкалы НЕТ — дефолт колонки выключен (решение владельца
	// 2026-08-29): шкала это решение автора, а не свойство формы по умолчанию.
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.Progress {
		t.Fatal("у новой формы шкала обязана быть выключена")
	}
	pub, etag := getPublicOK(t, anon, srv, form.Slug)
	if pub.Progress {
		t.Fatal("публичная форма отдана со шкалой до всякой настройки")
	}

	// Включаем шкалу и НЕ публикуем заново.
	patchProgress(t, alice, srv, form.ID, true, http.StatusOK)
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); !d.Progress {
		t.Fatal("тумблер не сохранился")
	}

	after, etagAfter := getPublicOK(t, anon, srv, form.Slug)
	if !after.Progress {
		t.Fatal("шкала не доехала до публичной формы — намерение снова ждёт публикации")
	}
	if after.Version != pub.Version {
		t.Fatalf("версия формы изменилась (%d → %d) — тумблер не имеет права публиковать", pub.Version, after.Version)
	}
	if etag == etagAfter {
		t.Fatalf("ETag не изменился вместе со шкалой: %s", etag)
	}

	// Два фасета за один PATCH → 422; чужая форма → 404, как у остальных живых
	// настроек.
	r := do(t, alice, http.MethodPatch, srv.URL+"/api/v1/forms/"+form.ID,
		`{"progress":true,"branding":false}`, csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("два фасета: статус %d, ожидалось 422; тело=%s", r.StatusCode, body2(t, r))
	}
	closeBody(t, r)
	patchProgress(t, bob, srv, form.ID, true, http.StatusNotFound)
}

// Живые настройки закрытия (PATCH {closeSettings}): фасет доходит до сервиса,
// GET-деталь их возвращает, набор заменяется целиком (пустое = снято), невалидный
// лимит → 422, два фасета за раз → 422, чужая форма → 404.
// Экран «приём закрыт»: свой заголовок автора (0043) доезжает до публичного тела
// 410 уже разрешённым, а без него заголовком остаётся название формы. Разрешает
// сервер — у рендерера нет второго источника заголовка.
func TestForms_ClosedTitle_ResolvedByServer(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-closedtitle@example.com")
	anon := newClient(t)

	form := createForm(t, alice, srv, "Анкета кандидата")
	publishForm(t, alice, srv, form.ID, http.StatusOK)
	unpublishForm(t, alice, srv, form.ID, http.StatusOK)

	// Своего заголовка нет — берётся название формы (поведение до 0043).
	if got := closedTitleOf(t, anon, srv, form.Slug); got != "Анкета кандидата" {
		t.Fatalf("заголовок = %q, ожидалось название формы", got)
	}

	patchCloseSettings(t, alice, srv, form.ID,
		`{"closeAt":null,"responseLimit":null,"closedMessage":"","closedTitle":"Набор окончен"}`,
		http.StatusOK)
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.ClosedTitle == nil || *d.ClosedTitle != "Набор окончен" {
		t.Fatalf("closedTitle в детали = %v", d.ClosedTitle)
	}
	if got := closedTitleOf(t, anon, srv, form.Slug); got != "Набор окончен" {
		t.Fatalf("заголовок = %q, ожидался заголовок автора", got)
	}
}

// closedTitleOf читает заголовок с публичного экрана «приём закрыт» (410 Gone).
func closedTitleOf(t *testing.T, c *http.Client, srv *httptest.Server, slug string) string {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/public/v1/forms/"+slug, "", "")
	defer closeBody(t, r)
	if r.StatusCode != http.StatusGone {
		t.Fatalf("статус %d, ожидалось 410", r.StatusCode)
	}
	var body struct {
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatalf("тело 410 не парсится: %v", err)
	}
	return body.Title
}

// Открытие закрытой формы НЕ публикует новой версии: респонденты возвращаются к той
// же, которую видели до закрытия. Черновик этой ручкой не открывается — публикация
// остаётся отдельным действием автора.
func TestForms_Reopen_KeepsVersion(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-reopen@example.com")
	bob := registerUser(t, srv, "bob-reopen@example.com")
	anon := newClient(t)

	form := createForm(t, alice, srv, "Анкета")
	publishForm(t, alice, srv, form.ID, http.StatusOK)
	before, _ := getPublicOK(t, anon, srv, form.Slug)

	unpublishForm(t, alice, srv, form.ID, http.StatusOK)
	reopenForm(t, alice, srv, form.ID, http.StatusOK)

	d := getFormDetail(t, alice, srv, form.ID, http.StatusOK)
	if d.Status != "published" {
		t.Fatalf("статус = %q, ожидался published", d.Status)
	}
	after, _ := getPublicOK(t, anon, srv, form.Slug)
	if after.Version != before.Version {
		t.Fatalf("версия изменилась (%d → %d) — открытие не имеет права публиковать", before.Version, after.Version)
	}

	// Уже открытую открыть нечем; чужую — 404 (существование не раскрывается).
	reopenForm(t, alice, srv, form.ID, http.StatusUnprocessableEntity)
	unpublishForm(t, alice, srv, form.ID, http.StatusOK)
	reopenForm(t, bob, srv, form.ID, http.StatusNotFound)

	// Черновик открыть нельзя: публиковать его — отдельное действие.
	draft := createForm(t, alice, srv, "Черновик")
	reopenForm(t, alice, srv, draft.ID, http.StatusUnprocessableEntity)
}

func reopenForm(t *testing.T, c *http.Client, srv *httptest.Server, id string, wantStatus int) {
	t.Helper()
	r := do(t, c, http.MethodPost, srv.URL+"/api/v1/forms/"+id+"/reopen", "", csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("POST reopen: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	closeBody(t, r)
}

func TestForms_CloseSettings(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-close@example.com")
	bob := registerUser(t, srv, "bob-close@example.com")

	form := createForm(t, alice, srv, "Мероприятие")

	// Задаём лимит и текст (даты нет).
	patchCloseSettings(t, alice, srv, form.ID,
		`{"closeAt":null,"responseLimit":100,"closedMessage":"Мест больше нет"}`, http.StatusOK)

	d := getFormDetail(t, alice, srv, form.ID, http.StatusOK)
	if d.ResponseLimit == nil || *d.ResponseLimit != 100 {
		t.Fatalf("responseLimit в детали = %v, ожидалось 100", d.ResponseLimit)
	}
	if d.ClosedMessage == nil || *d.ClosedMessage != "Мест больше нет" {
		t.Fatalf("closedMessage в детали = %v", d.ClosedMessage)
	}
	if d.CloseAt != nil {
		t.Fatalf("closeAt = %v, ожидался null", d.CloseAt)
	}

	// Невалидный лимит (0) → 422, до записи не доходит.
	patchCloseSettings(t, alice, srv, form.ID,
		`{"closeAt":null,"responseLimit":0,"closedMessage":""}`, http.StatusUnprocessableEntity)

	// Набор заменяется целиком: пустой сбрасывает все три настройки.
	patchCloseSettings(t, alice, srv, form.ID,
		`{"closeAt":null,"responseLimit":null,"closedMessage":""}`, http.StatusOK)
	cleared := getFormDetail(t, alice, srv, form.ID, http.StatusOK)
	if cleared.ResponseLimit != nil || cleared.CloseAt != nil || cleared.ClosedMessage != nil {
		t.Fatalf("после сброса ожидались все null: limit=%v closeAt=%v msg=%v",
			cleared.ResponseLimit, cleared.CloseAt, cleared.ClosedMessage)
	}

	// Два фасета за один PATCH → 422 (меняется ровно одно). Оба фасета — ЖИВЫЕ: с
	// удалённым title тело отвергал бы декодер как неизвестное поле, и правило «ровно
	// одно» осталось бы непроверенным, а тест — зелёным по чужой причине.
	r := do(t, alice, http.MethodPatch, srv.URL+"/api/v1/forms/"+form.ID,
		`{"name":"Новый","closeSettings":{"closeAt":null,"responseLimit":5,"closedMessage":""}}`, csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("два фасета: статус %d, ожидалось 422; тело=%s", r.StatusCode, body2(t, r))
	}
	closeBody(t, r)

	// Чужую форму не настроить (404, существование не раскрывается).
	patchCloseSettings(t, bob, srv, form.ID,
		`{"closeAt":null,"responseLimit":5,"closedMessage":""}`, http.StatusNotFound)
}

// Своя карточка ссылки (PATCH {linkPreview}): фасет доходит до сервиса, GET-деталь
// её возвращает, набор заменяется целиком (пустая карточка = настройка снята),
// слишком длинное поле → 422, чужая форма → 404.
//
// Тариф здесь НЕ участвует и участвовать не должен: сохранять карточку вправе любой
// план, а право её применить спрашивается при отдаче публичной страницы. Отдельный
// сторож этому — TestUpdateLinkPreview_SavesOnAnyPlan в юнитах сервиса.
func TestForms_LinkPreview(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-preview@example.com")
	bob := registerUser(t, srv, "bob-preview@example.com")

	form := createForm(t, alice, srv, "Опрос читателей")

	// Форма без карточки — в детали null, а не объект из пустых строк.
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.LinkPreview != nil {
		t.Fatalf("у новой формы linkPreview = %+v, ожидался null", d.LinkPreview)
	}

	patchLinkPreview(t, alice, srv, form.ID,
		`{"siteName":"Журнал «Кот»","title":"Февральский номер","description":"Три минуты.","imageKey":"ws/a.png","iconKey":"ws/i.png"}`,
		http.StatusOK)

	d := getFormDetail(t, alice, srv, form.ID, http.StatusOK)
	if d.LinkPreview == nil {
		t.Fatal("карточка не вернулась в детали формы")
	}
	if d.LinkPreview.SiteName != "Журнал «Кот»" || d.LinkPreview.Title != "Февральский номер" {
		t.Fatalf("в детали не та карточка: %+v", d.LinkPreview)
	}
	if d.LinkPreview.ImageKey != "ws/a.png" || d.LinkPreview.IconKey != "ws/i.png" {
		t.Fatalf("ключи картинок не сохранились: %+v", d.LinkPreview)
	}

	// Слишком длинный заголовок → 422 (лимит в рунах, кириллица считается верно).
	patchLinkPreview(t, alice, srv, form.ID,
		`{"siteName":"","title":"`+strings.Repeat("я", domain.MaxLinkPreviewTitleLen+1)+`","description":"","imageKey":"","iconKey":""}`,
		http.StatusUnprocessableEntity)

	// Карточка из пустых строк = снять настройку: в колонке NULL, в детали null.
	patchLinkPreview(t, alice, srv, form.ID,
		`{"siteName":"","title":"","description":"","imageKey":"","iconKey":""}`, http.StatusOK)
	if cleared := getFormDetail(t, alice, srv, form.ID, http.StatusOK); cleared.LinkPreview != nil {
		t.Fatalf("после сброса linkPreview = %+v, ожидался null", cleared.LinkPreview)
	}

	// Чужую форму не настроить (404, существование не раскрывается).
	patchLinkPreview(t, bob, srv, form.ID,
		`{"siteName":"Чужой","title":"","description":"","imageKey":"","iconKey":""}`, http.StatusNotFound)
}

// Письмо о новом ответе: тема и текст — СПАНЫ, и подстановка (`ref`) переживает
// круговой перевод «PATCH → колонка JSONB → деталь формы». Формат сменился в 0045, и
// проверять надо именно круг: потерянный `ref` не падает — он молча превращает чип в
// обычный текст, и автор узнаёт об этом из пришедшего письма.
func TestForms_NotifyEmail_MentionSurvivesRoundTrip(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-mail@example.com")

	form := createForm(t, alice, srv, "Заявка")
	setNotifyEmailGate(t, form.Slug, true)

	patchNotifyEmail(t, alice, srv, form.ID,
		`{"fromName":"","replyTo":"","attachPdf":false,`+
			`"subject":[{"t":"Ответ от "},{"t":"Имя","ref":"b1"}],`+
			`"body":[{"t":"Все ответы","ref":"_all"}]}`,
		http.StatusOK)

	d := getFormDetail(t, alice, srv, form.ID, http.StatusOK)
	if d.NotifyEmail == nil {
		t.Fatal("настройка письма не вернулась в детали формы")
	}
	wantSubject := []domain.Span{{T: "Ответ от "}, {T: "Имя", Ref: "b1"}}
	if !reflect.DeepEqual(d.NotifyEmail.Subject, wantSubject) {
		t.Fatalf("тема вернулась как %+v, ожидалось %+v", d.NotifyEmail.Subject, wantSubject)
	}
	wantBody := []domain.Span{{T: "Все ответы", Ref: domain.MentionAllAnswers}}
	if !reflect.DeepEqual(d.NotifyEmail.Body, wantBody) {
		t.Fatalf("текст вернулся как %+v, ожидалось %+v", d.NotifyEmail.Body, wantBody)
	}

	// Ссылка наружу и подстановка на одном куске — 422 с обеих сторон (ADR §10).
	patchNotifyEmail(t, alice, srv, form.ID,
		`{"fromName":"","replyTo":"","attachPdf":false,"subject":[],`+
			`"body":[{"t":"Имя","ref":"b1","href":"https://example.com"}]}`,
		http.StatusUnprocessableEntity)

	// Тема длиннее СВОЕГО потолка (200), а не потолка текста блока (2000).
	patchNotifyEmail(t, alice, srv, form.ID,
		`{"fromName":"","replyTo":"","attachPdf":false,"body":[],`+
			`"subject":[{"t":"`+strings.Repeat("я", domain.MaxNotifySubjectLen+1)+`"}]}`,
		http.StatusUnprocessableEntity)

	// Пустые спаны = снять настройку: в колонке NULL, в детали null.
	patchNotifyEmail(t, alice, srv, form.ID,
		`{"fromName":"","replyTo":"","attachPdf":false,"subject":[],"body":[]}`, http.StatusOK)
	if cleared := getFormDetail(t, alice, srv, form.ID, http.StatusOK); cleared.NotifyEmail != nil {
		t.Fatalf("после сброса notifyEmail = %+v, ожидался null", cleared.NotifyEmail)
	}
}

// Автосейв билдера: валидная схема сохраняется (канонизированной, updated_at
// сдвигается), мусор → 422, устаревший updated_at → 409, схема без updated_at → 422.
func TestForms_DraftSchemaAutosave(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "builder@example.com")

	form := createForm(t, c, srv, "Анкета")

	// Валидное сохранение: schemaVersion опущен — сервер обязан канонизировать (=1).
	schema := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`
	saved := patchDraftSchema(t, c, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)
	if saved.UpdatedAt == form.UpdatedAt {
		t.Fatalf("updated_at не сдвинулся после сохранения: %s", saved.UpdatedAt)
	}

	// GET отдаёт канонизированный документ: schemaVersion проставлен (=2, апгрейд
	// v1→v2), вопрос разложен на подпись + поле. Порядок ключей задаёт JSONB (не
	// Go-маршалинг), поэтому сверяем разбором.
	got := parseSchema(t, getFormDetail(t, c, srv, form.ID, http.StatusOK).DraftSchema)
	// Три блока: синтезированный заголовок формы (фаза 15) + подпись и поле вопроса.
	if got.SchemaVersion != domain.SchemaVersion || len(got.Blocks) != 3 {
		t.Fatalf("канонизация не проставила schemaVersion/группу: %+v", got)
	}
	if got.Blocks[0].Type != domain.BlockFormTitle {
		t.Fatalf("заголовок формы не первый: %+v", got.Blocks[0])
	}
	if got.Blocks[1].Type != "title" || domain.PlainText(got.Blocks[1].Text) != "Имя" {
		t.Fatalf("подпись сохранена неверно: %+v", got.Blocks[1])
	}
	if b := got.Blocks[2]; b.ID != "b1" || b.Type != "short_text" || !b.Required {
		t.Fatalf("поле сохранено неверно: %+v", b)
	}

	// Мусор (неизвестный тип блока) с актуальным updated_at → 422.
	garbage := `{"blocks":[{"id":"b1","groupId":"g_b1","type":"slider"}]}`
	patchDraftSchema(t, c, srv, form.ID, garbage, saved.UpdatedAt, http.StatusUnprocessableEntity)

	// Устаревший updated_at (исходный, уже сдвинутый первым сохранением) → 409.
	patchDraftSchema(t, c, srv, form.ID, `{"blocks":[]}`, form.UpdatedAt, http.StatusConflict)

	// draftSchema без updatedAt → 422 (оптимистичная блокировка обязательна).
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+form.ID,
		`{"draftSchema":{"blocks":[]}}`, csrf(t, c, srv.URL))
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("схема без updatedAt: статус %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)
}

// Публикация: две публикации подряд дают версии 1 и 2 (published_version_id
// указывает на свежую), unpublish закрывает форму, сохраняя номер версии. Черновая
// форма по прямому GET остаётся черновиком до публикации.
func TestForms_PublishVersioning(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "publisher@example.com")

	form := createForm(t, c, srv, "Анкета")
	if form.PublishedVersion != nil || form.PublishedVersionID != nil {
		t.Fatalf("свежая форма не должна иметь опубликованной версии: %+v", form)
	}

	// Кладём непустой черновик, чтобы снапшот был осмысленным.
	schema := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`
	_ = patchDraftSchema(t, c, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)

	// Первая публикация → версия 1, статус published, id версии выдан.
	pub1 := publishForm(t, c, srv, form.ID, http.StatusOK)
	if pub1.Status != "published" {
		t.Fatalf("status = %q, ожидался published", pub1.Status)
	}
	if pub1.PublishedVersion == nil || *pub1.PublishedVersion != 1 {
		t.Fatalf("publishedVersion = %v, ожидалась 1", pub1.PublishedVersion)
	}
	if pub1.PublishedVersionID == nil {
		t.Fatal("publishedVersionId не выдан после публикации")
	}

	// Правим черновик и публикуем снова → версия 2, id версии меняется.
	// updated_at сдвинут публикацией (SetFormPublished двигает его) — берём из pub1.
	_ = patchDraftSchema(t, c, srv, form.ID, schema, pub1.UpdatedAt, http.StatusOK)
	pub2 := publishForm(t, c, srv, form.ID, http.StatusOK)
	if pub2.PublishedVersion == nil || *pub2.PublishedVersion != 2 {
		t.Fatalf("publishedVersion = %v, ожидалась 2", pub2.PublishedVersion)
	}
	if *pub2.PublishedVersionID == *pub1.PublishedVersionID {
		t.Fatal("id версии не сменился при повторной публикации")
	}

	// GET отдаёт актуальные статус и номер версии.
	got := getFormDetail(t, c, srv, form.ID, http.StatusOK)
	if got.Status != "published" || got.PublishedVersion == nil || *got.PublishedVersion != 2 {
		t.Fatalf("GET после публикаций: %+v", got.formDTO)
	}

	// Снятие с публикации → closed, номер последней версии сохраняется.
	closed := unpublishForm(t, c, srv, form.ID, http.StatusOK)
	if closed.Status != "closed" {
		t.Fatalf("status = %q, ожидался closed", closed.Status)
	}
	if closed.PublishedVersion == nil || *closed.PublishedVersion != 2 {
		t.Fatalf("после закрытия publishedVersion = %v, ожидалась 2", closed.PublishedVersion)
	}
}

// hasUnpublishedChanges: true только когда черновик разошёлся с опубликованной
// версией. До публикации сравнивать не с чем; переименование (title не
// версионируется) бейдж не поднимает; повторная публикация его снимает.
func TestForms_HasUnpublishedChanges(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "badge@example.com")

	form := createForm(t, c, srv, "Анкета")
	schemaA := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`
	_ = patchDraftSchema(t, c, srv, form.ID, schemaA, form.UpdatedAt, http.StatusOK)

	// Неопубликованная форма — бейджа нет (сравнивать не с чем).
	if getFormDetail(t, c, srv, form.ID, http.StatusOK).HasUnpublishedChanges {
		t.Fatal("у неопубликованной формы не должно быть неопубликованных изменений")
	}

	// Публикация → черновик == снапшот → бейджа нет.
	publishForm(t, c, srv, form.ID, http.StatusOK)
	if getFormDetail(t, c, srv, form.ID, http.StatusOK).HasUnpublishedChanges {
		t.Fatal("сразу после публикации изменений быть не должно")
	}

	// Внутреннее имя не версионируется → бейдж не поднимается. (Публичный заголовок с
	// фазы 15 живёт в документе и бейдж поднимает — как любая правка полотна.)
	patchName(t, c, srv, form.ID, "Анкета 2", http.StatusOK)
	if getFormDetail(t, c, srv, form.ID, http.StatusOK).HasUnpublishedChanges {
		t.Fatal("переименование в дашборде не должно давать неопубликованных изменений")
	}

	// Правка черновика → расходится с версией → бейдж. updated_at сдвинут
	// публикацией и переименованием — берём свежий из GET.
	cur := getFormDetail(t, c, srv, form.ID, http.StatusOK)
	schemaB := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя и фамилия"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`
	_ = patchDraftSchema(t, c, srv, form.ID, schemaB, cur.UpdatedAt, http.StatusOK)
	if !getFormDetail(t, c, srv, form.ID, http.StatusOK).HasUnpublishedChanges {
		t.Fatal("после правки черновика ожидались неопубликованные изменения")
	}

	// Повторная публикация снимает бейдж.
	publishForm(t, c, srv, form.ID, http.StatusOK)
	if getFormDetail(t, c, srv, form.ID, http.StatusOK).HasUnpublishedChanges {
		t.Fatal("после повторной публикации бейдж должен исчезнуть")
	}
}

// Публикация чужой формы недоступна: B публикует/закрывает форму A → 404, форма A
// остаётся черновиком.
func TestForms_PublishIsolation(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice2@example.com")
	bob := registerUser(t, srv, "bob2@example.com")

	form := createForm(t, alice, srv, "Секрет Алисы")

	publishForm(t, bob, srv, form.ID, http.StatusNotFound)
	unpublishForm(t, bob, srv, form.ID, http.StatusNotFound)

	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.Status != "draft" {
		t.Fatalf("форму A опубликовали в обход прав: статус %q", d.Status)
	}
}

// Публичная выдача по slug: опубликованная форма доступна без авторизации (схема,
// version, token, ETag); черновик и закрытая → 404; повтор с If-None-Match → 304.
func TestForms_PublicFetch(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner-public@example.com")
	anon := newClient(t) // без сессии — публичный доступ

	form := createForm(t, owner, srv, "Публичный опрос")

	// Черновик по slug недоступен (приватное не раскрывается) → 404.
	getPublic(t, anon, srv, form.Slug, http.StatusNotFound)

	// Публикуем непустую схему.
	schema := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`
	patchDraftSchema(t, owner, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)
	publishForm(t, owner, srv, form.ID, http.StatusOK)

	// Публичная выдача: 200, title/version/schema, ETag выставлен.
	pub, etag := getPublicOK(t, anon, srv, form.Slug)
	if pub.Title != "Публичный опрос" || pub.Version != 1 {
		t.Fatalf("публичная форма: %+v", pub)
	}
	if etag == "" {
		t.Fatal("нет ETag")
	}
	// Токена в кэшируемом теле нет: он приезжает некэшируемой ручкой, иначе его
	// возраст мерил бы возраст записи в кэше браузера (ADR §10).
	if pub.Token != "" {
		t.Fatalf("в теле схемы приехал token %q", pub.Token)
	}
	tok, cacheControl := getFormToken(t, anon, srv)
	if _, err := token.IssuedAt(testTokenSecret, tok); err != nil {
		t.Fatalf("токен ручки невалиден: %v", err)
	}
	if cacheControl != "no-store" {
		t.Fatalf("Cache-Control ручки токена = %q, ожидалось no-store", cacheControl)
	}
	// Наружу уходит канон (v3): welded-вопрос v1 разложен на подпись title + поле b1.
	got := parseSchema(t, pub.Schema)
	if len(got.Blocks) != 2 || got.Blocks[0].Type != "title" || domain.PlainText(got.Blocks[0].Text) != "Имя" || got.Blocks[1].ID != "b1" {
		t.Fatalf("схема опубликованной версии неверна: %+v", got)
	}

	// Повтор с If-None-Match = ETag → 304 без тела.
	r := doWithHeader(t, anon, http.MethodGet, srv.URL+"/public/v1/forms/"+form.Slug, "If-None-Match", etag)
	if r.StatusCode != http.StatusNotModified {
		t.Fatalf("условный запрос: статус %d, ожидалось 304", r.StatusCode)
	}
	closeBody(t, r)

	// После снятия с публикации → 410 «приём закрыт» (не 404): форма была публичной,
	// существование не скрываем (шаг 4, решение владельца — любую закрытую показываем).
	unpublishForm(t, owner, srv, form.ID, http.StatusOK)
	getPublic(t, anon, srv, form.Slug, http.StatusGone)
}

// Демо-критерий этапа 14.2: форма с РАЗМЕЧЕННЫМ текстом, собранная запросом к API,
// доезжает до публичной ручки без потерь — марки, цвет, фон и ссылка целы, а в мету
// публичной страницы её разметка не протекает вовсе.
//
// Проверяется весь путь целиком: PATCH черновика → ValidateSchema → JSONB → публикация
// → снапшот версии → GET /public/v1. На каждом шаге текст мог схлопнуться в строку или
// потерять поле спана, и юнит на валидаторе этого не увидел бы.
func TestForms_RichTextSurvivesRoundTrip(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner-rich@example.com")
	anon := newClient(t)

	form := createForm(t, owner, srv, "Опрос с оформлением")

	schema := `{"schemaVersion":1,"blocks":[
		{"id":"t1","groupId":"g1","type":"title","text":[
			{"t":"Ваше "},
			{"t":"имя","m":["b","i"],"color":"#c026d3","bg":"#ffff00"},
			{"t":" — см. политику","href":"https://trillix.ru/privacy"}
		],"settings":{}},
		{"id":"b1","groupId":"g1","type":"short_text","required":true,"settings":{}}
	]}`
	patchDraftSchema(t, owner, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)
	publishForm(t, owner, srv, form.ID, http.StatusOK)

	pub, _ := getPublicOK(t, anon, srv, form.Slug)
	got := parseSchema(t, pub.Schema)
	if got.SchemaVersion != domain.SchemaVersion {
		t.Fatalf("наружу ушла версия %d, ждали %d", got.SchemaVersion, domain.SchemaVersion)
	}
	if len(got.Blocks) != 2 {
		t.Fatalf("ждали подпись + поле, получили %+v", got.Blocks)
	}
	want := []domain.Span{
		{T: "Ваше "},
		{T: "имя", M: []domain.Mark{domain.MarkBold, domain.MarkItalic}, Color: "#c026d3", BG: "#ffff00"},
		{T: " — см. политику", Href: "https://trillix.ru/privacy"},
	}
	if !reflect.DeepEqual(got.Blocks[0].Text, want) {
		t.Fatalf("богатый текст доехал искажённым:\nждали %+v\nполучили %+v", want, got.Blocks[0].Text)
	}

	// В МЕТУ СТРАНИЦЫ ПОДПИСИ ВОПРОСОВ НЕ ПОПАДАЮТ ВОВСЕ (решение владельца
	// 2026-08-27): описание карточки — своё поле, тизера из подписей больше нет.
	// Поэтому проверка стала сильнее прежней: раньше требовался плоский текст
	// подписи без разметки, теперь не должно быть ни того ни другого. Заголовок же
	// в мете есть и остаётся плоским — колонка forms.title это зеркало plainText.
	r := do(t, anon, http.MethodGet, srv.URL+"/r/"+form.Slug, "", "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("страница формы: статус %d", r.StatusCode)
	}
	body := body2(t, r)
	if !strings.Contains(body, `<meta property="og:title" content="Опрос с оформлением">`) {
		t.Fatalf("в мете нет заголовка формы: %s", body)
	}
	for _, marker := range []string{`"m":`, "#c026d3", "trillix.ru/privacy", "<b>", "Ваше имя"} {
		if strings.Contains(body, marker) {
			t.Fatalf("содержимое полотна протекло в мету (%q): %s", marker, body)
		}
	}
}

// HTML-страница формы /r/{slug} (OG-мета от Go): опубликованная → 200 text/html с
// экранированным og:title; черновик → 404 (приватное не раскрывается по HTML-пути).
func TestForms_PublicHTMLPage(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "owner-html@example.com")
	anon := newClient(t)

	// Инъекция в title (без кавычек — они сломали бы JSON-тело; кавычечный кейс — в юнитах).
	form := createForm(t, owner, srv, "Опрос <script>alert(1)</script>")

	// Черновик по HTML-пути → 404.
	r := do(t, anon, http.MethodGet, srv.URL+"/r/"+form.Slug, "", "")
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("черновик /r: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)

	schema := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`
	patchDraftSchema(t, owner, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)
	publishForm(t, owner, srv, form.ID, http.StatusOK)

	r = do(t, anon, http.MethodGet, srv.URL+"/r/"+form.Slug, "", "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("опубликованная /r: статус %d, ожидалось 200", r.StatusCode)
	}
	if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, ожидался text/html", ct)
	}
	html := body2(t, r) // закрывает тело
	if strings.Contains(html, "<script>alert(1)") {
		t.Fatalf("сырой инъектированный тег в HTML:\n%s", html)
	}
	if !strings.Contains(html, `property="og:title"`) || !strings.Contains(html, "og:description") {
		t.Fatalf("нет OG-меты в HTML:\n%s", html)
	}
}

// Пагинация: 5 форм, страницы по 2 — курсор без дублей и потерь.
func TestForms_CursorPagination(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "many@example.com")

	const total = 5
	ids := make(map[string]bool, total)
	for i := 0; i < total; i++ {
		f := createForm(t, c, srv, "форма")
		ids[f.ID] = true
	}

	seen := make(map[string]bool, total)
	cursor := ""
	pages := 0
	for {
		page := listForms(t, c, srv, "?limit=2"+cursorParam(cursor))
		pages++
		for _, f := range page.Forms {
			if seen[f.ID] {
				t.Fatalf("дубль формы %s между страницами", f.ID)
			}
			seen[f.ID] = true
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
		if pages > total+2 {
			t.Fatal("пагинация не сходится (курсор не двигается)")
		}
	}
	if len(seen) != total {
		t.Fatalf("увидено %d форм из %d", len(seen), total)
	}
}

// Пагинация обязана сходиться в КАЖДОМ порядке, а не только в умолчании: ключ
// курсора у них измеряет разные величины (фаза 8.5 шаг 8).
func TestForms_CursorPagination_EverySortOrder(t *testing.T) {
	for _, sort := range []string{"updated", "created", "responses"} {
		t.Run(sort, func(t *testing.T) {
			resetDB(t)
			srv := newStack(t)
			c := registerUser(t, srv, "sorted@example.com")

			const total = 5
			for i := 0; i < total; i++ {
				createForm(t, c, srv, "форма")
			}

			seen := make(map[string]bool, total)
			cursor := ""
			pages := 0
			for {
				page := listForms(t, c, srv, "?limit=2&sort="+sort+cursorParam(cursor))
				pages++
				for _, f := range page.Forms {
					if seen[f.ID] {
						t.Fatalf("дубль формы %s между страницами (sort=%s)", f.ID, sort)
					}
					seen[f.ID] = true
				}
				if page.NextCursor == nil {
					break
				}
				cursor = *page.NextCursor
				if pages > total+2 {
					t.Fatalf("пагинация не сходится (sort=%s)", sort)
				}
			}
			if len(seen) != total {
				t.Fatalf("увидено %d форм из %d (sort=%s)", len(seen), total, sort)
			}
		})
	}
}

// Сортировки различаются по существу: правка старой формы поднимает её наверх у
// updated, но не двигает у created.
func TestForms_SortUpdatedVsCreated(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "order@example.com")

	first := createForm(t, c, srv, "первая")
	second := createForm(t, c, srv, "вторая")
	third := createForm(t, c, srv, "третья")

	// Трогаем самую старую — по правке она обязана стать первой.
	patchName(t, c, srv, first.ID, "первая (правленая)", http.StatusOK)

	byUpdated := listForms(t, c, srv, "?sort=updated")
	if got := byUpdated.Forms[0].ID; got != first.ID {
		t.Fatalf("sort=updated: сверху %s, ожидалась только что правленая %s", got, first.ID)
	}

	byCreated := listForms(t, c, srv, "?sort=created")
	if got := byCreated.Forms[0].ID; got != third.ID {
		t.Fatalf("sort=created: сверху %s, ожидалась созданная последней %s", got, third.ID)
	}
	if got := byCreated.Forms[1].ID; got != second.ID {
		t.Fatalf("sort=created: вторая %s, ожидалась %s", got, second.ID)
	}
	if got := byCreated.Forms[2].ID; got != first.ID {
		t.Fatalf("sort=created: снизу %s, ожидалась созданная первой %s", got, first.ID)
	}
}

func TestForms_SortByResponses(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "responses@example.com")

	quiet := createForm(t, c, srv, "тихая")
	popular := createForm(t, c, srv, "популярная")
	publishForm(t, c, srv, quiet.ID, http.StatusOK)
	publishForm(t, c, srv, popular.ID, http.StatusOK)
	insertSubmissions(t, popular.ID, 3)
	insertSubmissions(t, quiet.ID, 1)

	page := listForms(t, c, srv, "?sort=responses")
	if got := page.Forms[0].ID; got != popular.ID {
		t.Fatalf("sort=responses: сверху %s, ожидалась форма с тремя ответами %s", got, popular.ID)
	}
}

// Курсор, выданный одним порядком, к другому не применяется: молча перемешанная
// выдача с пропусками хуже явной ошибки.
func TestForms_CursorFromOtherSort_Is422(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "mixcursor@example.com")
	for i := 0; i < 3; i++ {
		createForm(t, c, srv, "форма")
	}

	page := listForms(t, c, srv, "?limit=1&sort=created")
	if page.NextCursor == nil {
		t.Fatal("курсор не выдан")
	}

	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms?limit=1&sort=updated"+cursorParam(*page.NextCursor), "", "")
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422; тело=%s", r.StatusCode, body2(t, r))
	}
	closeBody(t, r)
}

func TestForms_UnknownSort_Is422(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "badsort@example.com")

	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms?sort=updatd", "", "")
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("статус %d, ожидалось 422; тело=%s", r.StatusCode, body2(t, r))
	}
	closeBody(t, r)
}

func TestForms_Search(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "search@example.com")

	byTitle := createForm(t, c, srv, "Заявка на доставку")
	createForm(t, c, srv, "Обратная связь")
	// Форма с внутренним именем: кабинет показывает name вместо title, поиск
	// обязан идти по тому же, что видно на карточке.
	renamed := createForm(t, c, srv, "Untitled form")
	patchName(t, c, srv, renamed.ID, "Анкета кандидата", http.StatusOK)
	// Спецсимвол LIKE в названии — проверка экранирования ниже.
	percent := createForm(t, c, srv, "Скидка 50% на курс")

	tests := []struct {
		name  string
		query string
		want  []string
	}{
		{"по заголовку", "доставку", []string{byTitle.ID}},
		{"регистр не важен", "ДОСТАВКУ", []string{byTitle.ID}},
		{"по внутреннему имени", "кандидата", []string{renamed.ID}},
		{"по старому заголовку переименованной — не находится", "Untitled", nil},
		{"процент ищется как символ, а не как шаблон", "50%", []string{percent.ID}},
		// Голый «%» — не «найти всё», а поиск литерального процента: находится
		// единственная форма, где этот символ есть в названии.
		{"голый шаблон ищется как символ", "%", []string{percent.ID}},
		{"ничего не найдено", "зззз", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			page := listForms(t, c, srv, "?q="+url.QueryEscape(tt.query))
			got := make([]string, len(page.Forms))
			for i, f := range page.Forms {
				got[i] = f.ID
			}
			if len(got) != len(tt.want) {
				t.Fatalf("найдено %d форм (%v), ожидалось %d (%v)", len(got), got, len(tt.want), tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("найдено %v, ожидалось %v", got, tt.want)
				}
			}
		})
	}
}

// Счётчики карточки (ответы, просмотры, конверсия) приезжают из того же запроса
// списка. Тест заведён задним числом: шаг 8 переписал их вычисление со скалярных
// подзапросов на LATERAL, и выяснилось, что числа не проверялись ничем — ошибка
// в них прошла бы молча и осела бы на дашборде владельца.
func TestForms_ListCounters(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "counters@example.com")

	form := createForm(t, c, srv, "Считаем")
	publishForm(t, c, srv, form.ID, http.StatusOK)
	insertSubmissions(t, form.ID, 3)
	// Три визита, из них два закончились ответом.
	insertVisits(t, form.ID, 3, 2)

	// Вторая форма без активности: нули не должны «протекать» с соседней строки —
	// именно это ломается, если LATERAL однажды потеряет условие по form_id.
	quiet := createForm(t, c, srv, "Тихая")

	list := listForms(t, c, srv, "")
	byID := make(map[string]formDTO, len(list.Forms))
	for _, f := range list.Forms {
		byID[f.ID] = f
	}

	got := byID[form.ID]
	if got.SubmissionCount != 3 || got.VisitCount != 3 || got.VisitSubmittedCount != 2 {
		t.Fatalf("счётчики активной формы = ответы %d, визиты %d, из них с ответом %d; ожидалось 3/3/2",
			got.SubmissionCount, got.VisitCount, got.VisitSubmittedCount)
	}

	idle := byID[quiet.ID]
	if idle.SubmissionCount != 0 || idle.VisitCount != 0 || idle.VisitSubmittedCount != 0 {
		t.Fatalf("у формы без активности счётчики = %d/%d/%d, ожидались нули",
			idle.SubmissionCount, idle.VisitCount, idle.VisitSubmittedCount)
	}
}

// insertVisits кладёт n визитов формы, из них submitted — закончившихся ответом.
func insertVisits(t *testing.T, formID string, n, submitted int) {
	t.Helper()
	var versionID string
	if err := testPool.QueryRow(context.Background(),
		`SELECT published_version_id::text FROM forms WHERE id = $1`, formID).Scan(&versionID); err != nil {
		t.Fatalf("published_version_id формы %s: %v", formID, err)
	}
	for i := 0; i < n; i++ {
		if _, err := testPool.Exec(context.Background(),
			`INSERT INTO form_visits (id, form_id, form_version_id, submitted) VALUES ($1, $2, $3, $4)`,
			domain.NewID(), formID, versionID, i < submitted); err != nil {
			t.Fatalf("вставка визита: %v", err)
		}
	}
}

// Анти-IDOR: поиск — новый способ адресовать формы, и чужие через него не видны.
func TestForms_Search_DoesNotLeakOtherWorkspace(t *testing.T) {
	resetDB(t)
	srv := newStack(t)

	alice := registerUser(t, srv, "alice-search@example.com")
	createForm(t, alice, srv, "Секретная анкета Алисы")

	bob := registerUser(t, srv, "bob-search@example.com")
	page := listForms(t, bob, srv, "?q="+url.QueryEscape("Секретная"))
	if len(page.Forms) != 0 {
		t.Fatalf("поиск Боба нашёл %d чужих форм, ожидалось 0", len(page.Forms))
	}
}

// insertSubmissions кладёт n ответов на опубликованную версию формы напрямую в БД:
// приём ответа живёт в другом модуле, а тесту нужен только счётчик.
func insertSubmissions(t *testing.T, formID string, n int) {
	t.Helper()
	var versionID string
	err := testPool.QueryRow(context.Background(),
		`SELECT published_version_id::text FROM forms WHERE id = $1`, formID).Scan(&versionID)
	if err != nil {
		t.Fatalf("published_version_id формы %s: %v", formID, err)
	}
	for i := 0; i < n; i++ {
		_, err := testPool.Exec(context.Background(),
			`INSERT INTO submissions (id, form_id, form_version_id, answers) VALUES ($1, $2, $3, '{}')`,
			domain.NewID(), formID, versionID)
		if err != nil {
			t.Fatalf("вставка ответа: %v", err)
		}
	}
}

// --- DTO и HTTP-хелперы ---

type formDTO struct {
	ID                    string  `json:"id"`
	Name                  *string `json:"name"`
	Title                 string  `json:"title"`
	Slug                  string  `json:"slug"`
	Status                string  `json:"status"`
	CreatedAt             string  `json:"createdAt"`
	UpdatedAt             string  `json:"updatedAt"`
	PublishedVersion      *int    `json:"publishedVersion"`
	PublishedVersionID    *string `json:"publishedVersionId"`
	HasUnpublishedChanges bool    `json:"hasUnpublishedChanges"`
	SubmissionCount       int64   `json:"submissionCount"`
	VisitCount            int64   `json:"visitCount"`
	VisitSubmittedCount   int64   `json:"visitSubmittedCount"`
}

type formDetailDTO struct {
	formDTO
	DraftSchema   json.RawMessage `json:"draftSchema"`
	CloseAt       *string         `json:"closeAt"`
	ResponseLimit *int            `json:"responseLimit"`
	ClosedMessage *string         `json:"closedMessage"`
	ClosedTitle   *string         `json:"closedTitle"`
	AutoJump      bool            `json:"autoJump"`
	SaveLocally   bool            `json:"saveLocally"`
	Branding      bool            `json:"branding"`
	Progress      bool            `json:"progress"`
	Password      *string         `json:"password"`
	NotifyMail    struct {
		From     string `json:"from"`
		To       string `json:"to"`
		FromName string `json:"fromName"`
		Subject  string `json:"subject"`
	} `json:"notifyMail"`
	LinkPreview *struct {
		SiteName    string `json:"siteName"`
		Title       string `json:"title"`
		Description string `json:"description"`
		ImageKey    string `json:"imageKey"`
		IconKey     string `json:"iconKey"`
	} `json:"linkPreview"`
	NotifyEmail *struct {
		FromName string        `json:"fromName"`
		ReplyTo  string        `json:"replyTo"`
		Subject  []domain.Span `json:"subject"`
		Body     []domain.Span `json:"body"`
	} `json:"notifyEmail"`
}

type listDTO struct {
	Forms      []formDTO `json:"forms"`
	NextCursor *string   `json:"nextCursor"`
}

func createForm(t *testing.T, c *http.Client, srv *httptest.Server, title string) formDTO {
	t.Helper()
	body := ""
	if title != "" {
		body = `{"title":"` + title + `"}`
	}
	r := do(t, c, http.MethodPost, srv.URL+"/api/v1/forms", body, csrf(t, c, srv.URL))
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("создание формы: статус %d, ожидалось 201; тело=%s", r.StatusCode, body2(t, r))
	}
	var f formDTO
	decode(t, r, &f)
	return f
}

func getFormDetail(t *testing.T, c *http.Client, srv *httptest.Server, id string, wantStatus int) formDetailDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+id, "", "")
	if r.StatusCode != wantStatus {
		t.Fatalf("GET форма: статус %d, ожидалось %d", r.StatusCode, wantStatus)
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDetailDTO{}
	}
	var d formDetailDTO
	decode(t, r, &d)
	return d
}

func getFormDetailBySlug(t *testing.T, c *http.Client, srv *httptest.Server, slug string, wantStatus int) formDetailDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/lookup?slug="+url.QueryEscape(slug), "", "")
	if r.StatusCode != wantStatus {
		t.Fatalf("GET форма by-slug: статус %d, ожидалось %d", r.StatusCode, wantStatus)
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDetailDTO{}
	}
	var d formDetailDTO
	decode(t, r, &d)
	return d
}

// patchName шлёт PATCH {name} — внутреннее имя (дашборд). Публичный заголовок не трогает.
func patchName(t *testing.T, c *http.Client, srv *httptest.Server, id, name string, wantStatus int) formDTO {
	t.Helper()
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, `{"name":"`+name+`"}`, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH имя: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDTO{}
	}
	var f formDTO
	decode(t, r, &f)
	return f
}

// patchDraftSchema шлёт автосейв {draftSchema, updatedAt}. updatedAt передаётся
// строкой ровно как получен из формы (round-trip RFC3339 для оптимистичной блокировки).
func patchDraftSchema(t *testing.T, c *http.Client, srv *httptest.Server, id, schemaJSON, updatedAt string, wantStatus int) formDTO {
	t.Helper()
	body := `{"draftSchema":` + schemaJSON + `,"updatedAt":"` + updatedAt + `"}`
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, body, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH схема: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDTO{}
	}
	var f formDTO
	decode(t, r, &f)
	return f
}

// setBrandingGate открывает или закрывает право снимать бейдж на плане владельца
// формы — тем же UPDATE, каким гейт двигают на проде.
func setBrandingGate(t *testing.T, slug string, allowed bool) {
	t.Helper()
	value := "false"
	if allowed {
		value = "true"
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, '{form_branding}', $1::jsonb)
		 WHERE code = (SELECT s.plan_code FROM subscriptions s
		               JOIN workspace_members o ON o.user_id = s.user_id AND o.role = 'owner'
		               JOIN forms f ON f.workspace_id = o.workspace_id WHERE f.slug = $2)`,
		value, slug); err != nil {
		t.Fatalf("set branding gate: %v", err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE plans SET limits = jsonb_set(limits, '{form_branding}', 'false')
			 WHERE code IN ('free', 'legacy_free')`); err != nil {
			t.Fatalf("reset branding gate: %v", err)
		}
	})
}

// patchBranding шлёт PATCH {branding: <show>} — живой тумблер бейджа.
func patchProgress(t *testing.T, c *http.Client, srv *httptest.Server, id string, show bool, wantStatus int) {
	t.Helper()
	body := `{"progress":false}`
	if show {
		body = `{"progress":true}`
	}
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, body, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH progress: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	closeBody(t, r)
}

func patchBranding(t *testing.T, c *http.Client, srv *httptest.Server, id string, show bool, wantStatus int) {
	t.Helper()
	body := `{"branding":false}`
	if show {
		body = `{"branding":true}`
	}
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, body, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH branding: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	closeBody(t, r)
}

// patchCloseSettings шлёт PATCH {closeSettings: <objJSON>} — живые настройки закрытия.
// patchNotifyEmail шлёт PATCH {notifyEmail: …} — своё письмо о новом ответе.
func patchNotifyEmail(t *testing.T, c *http.Client, srv *httptest.Server, id, objJSON string, wantStatus int) {
	t.Helper()
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, `{"notifyEmail":`+objJSON+`}`, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH notifyEmail: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	closeBody(t, r)
}

// setNotifyEmailGate открывает право на своё письмо у плана владельца формы: ключ
// закрыт на бесплатных планах, а учётка теста заводится на бесплатном.
func setNotifyEmailGate(t *testing.T, slug string, allowed bool) {
	t.Helper()
	value := "false"
	if allowed {
		value = "true"
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, '{form_notify_email}', $1::jsonb)
		 WHERE code = (SELECT s.plan_code FROM subscriptions s
		               JOIN workspace_members o ON o.user_id = s.user_id AND o.role = 'owner'
		               JOIN forms f ON f.workspace_id = o.workspace_id WHERE f.slug = $2)`,
		value, slug); err != nil {
		t.Fatalf("set notify email gate: %v", err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE plans SET limits = jsonb_set(limits, '{form_notify_email}', 'false')
			 WHERE code IN ('free', 'legacy_free')`); err != nil {
			t.Fatalf("reset notify email gate: %v", err)
		}
	})
}

func patchLinkPreview(t *testing.T, c *http.Client, srv *httptest.Server, id, objJSON string, wantStatus int) {
	t.Helper()
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, `{"linkPreview":`+objJSON+`}`, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH linkPreview: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	closeBody(t, r)
}

func patchCloseSettings(t *testing.T, c *http.Client, srv *httptest.Server, id, objJSON string, wantStatus int) formDTO {
	t.Helper()
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, `{"closeSettings":`+objJSON+`}`, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH closeSettings: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDTO{}
	}
	var f formDTO
	decode(t, r, &f)
	return f
}

type publicFormDTO struct {
	Title   string          `json:"title"`
	Version int32           `json:"version"`
	Schema  json.RawMessage `json:"schema"`
	// Token остаётся полем DTO, чтобы тест мог доказать его ОТСУТСТВИЕ в
	// кэшируемом теле: токен выдаёт отдельная некэшируемая ручка (ADR §10).
	Token       string `json:"token"`
	ShowBadge   bool   `json:"showBadge"`
	Progress    bool   `json:"progress"`
	AutoJump    bool   `json:"autoJump"`
	SaveLocally bool   `json:"saveLocally"`
}

// getFormToken — токен времени отдельной ручкой; возвращает его и Cache-Control.
func getFormToken(t *testing.T, c *http.Client, srv *httptest.Server) (string, string) {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/public/v1/form-token", "", "")
	defer closeBody(t, r)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("статус выдачи токена %d, ожидалось 200", r.StatusCode)
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatalf("тело токена не парсится: %v", err)
	}
	return body.Token, r.Header.Get("Cache-Control")
}

func getPublic(t *testing.T, c *http.Client, srv *httptest.Server, slug string, wantStatus int) {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/public/v1/forms/"+slug, "", "")
	if r.StatusCode != wantStatus {
		t.Fatalf("GET public форма: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	closeBody(t, r)
}

func getPublicOK(t *testing.T, c *http.Client, srv *httptest.Server, slug string) (publicFormDTO, string) {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/public/v1/forms/"+slug, "", "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET public форма: статус %d, ожидалось 200; тело=%s", r.StatusCode, body2(t, r))
	}
	etag := r.Header.Get("ETag")
	var pub publicFormDTO
	decode(t, r, &pub)
	return pub, etag
}

func doWithHeader(t *testing.T, c *http.Client, method, u, header, value string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, u, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set(header, value)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	return resp
}

func publishForm(t *testing.T, c *http.Client, srv *httptest.Server, id string, wantStatus int) formDTO {
	t.Helper()
	return postFormAction(t, c, srv, id, "publish", wantStatus)
}

func unpublishForm(t *testing.T, c *http.Client, srv *httptest.Server, id string, wantStatus int) formDTO {
	t.Helper()
	return postFormAction(t, c, srv, id, "unpublish", wantStatus)
}

func postFormAction(t *testing.T, c *http.Client, srv *httptest.Server, id, action string, wantStatus int) formDTO {
	t.Helper()
	r := do(t, c, http.MethodPost, srv.URL+"/api/v1/forms/"+id+"/"+action, "", csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("POST %s: статус %d, ожидалось %d; тело=%s", action, r.StatusCode, wantStatus, body2(t, r))
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDTO{}
	}
	var f formDTO
	decode(t, r, &f)
	return f
}

// duplicateForm дёргает POST /forms/{id}/duplicate; на успехе (201) декодирует
// новую форму, иначе (напр. 404) — закрывает тело и возвращает пустую.
func duplicateForm(t *testing.T, c *http.Client, srv *httptest.Server, id string, wantStatus int) formDTO {
	t.Helper()
	r := do(t, c, http.MethodPost, srv.URL+"/api/v1/forms/"+id+"/duplicate", "", csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("POST duplicate: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	if wantStatus != http.StatusCreated {
		closeBody(t, r)
		return formDTO{}
	}
	var f formDTO
	decode(t, r, &f)
	return f
}

func deleteForm(t *testing.T, c *http.Client, srv *httptest.Server, id string, wantStatus int) {
	t.Helper()
	r := do(t, c, http.MethodDelete, srv.URL+"/api/v1/forms/"+id, "", csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("DELETE форма: статус %d, ожидалось %d", r.StatusCode, wantStatus)
	}
	closeBody(t, r)
}

func listForms(t *testing.T, c *http.Client, srv *httptest.Server, query string) listDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms"+query, "", "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("список форм: статус %d, ожидалось 200; тело=%s", r.StatusCode, body2(t, r))
	}
	var l listDTO
	decode(t, r, &l)
	return l
}

func parseSchema(t *testing.T, raw json.RawMessage) domain.FormSchema {
	t.Helper()
	var s domain.FormSchema
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatalf("draftSchema не парсится: %v (%s)", err, raw)
	}
	return s
}

func cursorParam(cursor string) string {
	if cursor == "" {
		return ""
	}
	return "&cursor=" + url.QueryEscape(cursor)
}

// --- низкоуровневые хелперы ---

func newClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookie jar: %v", err)
	}
	return &http.Client{Jar: jar}
}

func do(t *testing.T, c *http.Client, method, u, jsonBody, csrfTok string) *http.Response {
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
	if csrfTok != "" {
		req.Header.Set("X-CSRF-Token", csrfTok)
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
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

func decode(t *testing.T, r *http.Response, v any) {
	t.Helper()
	defer closeBody(t, r)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func closeBody(t *testing.T, r *http.Response) {
	t.Helper()
	if err := r.Body.Close(); err != nil {
		t.Errorf("close body: %v", err)
	}
}

func body2(t *testing.T, r *http.Response) string {
	t.Helper()
	defer closeBody(t, r)
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return "read body: " + err.Error()
	}
	return string(b)
}

// Явный workspaceId — не пропуск: чужое пространство неотличимо от
// несуществующего (404, не 403), и форма в нём не заводится.
//
// Анти-IDOR на новом параметре (DoD фазы 18): до него воркспейс выводился из
// самого пользователя и подменить его было нечем — теперь есть.
func TestForms_ForeignWorkspaceIsNotFound(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice@example.com")
	bob := registerUser(t, srv, "bob@example.com")

	// Пространство Алисы: её личное, id берём из БД (кабинет Боба его не видит).
	var aliceWS string
	if err := testPool.QueryRow(context.Background(),
		`SELECT w.id FROM workspaces w
		   JOIN users u ON u.id = w.personal_user_id
		  WHERE u.email = 'alice@example.com'`).Scan(&aliceWS); err != nil {
		t.Fatalf("личное пространство Алисы: %v", err)
	}
	createForm(t, alice, srv, "Форма Алисы")

	r := do(t, bob, http.MethodGet, srv.URL+"/api/v1/forms?workspaceId="+aliceWS, "", "")
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("список чужого пространства: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)

	r = do(t, bob, http.MethodPost, srv.URL+"/api/v1/forms",
		`{"title":"Подсадная","workspaceId":"`+aliceWS+`"}`, csrf(t, bob, srv.URL))
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("создание в чужом пространстве: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)

	// У Алисы по-прежнему ровно её собственная форма.
	if got := listForms(t, alice, srv, ""); len(got.Forms) != 1 {
		t.Fatalf("форм у Алисы = %d, ожидалась 1 — чужая запись просочилась", len(got.Forms))
	}
}

// Свой workspaceId работает как раньше, а мусор вместо uuid — ошибка ввода, а
// не молчаливый откат к личному пространству.
func TestForms_OwnWorkspaceIDAndGarbage(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "owner@example.com")
	createForm(t, c, srv, "Своя форма")

	var ownWS string
	if err := testPool.QueryRow(context.Background(),
		`SELECT w.id FROM workspaces w
		   JOIN users u ON u.id = w.personal_user_id
		  WHERE u.email = 'owner@example.com'`).Scan(&ownWS); err != nil {
		t.Fatalf("своё пространство: %v", err)
	}

	if got := listForms(t, c, srv, "?workspaceId="+ownWS); len(got.Forms) != 1 {
		t.Fatalf("форм = %d, ожидалась 1 при явном своём workspaceId", len(got.Forms))
	}

	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms?workspaceId=не-uuid", "", "")
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("мусорный workspaceId: статус %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)
}

// Опубликованная форма удалённого владельца отвечает 404 (фаза 23, слайс G) —
// вторая половина шестого пункта критерия приёмки. Без неё «аккаунт удалён»
// означало бы форму, которая продолжает принимать чужие персональные данные от
// имени человека, которого у нас больше нет.
//
// Пометка ставится здесь UPDATE-ом, а не ручкой /account/delete: та живёт в auth
// (и покрыта своим набором), проверяется же тут ПУБЛИЧНЫЙ путь.
func TestForms_PublicFetch_DeletedOwnerIs404(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	owner := registerUser(t, srv, "leaving-owner@example.com")
	anon := newClient(t)

	form := createForm(t, owner, srv, "Опрос уходящего")
	schema := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":true,"settings":{}}]}`
	patchDraftSchema(t, owner, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)
	publishForm(t, owner, srv, form.ID, http.StatusOK)
	getPublic(t, anon, srv, form.Slug, http.StatusOK)

	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET deleted_at = now() WHERE email = 'leaving-owner@example.com'`); err != nil {
		t.Fatalf("пометка владельца удалённым: %v", err)
	}

	// 404, а не 410: у 410 есть смысл «форма была, приём закрыт», и он рассказал
	// бы о форме удалённого аккаунта больше, чем нужно. 404 — тот же ответ, что
	// у черновика (инвариант 5).
	getPublic(t, anon, srv, form.Slug, http.StatusNotFound)
}

// --- Пароль на форму (0047) -------------------------------------------------

// Сквозной путь пароля: постановка, отказ публичной выдаче, разблокировка,
// повторное чтение автором и снятие. Проверяется снаружи, тем же путём, каким
// пойдёт респондент.
func TestForms_Password_LocksPublicFormAndUnlocks(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-password@example.com")
	anon := newClient(t)

	form := createForm(t, alice, srv, "Опрос про доставку")
	publishForm(t, alice, srv, form.ID, http.StatusOK)

	// До пароля форма открыта всем и кэшируется как обычно.
	if _, etag := getPublicOK(t, anon, srv, form.Slug); etag == "" {
		t.Fatal("у формы без пароля обязан быть ETag")
	}

	const password = "секрет для коллег"
	patchPassword(t, alice, srv, form.ID, `"`+password+`"`, http.StatusOK)

	// Публичная выдача закрыта: 401, схемы в теле нет, кэша нет.
	r := do(t, anon, http.MethodGet, srv.URL+"/public/v1/forms/"+form.Slug, "", "")
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("GET под паролем: статус %d, ожидалось 401", r.StatusCode)
	}
	if cc := r.Header.Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, ожидалось no-store", cc)
	}
	var locked struct {
		Locked bool            `json:"locked"`
		Title  string          `json:"title"`
		Schema json.RawMessage `json:"schema"`
	}
	decode(t, r, &locked)
	if !locked.Locked || len(locked.Schema) != 0 {
		t.Fatalf("тело отказа выдало схему: %+v", locked)
	}
	// Название на экране ввода видно (решение владельца, спека §2.3).
	if locked.Title != "Опрос про доставку" {
		t.Fatalf("название = %q", locked.Title)
	}

	// Неверный пароль токена не даёт.
	r = do(t, anon, http.MethodPost, srv.URL+"/public/v1/forms/"+form.Slug+"/unlock",
		`{"password":"не тот"}`, "")
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("неверный пароль: статус %d, ожидалось 401", r.StatusCode)
	}
	closeBody(t, r)

	// Верный — даёт, и с ним форма отдаётся целиком.
	tok := unlockForm(t, anon, srv, form.Slug, password)
	r = doWithHeader(t, anon, http.MethodGet, srv.URL+"/public/v1/forms/"+form.Slug, "X-Form-Unlock", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET с токеном: статус %d, ожидалось 200; тело=%s", r.StatusCode, body2(t, r))
	}
	closeBody(t, r)

	// Автор видит свой пароль на экране настроек и может его скопировать.
	d := getFormDetail(t, alice, srv, form.ID, http.StatusOK)
	if d.Password == nil || *d.Password != password {
		t.Fatalf("пароль не вернулся автору: %v", d.Password)
	}

	// Снятие открывает форму снова — без перепубликации.
	patchPassword(t, alice, srv, form.ID, "null", http.StatusOK)
	if _, etag := getPublicOK(t, anon, srv, form.Slug); etag == "" {
		t.Fatal("после снятия пароля форма обязана отдаваться как обычная")
	}
	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.Password != nil {
		t.Fatalf("пароль остался после снятия: %q", *d.Password)
	}
}

// Токен одной формы не открывает другую: иначе один известный пароль открывал бы
// все формы сервиса разом.
func TestForms_Password_TokenIsPerForm(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-password2@example.com")
	anon := newClient(t)

	first := createForm(t, alice, srv, "Первая")
	publishForm(t, alice, srv, first.ID, http.StatusOK)
	patchPassword(t, alice, srv, first.ID, `"общий"`, http.StatusOK)

	second := createForm(t, alice, srv, "Вторая")
	publishForm(t, alice, srv, second.ID, http.StatusOK)
	patchPassword(t, alice, srv, second.ID, `"другой"`, http.StatusOK)

	tok := unlockForm(t, anon, srv, first.Slug, "общий")
	r := doWithHeader(t, anon, http.MethodGet, srv.URL+"/public/v1/forms/"+second.Slug, "X-Form-Unlock", tok)
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("чужой токен открыл вторую форму: статус %d", r.StatusCode)
	}
	closeBody(t, r)
}

// Пароль не спрашивает тарифа: он бесплатен на всех планах (решение владельца
// 2026-09-01). Проверяем на free — плане нового пользователя.
func TestForms_Password_FreePlanAllowed(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-password3@example.com")

	form := createForm(t, alice, srv, "Анкета")
	patchPassword(t, alice, srv, form.ID, `"пароль"`, http.StatusOK)
}

func TestForms_Password_Validation(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-password4@example.com")
	form := createForm(t, alice, srv, "Анкета")

	patchPassword(t, alice, srv, form.ID, `""`, http.StatusUnprocessableEntity)
	patchPassword(t, alice, srv, form.ID, `"`+strings.Repeat("я", 129)+`"`, http.StatusUnprocessableEntity)

	// Пароль — отдельный фасет: вместе с другим за один запрос не едет.
	r := do(t, alice, http.MethodPatch, srv.URL+"/api/v1/forms/"+form.ID,
		`{"password":{"value":"a"},"branding":false}`, csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("два фасета разом: статус %d, ожидалось 422", r.StatusCode)
	}
	closeBody(t, r)
}

// Чужая форма паролем не закрывается: id из URL правом доступа не является.
func TestForms_Password_ForeignFormIsNotFound(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-password5@example.com")
	bob := registerUser(t, srv, "bob-password5@example.com")

	form := createForm(t, alice, srv, "Анкета")
	patchPassword(t, bob, srv, form.ID, `"пароль"`, http.StatusNotFound)

	if d := getFormDetail(t, alice, srv, form.ID, http.StatusOK); d.Password != nil {
		t.Fatal("чужой поставил пароль на форму")
	}
}

// patchPassword шлёт PATCH {password:{value: <valueJSON>}}: строка — поставить,
// null — снять. Обёртка вокруг value отличает «снять» от «не трогать».
func patchPassword(t *testing.T, c *http.Client, srv *httptest.Server, id, valueJSON string, wantStatus int) {
	t.Helper()
	body := `{"password":{"value":` + valueJSON + `}}`
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, body, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH password: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	closeBody(t, r)
}

// unlockForm называет пароль и возвращает токен разблокировки.
func unlockForm(t *testing.T, c *http.Client, srv *httptest.Server, slug, password string) string {
	t.Helper()
	body, err := json.Marshal(map[string]string{"password": password})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	r := do(t, c, http.MethodPost, srv.URL+"/public/v1/forms/"+slug+"/unlock", string(body), "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("unlock: статус %d, ожидалось 200; тело=%s", r.StatusCode, body2(t, r))
	}
	var out struct {
		Token string `json:"token"`
	}
	decode(t, r, &out)
	if out.Token == "" {
		t.Fatal("токен разблокировки пуст")
	}
	return out.Token
}

// Ручка разблокировки обязана видеть форму ровно так же, как её отдача. Иначе она
// становится оракулом существования: у формы удалённого аккаунта GET отдаёт 404
// (фаза 23, слайс G), а unlock отвечал бы 401 — то есть подтверждал, что форма была.
func TestForms_Password_UnlockHidesFormOfDeletedOwner(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-password6@example.com")

	form := createForm(t, alice, srv, "Анкета")
	publishForm(t, alice, srv, form.ID, http.StatusOK)
	patchPassword(t, alice, srv, form.ID, `"секрет"`, http.StatusOK)

	// Владелец удалил аккаунт: форма перестаёт существовать для публичного пути.
	if _, err := testPool.Exec(context.Background(),
		`UPDATE users SET deleted_at = now() WHERE email = $1`, "alice-password6@example.com"); err != nil {
		t.Fatalf("пометить аккаунт удалённым: %v", err)
	}

	anon := newClient(t)
	getPublic(t, anon, srv, form.Slug, http.StatusNotFound)

	// И разблокировка — тоже 404, даже с ВЕРНЫМ паролем: иначе она отличала бы
	// «форма была» от «такой формы нет» ровно там, где отдача их уравнивает.
	r := do(t, anon, http.MethodPost, srv.URL+"/public/v1/forms/"+form.Slug+"/unlock",
		`{"password":"секрет"}`, "")
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("unlock у формы удалённого владельца: статус %d, ожидалось 404", r.StatusCode)
	}
	closeBody(t, r)
}
