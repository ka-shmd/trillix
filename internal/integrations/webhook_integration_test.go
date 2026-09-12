//go:build integration

// Вебхуки против настоящего Postgres: заведение, права двух ролей и постороннего,
// потолок на форму, отказы адреса через настоящий safehttp и вид секрета в базе.
// DNS подменён — тест не должен зависеть от интернета; всё остальное настоящее.
package integrations_test

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/ka-shmd/trillix/internal/safehttp"
)

// staticResolver — DNS без сети. Имя, которого нет в карте, не резолвится.
type staticResolver map[string][]string

func (r staticResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	ss, ok := r[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	out := make([]netip.Addr, len(ss))
	for i, s := range ss {
		out[i] = netip.MustParseAddr(s)
	}
	return out, nil
}

// testEgress — боевой Guard и подменённый DNS: публичное имя, имя во внутренней
// сети и «свой» хост продукта.
func testEgress() *safehttp.Client {
	return safehttp.New(safehttp.PublicOnly{}, safehttp.Options{
		OwnHosts: []string{"app.trillix.test"},
		Resolver: staticResolver{
			"hooks.example.com":    {"93.184.216.34"},
			"internal.example.com": {"10.0.0.5"},
			"app.trillix.test":     {"93.184.216.34"},
		},
	})
}

const hookURL = "https://hooks.example.com/hooks/catch/1/SECRETPATH"

type webhookDTO struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Host    string `json:"host"`
	URL     string `json:"url"`
	Enabled bool   `json:"enabled"`
	Status  string `json:"status"`
	Queued  int64  `json:"queued"`
	Signed  bool   `json:"signed"`
	Secret  string `json:"secret"`
	Headers []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"headers"`
}

func webhooksOf(t *testing.T, c *http.Client, srv *httptest.Server, formID string) []webhookDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/integrations")
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("состояние формы: статус %d", r.StatusCode)
	}
	var got struct {
		Webhooks []webhookDTO `json:"webhooks"`
	}
	decode(t, r, &got)
	return got.Webhooks
}

func createWebhook(t *testing.T, c *http.Client, srv *httptest.Server, formID, body string) *http.Response {
	t.Helper()
	return postBodyWithCSRF(t, c, srv, "/api/v1/forms/"+formID+"/webhooks", body)
}

func mustCreateWebhook(t *testing.T, c *http.Client, srv *httptest.Server, formID string) webhookDTO {
	t.Helper()
	r := createWebhook(t, c, srv, formID, `{"name":"CRM","url":"`+hookURL+`"}`)
	if r.StatusCode != http.StatusCreated {
		closeBody(t, r)
		t.Fatalf("заведение вебхука: статус %d, ожидалось 201", r.StatusCode)
	}
	var got webhookDTO
	decode(t, r, &got)
	return got
}

func userID(t *testing.T, email string) string {
	t.Helper()
	var id string
	if err := testPool.QueryRow(context.Background(), `SELECT id FROM users WHERE email = $1`, email).Scan(&id); err != nil {
		t.Fatalf("пользователь %s: %v", email, err)
	}
	return id
}

func TestWebhooks_Lifecycle(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-hook")

	r := createWebhook(t, owner, srv, formID, `{"name":"CRM","url":"  `+hookURL+`  "}`)
	if r.StatusCode != http.StatusCreated {
		closeBody(t, r)
		t.Fatalf("заведение: статус %d, ожидалось 201", r.StatusCode)
	}
	if cc := r.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q — ответ с полным адресом кэшируется", cc)
	}
	var created webhookDTO
	decode(t, r, &created)
	if created.URL != hookURL || created.Host != "hooks.example.com" {
		t.Fatalf("заведённый вебхук = %+v", created)
	}
	// Подписи по умолчанию нет: подключение — это адрес и всё (ADR §10).
	if created.Secret != "" || created.Signed {
		t.Fatalf("у свежего вебхука завелась подпись: %+v", created)
	}

	// В базе секрета нет вовсе, адрес обрезан, ответственный — заведший.
	var sealed []byte
	var setBy, stored string
	if err := testPool.QueryRow(context.Background(),
		`SELECT secret, set_by, url FROM form_webhooks WHERE id = $1`, created.ID).Scan(&sealed, &setBy, &stored); err != nil {
		t.Fatalf("строка вебхука: %v", err)
	}
	if len(sealed) != 0 {
		t.Fatalf("в базе завёлся секрет (%d байт) при выключенной подписи", len(sealed))
	}
	if setBy != userID(t, "owner@example.com") || stored != hookURL {
		t.Fatalf("set_by=%s url=%q", setBy, stored)
	}

	// Включили подпись своим секретом — он появился и лёг шифротекстом.
	secret := enableSignature(t, owner, srv, formID, created.ID)
	if err := testPool.QueryRow(context.Background(),
		`SELECT secret FROM form_webhooks WHERE id = $1`, created.ID).Scan(&sealed); err != nil {
		t.Fatalf("строка вебхука: %v", err)
	}
	if len(sealed) == 0 {
		t.Fatal("включение подписи не завело секрет")
	}
	if bytes.Contains(sealed, []byte(secret)) {
		t.Fatal("секрет лёг в базу открытым текстом")
	}
	if got := webhooksOf(t, owner, srv, formID)[0]; !got.Signed {
		t.Fatalf("признак подписи = %+v", got)
	}

	// Выключили — секрет удалён, признак снят.
	resp := deleteWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/webhooks/"+created.ID+"/secret")
	closeBody(t, resp)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("выключение подписи: статус %d", resp.StatusCode)
	}
	if got := webhooksOf(t, owner, srv, formID)[0]; got.Signed {
		t.Fatal("признак подписи остался после выключения")
	}

	list := webhooksOf(t, owner, srv, formID)
	if len(list) != 1 || list[0].URL != hookURL || !list[0].Enabled || list[0].Status != "live" || list[0].Queued != 0 {
		t.Fatalf("список = %+v", list)
	}
	if list[0].Secret != "" {
		t.Fatal("секрет попал в состояние таба")
	}

	if r := patchWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/webhooks/"+created.ID, `{"name":"Архив"}`); r.StatusCode != http.StatusNoContent {
		closeBody(t, r)
		t.Fatalf("правка подписи: статус %d", r.StatusCode)
	} else {
		closeBody(t, r)
	}
	if got := webhooksOf(t, owner, srv, formID); got[0].Name != "Архив" || !got[0].Enabled {
		t.Fatalf("после правки подписи %+v — тумблер обязан остаться включённым", got[0])
	}

	if r := deleteWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/webhooks/"+created.ID); r.StatusCode != http.StatusNoContent {
		closeBody(t, r)
		t.Fatalf("удаление: статус %d", r.StatusCode)
	} else {
		closeBody(t, r)
	}
	if got := webhooksOf(t, owner, srv, formID); len(got) != 0 {
		t.Fatalf("после удаления список = %+v", got)
	}
}

// Отказы адреса — через настоящий safehttp и настоящий маппинг в 422: во
// внутреннюю сеть, по http, на свой домен, с логином в адресе.
func TestWebhooks_RefusesBadAddresses(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-ssrf")

	for _, raw := range []string{
		"https://127.0.0.1/hook",
		"https://[::1]/hook",
		"https://169.254.169.254/latest/meta-data",
		"https://internal.example.com/hook",
		"http://hooks.example.com/hook",
		"https://app.trillix.test/api/v1/x",
		"https://user:pw@hooks.example.com/hook",
		"https://nx.example.com/hook",
		"hooks.example.com/hook",
	} {
		r := createWebhook(t, owner, srv, formID, `{"url":"`+raw+`"}`)
		if r.StatusCode != http.StatusUnprocessableEntity {
			closeBody(t, r)
			t.Errorf("%s: статус %d, ожидалось 422", raw, r.StatusCode)
			continue
		}
		var body struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		decode(t, r, &body)
		if !strings.ContainsAny(body.Error.Message, "абвгдеёжзийклмнопрстуфхцчшщъыьэюя") {
			t.Errorf("%s: текст отказа %q — ожидался человеческий русский", raw, body.Error.Message)
		}
	}
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM form_webhooks`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("вебхуков в базе %d (%v), ожидалось ни одного", n, err)
	}
}

func TestWebhooks_CapPerForm(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-cap")

	for i := 0; i < 5; i++ {
		mustCreateWebhook(t, owner, srv, formID)
	}
	r := createWebhook(t, owner, srv, formID, `{"url":"`+hookURL+`"}`)
	closeBody(t, r)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("шестой вебхук: статус %d, ожидалось 422", r.StatusCode)
	}
	// Потолок — на форму, а не на человека: у соседней формы свои пять.
	other := newForm(t, personalWorkspace(t), "f-cap-2")
	mustCreateWebhook(t, owner, srv, other)
}

// Посторонний не отличает чужой вебхук от несуществующего: 404 на всё
// (инвариант 5), и адрес чужого вебхука он даже не проверит у нас резолвом.
func TestWebhooks_StrangerGetsNotFound(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-private")
	hook := mustCreateWebhook(t, owner, srv, formID)
	stranger := registerUser(t, srv, "stranger@example.com")

	base := "/api/v1/forms/" + formID + "/webhooks"
	for name, r := range map[string]*http.Response{
		"заведение": createWebhook(t, stranger, srv, formID, `{"url":"`+hookURL+`"}`),
		"правка":    patchWithCSRF(t, stranger, srv, base+"/"+hook.ID, `{"enabled":false}`),
		"секрет":    do(t, stranger, http.MethodGet, srv.URL+base+"/"+hook.ID+"/secret"),
		"подпись":   postBodyWithCSRF(t, stranger, srv, base+"/"+hook.ID+"/secret", `{"secret":"`+hookSecret+`"}`),
		"удаление":  deleteWithCSRF(t, stranger, srv, base+"/"+hook.ID),
	} {
		closeBody(t, r)
		if r.StatusCode != http.StatusNotFound {
			t.Errorf("%s посторонним: статус %d, ожидалось 404", name, r.StatusCode)
		}
	}
	if got := webhooksOf(t, owner, srv, formID); len(got) != 1 || !got[0].Enabled {
		t.Fatalf("вебхук владельца после попыток постороннего: %+v", got)
	}
}

// Редактор правит вебхук владельца, и тот, кто задал адрес последним, становится
// ответственным за доставку — сторож членства спрашивает про него.
func TestWebhooks_EditorBecomesResponsible(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	wsID := personalWorkspace(t)
	editor := registerUser(t, srv, "editor@example.com")
	addMember(t, wsID, "editor@example.com", "editor")
	formID := newForm(t, wsID, "f-team")
	hook := mustCreateWebhook(t, owner, srv, formID)

	// Редактор видит полный адрес: он вправе править форму.
	if got := webhooksOf(t, editor, srv, formID); len(got) != 1 || got[0].URL != hookURL {
		t.Fatalf("вебхук глазами редактора = %+v", got)
	}

	r := patchWithCSRF(t, editor, srv, "/api/v1/forms/"+formID+"/webhooks/"+hook.ID,
		`{"url":"https://hooks.example.com/other"}`)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("правка адреса редактором: статус %d", r.StatusCode)
	}
	var setBy string
	if err := testPool.QueryRow(context.Background(), `SELECT set_by FROM form_webhooks WHERE id = $1`, hook.ID).Scan(&setBy); err != nil {
		t.Fatalf("строка вебхука: %v", err)
	}
	if setBy != userID(t, "editor@example.com") {
		t.Fatal("ответственным за адрес остался владелец, хотя адрес задал редактор")
	}
}

// Выключение снимает ждущие ответы тем же движением; удалённый ответ уходит из
// очереди каскадом.
func TestWebhooks_DisableClearsQueue(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-queue")
	versionID := publishVersion(t, formID)
	hook := mustCreateWebhook(t, owner, srv, formID)

	for i := 0; i < 2; i++ {
		sub := newSubmission(t, formID, versionID, `{"b1":"Кирилл"}`)
		if _, err := testPool.Exec(context.Background(),
			`INSERT INTO webhook_queue (webhook_id, submission_id) VALUES ($1, $2)`, hook.ID, sub); err != nil {
			t.Fatalf("постановка в очередь: %v", err)
		}
	}
	if got := webhooksOf(t, owner, srv, formID); got[0].Queued != 2 {
		t.Fatalf("в очереди %d, ожидалось 2", got[0].Queued)
	}

	r := patchWithCSRF(t, owner, srv, "/api/v1/forms/"+formID+"/webhooks/"+hook.ID, `{"enabled":false}`)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("выключение: статус %d", r.StatusCode)
	}
	got := webhooksOf(t, owner, srv, formID)
	if got[0].Enabled || got[0].Queued != 0 {
		t.Fatalf("после выключения %+v — очередь обязана опустеть", got[0])
	}
	if got[0].Name != "CRM" {
		t.Fatalf("выключение переписало подпись: %q", got[0].Name)
	}
}

func TestWebhooks_SecretShowAndReplace(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-secret")
	hook := mustCreateWebhook(t, owner, srv, formID)
	hook.Secret = enableSignature(t, owner, srv, formID, hook.ID)
	path := "/api/v1/forms/" + formID + "/webhooks/" + hook.ID + "/secret"

	show := func() string {
		t.Helper()
		r := do(t, owner, http.MethodGet, srv.URL+path)
		if r.StatusCode != http.StatusOK {
			closeBody(t, r)
			t.Fatalf("показ секрета: статус %d", r.StatusCode)
		}
		if cc := r.Header.Get("Cache-Control"); cc != "no-store" {
			t.Errorf("Cache-Control = %q", cc)
		}
		var body struct {
			Secret string `json:"secret"`
		}
		decode(t, r, &body)
		return body.Secret
	}

	if got := show(); got != hook.Secret {
		t.Fatalf("показан %q, ожидался заданный при включении подписи", got)
	}

	// Смена секрета: 204 и ни слова в ответ — секрет и так у того, кто его ввёл.
	const next = "новый-секрет-на-все-формы"
	r := postBodyWithCSRF(t, owner, srv, path, `{"secret":"`+next+`"}`)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("смена секрета: статус %d", r.StatusCode)
	}
	if got := show(); got != next {
		t.Fatalf("после смены показан %q, ожидался новый", got)
	}

	// Пустое тело — отказ, а не «сгенерируй сам»: своего секрета продукт не
	// заводит, и подпись неизвестно чем была бы хуже её отсутствия.
	r = postWithCSRF(t, owner, srv, path)
	closeBody(t, r)
	if r.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("пустое тело: статус %d, ожидалось 422", r.StatusCode)
	}
	if got := show(); got != next {
		t.Fatalf("после отказа показан %q — действующий секрет подменён", got)
	}
}

// Запись журнала висит ровно на одной цели — связке Таблиц либо вебхуке.
// Ни на одной или на обеих — отказ схемы (CHECK integration_deliveries_target).
func TestWebhooks_JournalHasExactlyOneTarget(t *testing.T) {
	resetDB(t)
	srv := newStack(t, &fakeProvider{})
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-journal")
	hook := mustCreateWebhook(t, owner, srv, formID)

	insert := func(webhookID any) error {
		_, err := testPool.Exec(context.Background(),
			`INSERT INTO integration_deliveries (id, webhook_id, kind, submission_id, outcome)
			 VALUES (gen_random_uuid(), $1, 'submission', gen_random_uuid(), 'failed')`, webhookID)
		return err
	}
	if err := insert(hook.ID); err != nil {
		t.Fatalf("запись журнала вебхука отвергнута: %v", err)
	}
	if err := insert(nil); err == nil || !strings.Contains(err.Error(), "integration_deliveries_target") {
		t.Fatalf("запись без цели: %v, ожидался отказ CHECK", err)
	}
}
