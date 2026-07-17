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
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/forms"
	"github.com/ka-shmd/trierra/internal/pgtest"
	"github.com/ka-shmd/trierra/internal/postgres"
	"github.com/ka-shmd/trierra/internal/ratelimit"
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

// newStack собирает реальную вертикаль auth+forms поверх контейнерного пула.
// fixtureIndexPath кладёт минимальный собранный index.html рендерера (с плейсхолдером
// <!--og-meta-->) во временный файл — так же, как его получит api из смонтированной
// статики в проде. Нужен, чтобы Go регистрировал и обслуживал /r в этом стеке.
func fixtureIndexPath(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "index.html")
	const html = `<!doctype html><html lang="ru"><head>` +
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
func newStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, time.Hour)
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})
	formsH := forms.NewHandler(formsSvc, authH.RequireAuth, authH.RequireCSRF)
	formsPublic, err := forms.NewPublicHandler(formsSvc, []byte("dev-only-form-token-secret-not-a-real-key"),
		"http://localhost:5174", "http://localhost:5174/og-preview.png", fixtureIndexPath(t))
	if err != nil {
		t.Fatalf("NewPublicHandler: %v", err)
	}

	mux := http.NewServeMux()
	authH.Routes(mux)
	formsH.Routes(mux)
	formsPublic.Routes(mux)
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

	// GET → отдаёт draft_schema (точка входа заглушки редактора).
	detail := getFormDetail(t, c, srv, created.ID, http.StatusOK)
	if string(detail.DraftSchema) != `{"blocks":[]}` {
		t.Fatalf("draftSchema = %s, ожидался пустой каркас", detail.DraftSchema)
	}

	// Переименование.
	renamed := patchTitle(t, c, srv, created.ID, "Опрос клиентов", http.StatusOK)
	if renamed.Title != "Опрос клиентов" {
		t.Fatalf("title после переименования = %q", renamed.Title)
	}

	// Список содержит форму.
	if list := listForms(t, c, srv, ""); len(list.Forms) != 1 || list.Forms[0].ID != created.ID {
		t.Fatalf("список = %+v, ожидалась одна форма %s", list.Forms, created.ID)
	}

	// Удаление → потом 404.
	deleteForm(t, c, srv, created.ID, http.StatusNoContent)
	getFormDetail(t, c, srv, created.ID, http.StatusNotFound)
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
	// B переименовывает форму A → 404 (и не меняет её).
	patchTitle(t, bob, srv, form.ID, "взломано", http.StatusNotFound)
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
	schema := `{"blocks":[{"id":"b1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}}]}`
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

	// Черновик копии = черновик оригинала (канонизированный).
	got := parseSchema(t, getFormDetail(t, alice, srv, dup.ID, http.StatusOK).DraftSchema)
	if len(got.Blocks) != 1 || got.Blocks[0].ID != "b1" || got.Blocks[0].Label != "Имя" {
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

// Автосейв билдера: валидная схема сохраняется (канонизированной, updated_at
// сдвигается), мусор → 422, устаревший updated_at → 409, схема без updated_at → 422.
func TestForms_DraftSchemaAutosave(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	c := registerUser(t, srv, "builder@example.com")

	form := createForm(t, c, srv, "Анкета")

	// Валидное сохранение: schemaVersion опущен — сервер обязан канонизировать (=1).
	schema := `{"blocks":[{"id":"b1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}}]}`
	saved := patchDraftSchema(t, c, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)
	if saved.UpdatedAt == form.UpdatedAt {
		t.Fatalf("updated_at не сдвинулся после сохранения: %s", saved.UpdatedAt)
	}

	// GET отдаёт канонизированный документ: schemaVersion проставлен (=1), блок цел.
	// Порядок ключей задаёт JSONB (не Go-маршалинг), поэтому сверяем разбором.
	got := parseSchema(t, getFormDetail(t, c, srv, form.ID, http.StatusOK).DraftSchema)
	if got.SchemaVersion != 1 || len(got.Blocks) != 1 {
		t.Fatalf("канонизация не проставила schemaVersion/блок: %+v", got)
	}
	if b := got.Blocks[0]; b.ID != "b1" || b.Type != "short_text" || b.Label != "Имя" || !b.Required {
		t.Fatalf("блок сохранён неверно: %+v", b)
	}

	// Мусор (неизвестный тип блока) с актуальным updated_at → 422.
	garbage := `{"blocks":[{"id":"b1","type":"slider","label":"x"}]}`
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
	schema := `{"blocks":[{"id":"b1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}}]}`
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
	schemaA := `{"blocks":[{"id":"b1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}}]}`
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

	// Переименование не версионируется → бейдж не поднимается.
	patchTitle(t, c, srv, form.ID, "Анкета 2", http.StatusOK)
	if getFormDetail(t, c, srv, form.ID, http.StatusOK).HasUnpublishedChanges {
		t.Fatal("переименование не должно давать неопубликованных изменений")
	}

	// Правка черновика → расходится с версией → бейдж. updated_at сдвинут
	// публикацией и переименованием — берём свежий из GET.
	cur := getFormDetail(t, c, srv, form.ID, http.StatusOK)
	schemaB := `{"blocks":[{"id":"b1","type":"short_text","label":"Имя и фамилия","description":"","required":true,"settings":{}}]}`
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
	schema := `{"blocks":[{"id":"b1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}}]}`
	patchDraftSchema(t, owner, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)
	publishForm(t, owner, srv, form.ID, http.StatusOK)

	// Публичная выдача: 200, title/version/schema/token, ETag выставлен.
	pub, etag := getPublicOK(t, anon, srv, form.Slug)
	if pub.Title != "Публичный опрос" || pub.Version != 1 {
		t.Fatalf("публичная форма: %+v", pub)
	}
	if pub.Token == "" || etag == "" {
		t.Fatalf("нет token (%q) или ETag (%q)", pub.Token, etag)
	}
	got := parseSchema(t, pub.Schema)
	if len(got.Blocks) != 1 || got.Blocks[0].ID != "b1" {
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

	schema := `{"blocks":[{"id":"b1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}}]}`
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
}

type formDetailDTO struct {
	formDTO
	DraftSchema json.RawMessage `json:"draftSchema"`
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

func patchTitle(t *testing.T, c *http.Client, srv *httptest.Server, id, title string, wantStatus int) formDTO {
	t.Helper()
	r := do(t, c, http.MethodPatch, srv.URL+"/api/v1/forms/"+id, `{"title":"`+title+`"}`, csrf(t, c, srv.URL))
	if r.StatusCode != wantStatus {
		t.Fatalf("PATCH форма: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return formDTO{}
	}
	var f formDTO
	decode(t, r, &f)
	return f
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

type publicFormDTO struct {
	Title   string          `json:"title"`
	Version int32           `json:"version"`
	Schema  json.RawMessage `json:"schema"`
	Token   string          `json:"token"`
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
