package integrations_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/safehttp"
	"github.com/ka-shmd/trillix/internal/submissions"
)

// --- очередь и журнал фейка (доставка) ---

func (f *fakeWebhookStore) DueWebhooks(_ context.Context, _ postgres.DBTX, limit int32) ([]integrations.Webhook, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	var out []integrations.Webhook
	for _, w := range f.hooks {
		if !w.Enabled || w.Status != integrations.StatusLive || w.NextAttemptAt.After(now) {
			continue
		}
		queued := false
		for _, q := range f.queue {
			if q.webhookID == w.ID {
				queued = true
				break
			}
		}
		if !queued {
			continue
		}
		out = append(out, w)
		if int32(len(out)) == limit {
			break
		}
	}
	return out, nil
}

func (f *fakeWebhookStore) PendingSubmissions(_ context.Context, _ postgres.DBTX, webhookID uuid.UUID, limit int32) ([]uuid.UUID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []uuid.UUID
	for _, q := range f.queue {
		if q.webhookID != webhookID {
			continue
		}
		out = append(out, q.submissionID)
		if int32(len(out)) == limit {
			break
		}
	}
	return out, nil
}

func (f *fakeWebhookStore) Dequeue(_ context.Context, _ postgres.DBTX, webhookID, submissionID uuid.UUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, q := range f.queue {
		if q.webhookID == webhookID && q.submissionID == submissionID {
			f.queue = append(f.queue[:i], f.queue[i+1:]...)
			return nil
		}
	}
	return nil
}

func (f *fakeWebhookStore) Enqueue(_ context.Context, _ postgres.DBTX, webhookID, submissionID uuid.UUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, q := range f.queue {
		if q.webhookID == webhookID && q.submissionID == submissionID {
			return nil // ключ-пара: двойная постановка безвредна
		}
	}
	f.queue = append(f.queue, queuedItem{webhookID: webhookID, submissionID: submissionID, at: f.now()})
	return nil
}

func (f *fakeWebhookStore) ExpiredQueued(_ context.Context, _ postgres.DBTX, before time.Time, limit int32) ([]integrations.QueuedRef, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []integrations.QueuedRef
	for _, q := range f.queue {
		if q.at.Before(before) {
			out = append(out, integrations.QueuedRef{WebhookID: q.webhookID, SubmissionID: q.submissionID})
			if int32(len(out)) == limit {
				break
			}
		}
	}
	return out, nil
}

func (f *fakeWebhookStore) MarkWebhookDelivered(_ context.Context, _ postgres.DBTX, id uuid.UUID) error {
	f.editAny(id, func(w *integrations.Webhook) {
		w.LastDeliveredAt = f.now()
		w.LastError, w.FailingSince, w.ConsecutiveFailures = "", time.Time{}, 0
		w.NextAttemptAt = f.now()
	})
	return nil
}

func (f *fakeWebhookStore) MarkWebhookFailed(_ context.Context, _ postgres.DBTX, id uuid.UUID, reason string, failingSince, nextAttemptAt time.Time) error {
	f.editAny(id, func(w *integrations.Webhook) {
		w.LastError = reason
		w.ConsecutiveFailures++
		if w.FailingSince.IsZero() {
			w.FailingSince = failingSince
		}
		w.NextAttemptAt = nextAttemptAt
	})
	return nil
}

func (f *fakeWebhookStore) MarkWebhookBroken(_ context.Context, _ postgres.DBTX, id uuid.UUID, reason string) error {
	f.editAny(id, func(w *integrations.Webhook) { w.Status, w.LastError = integrations.StatusBroken, reason })
	return nil
}

func (f *fakeWebhookStore) ReviveWebhook(_ context.Context, _ postgres.DBTX, id uuid.UUID) error {
	f.editAny(id, func(w *integrations.Webhook) {
		w.Status, w.LastError = integrations.StatusLive, ""
		w.FailingSince, w.ConsecutiveFailures, w.NextAttemptAt = time.Time{}, 0, f.now()
	})
	return nil
}

// editAny — правка цели без проверки формы (пути доставки форму не называют).
func (f *fakeWebhookStore) editAny(id uuid.UUID, fn func(*integrations.Webhook)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.hooks[id]
	if !ok {
		return
	}
	fn(&w)
	f.hooks[id] = w
}

func (f *fakeWebhookStore) InsertWebhookDelivery(_ context.Context, _ postgres.DBTX, d integrations.Delivery) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.journal = append(f.journal, d)
	return nil
}

func (f *fakeWebhookStore) ListWebhookDeliveries(_ context.Context, _ postgres.DBTX, webhookID, _ uuid.UUID, _ int32) ([]integrations.Delivery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []integrations.Delivery
	for i := len(f.journal) - 1; i >= 0; i-- {
		if f.journal[i].WebhookID == webhookID {
			out = append(out, f.journal[i])
		}
	}
	return out, nil
}

func (f *fakeWebhookStore) GetWebhookDelivery(_ context.Context, _ postgres.DBTX, id, webhookID uuid.UUID) (integrations.Delivery, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.journal {
		if d.ID == id && d.WebhookID == webhookID {
			return d, nil
		}
	}
	return integrations.Delivery{}, pgx.ErrNoRows
}

func (f *fakeWebhookStore) WebhookSubmissionDelivered(_ context.Context, _ postgres.DBTX, webhookID, submissionID uuid.UUID) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.journal {
		if d.WebhookID == webhookID && d.SubmissionID == submissionID && d.Outcome == integrations.OutcomeDelivered {
			return true, nil
		}
	}
	return false, nil
}

// --- подменённый исходящий клиент ---

// sender — получатель без сети: отвечает тем, что задал тест, и запоминает
// каждый запрос.
type sender struct {
	mu     sync.Mutex
	code   int
	err    error
	bodies [][]byte
	sigs   []string
	calls  int
}

func (s *sender) Validate(_ context.Context, raw string) (*url.URL, error) { return url.Parse(raw) }

func (s *sender) Post(_ context.Context, _ string, header http.Header, body []byte) (safehttp.Response, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	s.bodies = append(s.bodies, body)
	s.sigs = append(s.sigs, header.Get(domain.WebhookSignatureHeader))
	if s.err != nil {
		return safehttp.Response{}, s.err
	}
	return safehttp.Response{StatusCode: s.code, Duration: time.Millisecond}, nil
}

func (s *sender) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// --- оснастка ---

// formOfTest — форма, которую видит сервис доставки в тестах.
func formOfTest() forms.Form {
	return forms.Form{ID: testForm, WorkspaceID: testWS, Title: "Заявка на курс"}
}

// deliveryHarness — сервис доставки с подменёнными хранилищем, получателем,
// ответами и часами.
type deliveryHarness struct {
	svc   *integrations.Service
	store *fakeWebhookStore
	out   *sender
	subs  *fakeSubmissions
	// outbox — очередь ПИСЕМ. Вебхуки её не касаются вовсе, и это проверяется:
	// ради того разрез и делался (ADR §10).
	outbox *fakeOutbox
	now    time.Time
}

func newDeliveryHarness(t *testing.T, code int) *deliveryHarness {
	t.Helper()
	h := &deliveryHarness{
		store: newFakeWebhookStore(),
		out:   &sender{code: code},
		subs: &fakeSubmissions{webhook: submissions.WebhookRecord{
			FormTitle:   "Заявка на курс",
			FormVersion: 3,
			CreatedAt:   time.Date(2026, 9, 12, 10, 15, 0, 0, time.UTC),
			Fields: []domain.WebhookField{
				{Key: "b1", Label: "Имя", Type: "short_text", Value: "Кирилл"},
			},
		}},
		outbox: &fakeOutbox{},
		now:    time.Date(2026, 9, 12, 12, 0, 0, 0, time.UTC),
	}
	h.store.now = h.clock
	h.svc = integrations.NewService(nil, directTx{}, &fakeStore{}, fakeAccess{},
		fakeForms{form: formOfTest()}, nil, testKey).
		WithWebhooks(h.store, h.out, h.clock).
		WithDelivery(h.outbox, h.subs)
	return h
}

func (h *deliveryHarness) clock() time.Time { return h.now }

// hook заводит цель с очередью из n ответов и ВКЛЮЧЁННОЙ подписью: по умолчанию
// её нет (ADR §10), а проверкам доставки нужен подписанный запрос. Случай без
// подписи — свой тест ниже.
func (h *deliveryHarness) hook(t *testing.T, n int) (integrations.Webhook, []uuid.UUID) {
	t.Helper()
	w, err := h.svc.CreateWebhook(context.Background(), testUser, testForm,
		integrations.WebhookInput{Name: "CRM", URL: testHookURL})
	if err != nil {
		t.Fatalf("создание вебхука: %v", err)
	}
	if err := h.svc.SetWebhookSecret(context.Background(), testUser, testForm, w.ID, testSecret); err != nil {
		t.Fatalf("включение подписи: %v", err)
	}
	ids := make([]uuid.UUID, n)
	for i := range ids {
		ids[i] = domain.NewID()
		if err := h.store.Enqueue(context.Background(), nil, w.ID, ids[i]); err != nil {
			t.Fatalf("постановка: %v", err)
		}
	}
	return w, ids
}

func (h *deliveryHarness) target(t *testing.T, id uuid.UUID) integrations.Webhook {
	t.Helper()
	h.store.mu.Lock()
	defer h.store.mu.Unlock()
	return h.store.hooks[id]
}

func (h *deliveryHarness) queueLen(webhookID uuid.UUID) int {
	h.store.mu.Lock()
	defer h.store.mu.Unlock()
	n := 0
	for _, q := range h.store.queue {
		if q.webhookID == webhookID {
			n++
		}
	}
	return n
}

func (h *deliveryHarness) journal() []integrations.Delivery {
	h.store.mu.Lock()
	defer h.store.mu.Unlock()
	return append([]integrations.Delivery(nil), h.store.journal...)
}

// Ответы одной цели уезжают за один проход, по порядку постановки, и снимаются
// с очереди; тело — контракт v1 с подписью.
func TestDeliverWebhooks_SendsInOrder(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	w, ids := h.hook(t, 3)

	n, err := h.svc.DeliverWebhooks(context.Background())
	if err != nil {
		t.Fatalf("проход: %v", err)
	}
	if n != 3 || h.out.count() != 3 {
		t.Fatalf("уехало %d ответов при %d запросах, ожидалось три", n, h.out.count())
	}
	if h.queueLen(w.ID) != 0 {
		t.Fatalf("в очереди осталось %d", h.queueLen(w.ID))
	}

	var got []string
	for _, body := range h.out.bodies {
		var p domain.WebhookPayload
		if err := json.Unmarshal(body, &p); err != nil {
			t.Fatalf("тело не разбирается: %v", err)
		}
		got = append(got, p.Submission.ID)
		if p.Version != 1 || p.Event != domain.WebhookEventSubmission || p.Test {
			t.Fatalf("шапка тела = %+v", p)
		}
		if p.Form.Title != "Заявка на курс" || len(p.Submission.Fields) != 1 ||
			p.Submission.Fields[0].Value != "Кирилл" || p.Submission.FormVersion != 3 {
			t.Fatalf("тело = %+v", p)
		}
	}
	want := []string{ids[0].String(), ids[1].String(), ids[2].String()}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("порядок отправки %v, ожидался %v", got, want)
	}

	// Подпись считается по тому телу, которое уехало.
	secret, err := h.svc.WebhookSecret(context.Background(), testUser, testForm, w.ID)
	if err != nil {
		t.Fatalf("секрет: %v", err)
	}
	if want := domain.SignWebhook(secret, h.now, h.out.bodies[0]); h.out.sigs[0] != want {
		t.Fatalf("подпись %q, ожидалась %q", h.out.sigs[0], want)
	}
	if got := h.target(t, w.ID); got.LastDeliveredAt.IsZero() || got.LastError != "" {
		t.Fatalf("цель после успеха = %+v", got)
	}
	// Очередь писем не тронута ни разу: у вебхуков своя, и мёртвый получатель не
	// имеет права задерживать письмо со сбросом пароля.
	if h.outbox.channel != "" {
		t.Fatalf("доставка вебхука положила строку в outbox (канал %q)", h.outbox.channel)
	}
}

// Мёртвый адрес получает ОДНУ попытку за окно бэкоффа, сколько бы ответов ни
// ждало: неудача усыпляет цель, а не строку очереди.
func TestDeliverWebhooks_DeadTargetTriedOncePerWindow(t *testing.T) {
	h := newDeliveryHarness(t, 0)
	h.out.err = errors.New("dial tcp: i/o timeout")
	w, _ := h.hook(t, 50)

	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	if h.out.count() != 1 {
		t.Fatalf("запросов %d, ожидался один на весь проход", h.out.count())
	}
	if h.queueLen(w.ID) != 50 {
		t.Fatalf("в очереди %d, ожидались все 50 — ни один ответ не потерян", h.queueLen(w.ID))
	}
	got := h.target(t, w.ID)
	if got.ConsecutiveFailures != 1 || got.FailingSince.IsZero() {
		t.Fatalf("цель = %+v, ожидалась одна неудача с отметкой начала", got)
	}
	if !got.NextAttemptAt.Equal(h.now.Add(time.Minute)) {
		t.Fatalf("следующая попытка %s, ожидалась через минуту", got.NextAttemptAt)
	}

	// Следующий проход в ту же секунду цель не берёт вовсе.
	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("второй проход: %v", err)
	}
	if h.out.count() != 1 {
		t.Fatalf("запросов %d — спящую цель тронули раньше срока", h.out.count())
	}

	// Окно вышло — ровно одна новая попытка, и пауза удвоилась.
	h.now = h.now.Add(time.Minute)
	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("третий проход: %v", err)
	}
	if h.out.count() != 2 {
		t.Fatalf("запросов %d, ожидалось два", h.out.count())
	}
	if got := h.target(t, w.ID); !got.NextAttemptAt.Equal(h.now.Add(2 * time.Minute)) {
		t.Fatalf("следующая попытка %s, ожидалось удвоение паузы", got.NextAttemptAt)
	}
}

// Сутки подряд без успеха — цель сломана: доставщик в неё больше не ходит, а
// ответы копятся до починки.
func TestDeliverWebhooks_BrokenAfterADayOfFailures(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusInternalServerError)
	w, _ := h.hook(t, 2)

	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	if got := h.target(t, w.ID); got.Status != integrations.StatusLive {
		t.Fatalf("после первой неудачи статус %q — сутки ещё не прошли", got.Status)
	}

	h.now = h.now.Add(integrations.WebhookBrokenAfter + time.Minute)
	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход через сутки: %v", err)
	}
	got := h.target(t, w.ID)
	if got.Status != integrations.StatusBroken || !strings.Contains(got.LastError, "суток") {
		t.Fatalf("цель = %+v, ожидалась поломка с причиной", got)
	}
	if h.queueLen(w.ID) != 2 {
		t.Fatalf("в очереди %d, ожидались оба ответа: починка увезёт их", h.queueLen(w.ID))
	}

	before := h.out.count()
	h.now = h.now.Add(time.Hour)
	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход после поломки: %v", err)
	}
	if h.out.count() != before {
		t.Fatal("в сломанную цель ушёл запрос")
	}
}

// Ответ 410 ломает цель сразу: получатель сказал, что адреса больше нет.
func TestDeliverWebhooks_GoneBreaksImmediately(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusGone)
	w, _ := h.hook(t, 1)

	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	got := h.target(t, w.ID)
	if got.Status != integrations.StatusBroken || !strings.Contains(got.LastError, "410") {
		t.Fatalf("цель = %+v, ожидалась поломка по 410", got)
	}
	last := h.journal()[len(h.journal())-1]
	if last.Outcome != integrations.OutcomeFailed || last.HTTPStatus != http.StatusGone {
		t.Fatalf("запись журнала = %+v", last)
	}
}

// Адрес, который стал вести во внутреннюю сеть (сменился DNS), ломает цель
// сразу: ждать тут нечего.
func TestDeliverWebhooks_ForbiddenAddressBreaks(t *testing.T) {
	h := newDeliveryHarness(t, 0)
	h.out.err = safehttp.ErrForbiddenAddress
	w, _ := h.hook(t, 1)

	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	got := h.target(t, w.ID)
	if got.Status != integrations.StatusBroken || !strings.Contains(got.LastError, "внутреннюю сеть") {
		t.Fatalf("цель = %+v", got)
	}
}

// Удалённый (или скрытый тарифом) ответ снимается с очереди со следом в журнале,
// и доставка идёт дальше — цель из-за него не встаёт.
func TestDeliverWebhooks_DeletedSubmissionSkipped(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	h.subs.webhookErr = pgx.ErrNoRows
	w, _ := h.hook(t, 2)

	n, err := h.svc.DeliverWebhooks(context.Background())
	if err != nil {
		t.Fatalf("проход: %v", err)
	}
	if n != 0 || h.out.count() != 0 {
		t.Fatalf("уехало %d при %d запросах — везти было нечего", n, h.out.count())
	}
	if h.queueLen(w.ID) != 0 {
		t.Fatalf("в очереди осталось %d", h.queueLen(w.ID))
	}
	if got := h.journal(); len(got) != 2 || got[0].Outcome != integrations.OutcomeSkipped {
		t.Fatalf("журнал = %+v, ожидались две записи «не повезли»", got)
	}
	if got := h.target(t, w.ID); got.Status != integrations.StatusLive || got.ConsecutiveFailures != 0 {
		t.Fatalf("цель = %+v — удалённый ответ не её вина", got)
	}
}

// Сторож членства: того, кто задал адрес, сняли с пространства — цель встаёт с
// человеческой причиной, ответы остаются в очереди.
func TestDeliverWebhooks_MemberLeftBreaksTarget(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	w, _ := h.hook(t, 1)
	h.svc = integrations.NewService(nil, directTx{}, &fakeStore{}, fakeAccess{gone: true},
		fakeForms{form: formOfTest()}, nil, testKey).
		WithWebhooks(h.store, h.out, h.clock).
		WithDelivery(&fakeOutbox{}, h.subs)

	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	if h.out.count() != 0 {
		t.Fatal("ответ ушёл по адресу, за который больше некому отвечать")
	}
	got := h.target(t, w.ID)
	if got.Status != integrations.StatusBroken || !strings.Contains(got.LastError, "доступа к пространству") {
		t.Fatalf("цель = %+v", got)
	}
	if h.queueLen(w.ID) != 1 {
		t.Fatal("ответ снят с очереди — пересохранение адреса его уже не увезёт")
	}
}

// Починка увозит накопленное: проверка вернула цель в работу, и очередь уходит
// по порядку тем же проходом.
func TestTestWebhook_RevivesAndQueueDrains(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusGone)
	w, _ := h.hook(t, 2)
	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	if got := h.target(t, w.ID); got.Status != integrations.StatusBroken {
		t.Fatalf("цель не сломалась: %+v", got)
	}

	h.out.code = http.StatusOK
	res, err := h.svc.TestWebhook(context.Background(), testUser, testForm, w.ID)
	if err != nil {
		t.Fatalf("проверка: %v", err)
	}
	if !res.OK || res.StatusCode != http.StatusOK {
		t.Fatalf("исход проверки = %+v", res)
	}
	// Образец: пометка test и вопросы формы с примерными значениями.
	var sample domain.WebhookPayload
	if err := json.Unmarshal(h.out.bodies[len(h.out.bodies)-1], &sample); err != nil {
		t.Fatalf("образец не разбирается: %v", err)
	}
	if !sample.Test {
		t.Fatal("образец не помечен test")
	}
	if got := h.target(t, w.ID); got.Status != integrations.StatusLive {
		t.Fatalf("после удачной проверки цель = %+v", got)
	}

	n, err := h.svc.DeliverWebhooks(context.Background())
	if err != nil {
		t.Fatalf("проход после починки: %v", err)
	}
	if n != 2 || h.queueLen(w.ID) != 0 {
		t.Fatalf("после починки уехало %d, в очереди %d", n, h.queueLen(w.ID))
	}
}

// Неуспех проверки — ответ, а не сбой: русская причина и код, статус цели при
// этом не меняется.
func TestTestWebhook_FailureIsAnAnswer(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusInternalServerError)
	w, _ := h.hook(t, 0)

	res, err := h.svc.TestWebhook(context.Background(), testUser, testForm, w.ID)
	if err != nil {
		t.Fatalf("проверка: %v", err)
	}
	if res.OK || res.StatusCode != 500 || !strings.Contains(res.Reason, "кодом 500") {
		t.Fatalf("исход = %+v", res)
	}
	if got := h.target(t, w.ID); got.Status != integrations.StatusLive {
		t.Fatalf("неудачная проверка сломала цель: %+v", got)
	}
}

// Повтор из журнала ставит ответ в очередь заново; на сломанной цели отказывает,
// а уже доставленный ответ вторым разом не отправляет.
func TestRetryWebhookDelivery(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusInternalServerError)
	w, ids := h.hook(t, 1)
	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	entry := h.journal()[0]

	// Ответ так и не доехал — повтор ставит его заново (он и так в очереди).
	if err := h.svc.RetryWebhookDelivery(context.Background(), testUser, testForm, w.ID, entry.ID); err != nil {
		t.Fatalf("повтор: %v", err)
	}
	if h.queueLen(w.ID) != 1 {
		t.Fatalf("в очереди %d, ожидался один", h.queueLen(w.ID))
	}

	// Доставился — повтор отказывает: у получателя он уже есть.
	h.out.code = http.StatusOK
	h.now = h.now.Add(time.Hour)
	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход после починки: %v", err)
	}
	err := h.svc.RetryWebhookDelivery(context.Background(), testUser, testForm, w.ID, entry.ID)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("повтор доставленного = %v, ожидался отказ", err)
	}
	if len(ids) != 1 {
		t.Fatalf("ответов в очереди было %d", len(ids))
	}

	// Сломанная цель: сначала лечение. Берётся ДРУГОЙ ответ — у доехавшего
	// повтор отказал бы раньше и по другой причине.
	h.out.code = http.StatusInternalServerError
	other := domain.NewID()
	if err := h.store.Enqueue(context.Background(), nil, w.ID, other); err != nil {
		t.Fatalf("постановка: %v", err)
	}
	h.now = h.now.Add(time.Hour)
	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	var failed integrations.Delivery
	for _, d := range h.journal() {
		if d.SubmissionID == other {
			failed = d
		}
	}
	if failed.ID == uuid.Nil {
		t.Fatal("неудачной попытки по второму ответу в журнале нет")
	}
	h.store.editAny(w.ID, func(x *integrations.Webhook) { x.Status = integrations.StatusBroken })
	if err := h.svc.RetryWebhookDelivery(context.Background(), testUser, testForm, w.ID, failed.ID); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("повтор на сломанной = %v, ожидался конфликт", err)
	}
}

// Ответ, прождавший дольше срока хранения, снимается с очереди и оставляет след
// в журнале: «не доставлен» — это исход, а не отсутствие записи.
func TestCleanupWebhookQueue(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	w, _ := h.hook(t, 1)

	h.now = h.now.Add(integrations.WebhookQueueTTL + time.Hour)
	n, err := h.svc.CleanupWebhookQueue(context.Background())
	if err != nil {
		t.Fatalf("уборка: %v", err)
	}
	if n != 1 || h.queueLen(w.ID) != 0 {
		t.Fatalf("убрано %d, в очереди %d", n, h.queueLen(w.ID))
	}
	last := h.journal()[len(h.journal())-1]
	if last.Outcome != integrations.OutcomeFailed || !strings.Contains(last.Detail, "30 дней") {
		t.Fatalf("запись журнала = %+v", last)
	}
}

// Вебхук без подписи (умолчание продукта): запрос уходит, заголовка подписи в
// нём нет вовсе — ни пустого, ни с чужим секретом.
func TestDeliverWebhooks_UnsignedByDefault(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	w, err := h.svc.CreateWebhook(context.Background(), testUser, testForm,
		integrations.WebhookInput{URL: testHookURL})
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	if err := h.store.Enqueue(context.Background(), nil, w.ID, domain.NewID()); err != nil {
		t.Fatalf("постановка: %v", err)
	}

	n, err := h.svc.DeliverWebhooks(context.Background())
	if err != nil {
		t.Fatalf("проход: %v", err)
	}
	if n != 1 || h.out.count() != 1 {
		t.Fatalf("уехало %d при %d запросах", n, h.out.count())
	}
	if h.out.sigs[0] != "" {
		t.Fatalf("заголовок подписи = %q, ожидалось его отсутствие", h.out.sigs[0])
	}
}
