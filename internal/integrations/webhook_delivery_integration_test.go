//go:build integration

// Доставка в вебхук против настоящего Postgres и настоящего получателя (httptest
// на TLS): подпись, журнал с кодом ответа, очередь и починка кнопкой.
//
// Guard здесь пермиссивный (получатель живёт на 127.0.0.1) — ровно так же, как
// лимитеры в тестах подменяются ratelimit.AllowAll (инвариант 6). Боевой Guard
// проверяется своими тестами в internal/safehttp и отказами сохранения адреса.
package integrations_test

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/safehttp"
)

// receiver — чужая система: запоминает запросы и отвечает тем, что задал тест.
type receiver struct {
	mu     sync.Mutex
	code   int
	bodies [][]byte
	sigs   []string
}

func (r *receiver) handle(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	r.mu.Lock()
	r.bodies = append(r.bodies, body)
	r.sigs = append(r.sigs, req.Header.Get(domain.WebhookSignatureHeader))
	code := r.code
	r.mu.Unlock()
	w.WriteHeader(code)
}

func (r *receiver) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.bodies)
}

func (r *receiver) last() ([]byte, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.bodies) == 0 {
		return nil, ""
	}
	return r.bodies[len(r.bodies)-1], r.sigs[len(r.sigs)-1]
}

func (r *receiver) setCode(code int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.code = code
}

// newReceiver поднимает получателя и отдаёт клиент, который ему доверяет.
func newReceiver(t *testing.T, code int) (*receiver, *httptest.Server, integrations.Egress) {
	t.Helper()
	rec := &receiver{code: code}
	srv := httptest.NewTLSServer(http.HandlerFunc(rec.handle))
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return rec, srv, safehttp.New(safehttp.AllowAll{}, safehttp.Options{RootCAs: pool})
}

// hookSecret — секрет подписи, какой его вводит автор: своего продукт не
// генерирует (ADR §10, четвёртый круг).
const hookSecret = "секрет-проверки-подписи"

// enableSignature включает подпись запросов секретом автора: по умолчанию
// подписи нет (ADR §10), а проверкам подписи нужен подписанный запрос.
func enableSignature(t *testing.T, c *http.Client, srv *httptest.Server, formID, webhookID string) string {
	t.Helper()
	r := postBodyWithCSRF(t, c, srv, "/api/v1/forms/"+formID+"/webhooks/"+webhookID+"/secret",
		`{"secret":"`+hookSecret+`"}`)
	closeBody(t, r)
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("включение подписи: статус %d", r.StatusCode)
	}
	return hookSecret
}

// enqueueWebhook ставит ответ в очередь цели напрямую: путь «приём ответа →
// очередь» проверяется в internal/submissions (он живёт в SQL приёма).
func enqueueWebhook(t *testing.T, webhookID, submissionID string) {
	t.Helper()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO webhook_queue (webhook_id, submission_id) VALUES ($1, $2)`, webhookID, submissionID)
	if err != nil {
		t.Fatalf("постановка в очередь: %v", err)
	}
}

func queueSize(t *testing.T, webhookID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM webhook_queue WHERE webhook_id = $1`, webhookID).Scan(&n); err != nil {
		t.Fatalf("count queue: %v", err)
	}
	return n
}

// Полный путь: ответ из очереди уезжает получателю телом контракта v1 с
// подписью, снимается с очереди и оставляет в журнале строку с кодом ответа.
func TestWebhookDelivery_EndToEnd(t *testing.T) {
	resetDB(t)
	rec, recSrv, egress := newReceiver(t, http.StatusOK)
	srv := newStackWithEgress(t, &fakeProvider{}, egress)
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-deliver")
	versionID := publishVersion(t, formID)

	r := createWebhook(t, owner, srv, formID, `{"name":"CRM","url":"`+recSrv.URL+`/hook"}`)
	if r.StatusCode != http.StatusCreated {
		closeBody(t, r)
		t.Fatalf("заведение: статус %d", r.StatusCode)
	}
	var hook webhookDTO
	decode(t, r, &hook)
	hook.Secret = enableSignature(t, owner, srv, formID, hook.ID)

	subID := newSubmission(t, formID, versionID, `{"b1":"Кирилл"}`)
	enqueueWebhook(t, hook.ID, subID)

	n, err := testIntegrations.DeliverWebhooks(context.Background())
	if err != nil {
		t.Fatalf("проход доставщика: %v", err)
	}
	if n != 1 || rec.count() != 1 {
		t.Fatalf("уехало %d ответов при %d запросах", n, rec.count())
	}

	body, sig := rec.last()
	var p domain.WebhookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("тело не разбирается: %v", err)
	}
	if p.Version != 1 || p.Submission.ID != subID || p.Form.ID != formID {
		t.Fatalf("тело = %+v", p)
	}
	if len(p.Submission.Fields) == 0 || p.Submission.Fields[0].Value != "Кирилл" {
		t.Fatalf("поля тела = %+v", p.Submission.Fields)
	}
	// Подпись сверяется так же, как её проверит получатель: по секрету и телу.
	ts, _, _ := strings.Cut(strings.TrimPrefix(sig, "t="), ",")
	if sig == "" || ts == "" {
		t.Fatalf("подпись = %q", sig)
	}
	if got := signatureOf(t, hook.Secret, ts, body); got != sig {
		t.Fatalf("подпись %q не сходится с посчитанной %q", sig, got)
	}

	if queueSize(t, hook.ID) != 0 {
		t.Fatal("строка очереди осталась после успеха")
	}
	page := webhookDeliveries(t, owner, srv, formID, hook.ID)
	if len(page.Deliveries) != 1 || page.Deliveries[0].Outcome != "delivered" || page.Deliveries[0].HTTPStatus != 200 {
		t.Fatalf("журнал = %+v", page.Deliveries)
	}
	if got := webhooksOf(t, owner, srv, formID)[0]; got.Status != "live" || got.Queued != 0 {
		t.Fatalf("состояние вебхука = %+v", got)
	}
}

// Получатель отвечает 500: ответ остаётся в очереди, цель засыпает, журнал
// показывает попытку с кодом. Починили — тот же ответ доезжает.
func TestWebhookDelivery_FailureThenRecovery(t *testing.T) {
	resetDB(t)
	rec, recSrv, egress := newReceiver(t, http.StatusInternalServerError)
	srv := newStackWithEgress(t, &fakeProvider{}, egress)
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-retry")
	versionID := publishVersion(t, formID)

	r := createWebhook(t, owner, srv, formID, `{"url":"`+recSrv.URL+`/hook"}`)
	var hook webhookDTO
	decode(t, r, &hook)
	subID := newSubmission(t, formID, versionID, `{"b1":"Кирилл"}`)
	enqueueWebhook(t, hook.ID, subID)

	if _, err := testIntegrations.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	if queueSize(t, hook.ID) != 1 {
		t.Fatal("ответ снят с очереди при неудаче")
	}
	page := webhookDeliveries(t, owner, srv, formID, hook.ID)
	if len(page.Deliveries) != 1 || page.Deliveries[0].Outcome != "failed" || page.Deliveries[0].HTTPStatus != 500 {
		t.Fatalf("журнал = %+v", page.Deliveries)
	}
	if !strings.ContainsAny(page.Deliveries[0].Detail, "абвгдеёжзийклмнопрстуфхцчшщъыьэюя") {
		t.Fatalf("причина %q — ожидался русский текст", page.Deliveries[0].Detail)
	}

	// Цель спит: следующий проход в ту же минуту к получателю не идёт.
	calls := rec.count()
	if _, err := testIntegrations.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("второй проход: %v", err)
	}
	if rec.count() != calls {
		t.Fatal("спящую цель тронули раньше срока")
	}

	// Починили получателя и разбудили цель, как это делает кнопка «Проверить».
	rec.setCode(http.StatusOK)
	res := testWebhook(t, owner, srv, formID, hook.ID)
	if !res.OK {
		t.Fatalf("проверка = %+v", res)
	}
	if _, err := testIntegrations.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход после починки: %v", err)
	}
	if queueSize(t, hook.ID) != 0 {
		t.Fatal("после починки очередь не уехала")
	}
}

// Кнопка «Проверить» шлёт ОБРАЗЕЦ с пометкой test и вопросами формы: настоящий
// ответ для этого не берётся.
func TestWebhookDelivery_TestSendsSample(t *testing.T) {
	resetDB(t)
	rec, recSrv, egress := newReceiver(t, http.StatusOK)
	srv := newStackWithEgress(t, &fakeProvider{}, egress)
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-test")
	publishVersion(t, formID)

	r := createWebhook(t, owner, srv, formID, `{"url":"`+recSrv.URL+`/hook"}`)
	var hook webhookDTO
	decode(t, r, &hook)

	res := testWebhook(t, owner, srv, formID, hook.ID)
	if !res.OK || res.StatusCode != 200 {
		t.Fatalf("исход проверки = %+v", res)
	}
	body, _ := rec.last()
	var p domain.WebhookPayload
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatalf("образец не разбирается: %v", err)
	}
	if !p.Test || len(p.Submission.Fields) == 0 || p.Submission.Fields[0].Value == "" {
		t.Fatalf("образец = %+v", p)
	}
	// Образец в журнал не пишется: это не судьба ответа.
	if page := webhookDeliveries(t, owner, srv, formID, hook.ID); len(page.Deliveries) != 0 {
		t.Fatalf("журнал = %+v, ожидался пустым", page.Deliveries)
	}
}

// Повтор из журнала ставит ответ в очередь заново, а доставленный — отказывает.
func TestWebhookDelivery_RetryFromJournal(t *testing.T) {
	resetDB(t)
	rec, recSrv, egress := newReceiver(t, http.StatusBadGateway)
	srv := newStackWithEgress(t, &fakeProvider{}, egress)
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-journal-retry")
	versionID := publishVersion(t, formID)

	r := createWebhook(t, owner, srv, formID, `{"url":"`+recSrv.URL+`/hook"}`)
	var hook webhookDTO
	decode(t, r, &hook)
	subID := newSubmission(t, formID, versionID, `{"b1":"Кирилл"}`)
	enqueueWebhook(t, hook.ID, subID)
	if _, err := testIntegrations.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	entry := webhookDeliveries(t, owner, srv, formID, hook.ID).Deliveries[0]

	base := "/api/v1/forms/" + formID + "/webhooks/" + hook.ID + "/deliveries/" + entry.ID + "/retry"
	resp := postWithCSRF(t, owner, srv, base)
	closeBody(t, resp)
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("повтор: статус %d, ожидалось 202", resp.StatusCode)
	}

	rec.setCode(http.StatusOK)
	// Цель спит после неудачи — будим её проверкой, как это сделает человек.
	if res := testWebhook(t, owner, srv, formID, hook.ID); !res.OK {
		t.Fatalf("проверка = %+v", res)
	}
	if _, err := testIntegrations.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход после починки: %v", err)
	}
	if queueSize(t, hook.ID) != 0 {
		t.Fatal("очередь не уехала")
	}
	resp = postWithCSRF(t, owner, srv, base)
	closeBody(t, resp)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("повтор доставленного: статус %d, ожидалось 422", resp.StatusCode)
	}
}

// Журнал вебхука и его повтор закрыты от постороннего так же, как лента связки.
func TestWebhookDelivery_JournalHiddenFromStranger(t *testing.T) {
	resetDB(t)
	_, recSrv, egress := newReceiver(t, http.StatusOK)
	srv := newStackWithEgress(t, &fakeProvider{}, egress)
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-journal-private")
	r := createWebhook(t, owner, srv, formID, `{"url":"`+recSrv.URL+`/hook"}`)
	var hook webhookDTO
	decode(t, r, &hook)
	stranger := registerUser(t, srv, "stranger@example.com")

	resp := do(t, stranger, http.MethodGet,
		srv.URL+"/api/v1/forms/"+formID+"/webhooks/"+hook.ID+"/deliveries")
	closeBody(t, resp)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("журнал посторонним: статус %d, ожидалось 404", resp.StatusCode)
	}
	resp = postWithCSRF(t, stranger, srv, "/api/v1/forms/"+formID+"/webhooks/"+hook.ID+"/test")
	closeBody(t, resp)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("проверка посторонним: статус %d, ожидалось 404", resp.StatusCode)
	}
}

// --- помощники ---

type webhookTestDTO struct {
	OK         bool   `json:"ok"`
	StatusCode int    `json:"statusCode"`
	Reason     string `json:"reason"`
}

func testWebhook(t *testing.T, c *http.Client, srv *httptest.Server, formID, webhookID string) webhookTestDTO {
	t.Helper()
	r := postWithCSRF(t, c, srv, "/api/v1/forms/"+formID+"/webhooks/"+webhookID+"/test")
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("проверка: статус %d, ожидалось 200", r.StatusCode)
	}
	var got webhookTestDTO
	decode(t, r, &got)
	return got
}

func webhookDeliveries(t *testing.T, c *http.Client, srv *httptest.Server, formID, webhookID string) deliveryPage {
	t.Helper()
	r := do(t, c, http.MethodGet, srv.URL+"/api/v1/forms/"+formID+"/webhooks/"+webhookID+"/deliveries")
	if r.StatusCode != http.StatusOK {
		closeBody(t, r)
		t.Fatalf("журнал: статус %d, ожидалось 200", r.StatusCode)
	}
	var page deliveryPage
	decode(t, r, &page)
	return page
}

// signatureOf считает подпись так, как её проверит получатель.
func signatureOf(t *testing.T, secret, ts string, body []byte) string {
	t.Helper()
	at, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		t.Fatalf("время подписи %q: %v", ts, err)
	}
	return domain.SignWebhook(secret, time.Unix(at, 0), body)
}

// Секрет автора: задан своим, лёг шифротекстом и подписывает настоящую доставку.
// Проверяется на живой доставке, а не на ручке: секрет ценен ровно тем, что им
// подписан уехавший запрос.
func TestWebhookDelivery_AuthorSuppliedSecret(t *testing.T) {
	resetDB(t)
	rec, recSrv, egress := newReceiver(t, http.StatusOK)
	srv := newStackWithEgress(t, &fakeProvider{}, egress)
	owner := registerUser(t, srv, "owner@example.com")
	formID := newForm(t, personalWorkspace(t), "f-own-secret")
	versionID := publishVersion(t, formID)

	r := createWebhook(t, owner, srv, formID, `{"url":"`+recSrv.URL+`/hook"}`)
	var hook webhookDTO
	decode(t, r, &hook)

	const mine = "общий-секрет-на-все-формы"
	resp := postBodyWithCSRF(t, owner, srv,
		"/api/v1/forms/"+formID+"/webhooks/"+hook.ID+"/secret", `{"secret":"`+mine+`"}`)
	closeBody(t, resp)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("свой секрет: статус %d, ожидалось 204", resp.StatusCode)
	}
	var sealed []byte
	if err := testPool.QueryRow(context.Background(),
		`SELECT secret FROM form_webhooks WHERE id = $1`, hook.ID).Scan(&sealed); err != nil {
		t.Fatalf("строка вебхука: %v", err)
	}
	if strings.Contains(string(sealed), mine) {
		t.Fatal("секрет автора лёг в базу открытым текстом")
	}

	subID := newSubmission(t, formID, versionID, `{"b1":"Кирилл"}`)
	enqueueWebhook(t, hook.ID, subID)
	if _, err := testIntegrations.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход доставщика: %v", err)
	}
	payload, sig := rec.last()
	ts, _, _ := strings.Cut(strings.TrimPrefix(sig, "t="), ",")
	if got := signatureOf(t, mine, ts, payload); got != sig {
		t.Fatalf("запрос подписан не секретом автора: %q против %q", sig, got)
	}

	// Слишком короткий отвергается человеческим текстом, действующий остаётся.
	resp = postBodyWithCSRF(t, owner, srv,
		"/api/v1/forms/"+formID+"/webhooks/"+hook.ID+"/secret", `{"secret":"123456"}`)
	closeBody(t, resp)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("короткий секрет: статус %d, ожидалось 422", resp.StatusCode)
	}
}
