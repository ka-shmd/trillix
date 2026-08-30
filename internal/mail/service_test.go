package mail

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// --- фейки -------------------------------------------------------------------

type enqueued struct {
	channel     string
	payload     []byte
	coalesceKey string // "" — обычная постановка; иначе коалесцирующая
	nextAt      time.Time
}

type failed struct {
	id       uuid.UUID
	attempts int32
	nextAt   time.Time
	lastErr  string
}

type fakeStore struct {
	pending  []Pending
	listErr  error
	enqueued []enqueued
	sent     []uuid.UUID
	failed   []failed
}

func (f *fakeStore) Enqueue(_ context.Context, _ postgres.DBTX, _ uuid.UUID, channel string, payload []byte) error {
	f.enqueued = append(f.enqueued, enqueued{channel: channel, payload: payload})
	return nil
}

func (f *fakeStore) EnqueueCoalesced(_ context.Context, _ postgres.DBTX, _ uuid.UUID, channel, coalesceKey string, payload []byte, nextAttemptAt time.Time) error {
	f.enqueued = append(f.enqueued, enqueued{channel: channel, payload: payload, coalesceKey: coalesceKey, nextAt: nextAttemptAt})
	return nil
}

func (f *fakeStore) ListPending(_ context.Context, _ postgres.DBTX, _ int32) ([]Pending, error) {
	return f.pending, f.listErr
}

func (f *fakeStore) MarkSent(_ context.Context, _ postgres.DBTX, id uuid.UUID) error {
	f.sent = append(f.sent, id)
	return nil
}

func (f *fakeStore) MarkFailed(_ context.Context, _ postgres.DBTX, id uuid.UUID, attempts int32, nextAt time.Time, lastErr string) error {
	f.failed = append(f.failed, failed{id: id, attempts: attempts, nextAt: nextAt, lastErr: lastErr})
	return nil
}

type fakeMailer struct {
	sent []EmailMessage
	err  error
}

func (m *fakeMailer) Send(_ context.Context, msg EmailMessage) error {
	m.sent = append(m.sent, msg)
	return m.err
}

func newTestService(store Store, mailer Mailer) *Service {
	return NewService(nil, store, mailer,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		50, Backoff{Base: time.Minute, Max: time.Hour})
}

// --- бэкофф ------------------------------------------------------------------

func TestBackoffDelay(t *testing.T) {
	b := Backoff{Base: time.Minute, Max: time.Hour}
	cases := map[int32]time.Duration{
		1:   time.Minute,
		2:   2 * time.Minute,
		3:   4 * time.Minute,
		6:   32 * time.Minute,
		7:   time.Hour, // 64 мин упирается в потолок
		8:   time.Hour,
		100: time.Hour,
	}
	for attempts, want := range cases {
		if got := b.delay(attempts); got != want {
			t.Errorf("delay(%d) = %v, want %v", attempts, got, want)
		}
	}
}

// --- Dispatch ----------------------------------------------------------------

func TestDispatchSuccess(t *testing.T) {
	id := uuid.New()
	payload, _ := json.Marshal(EmailMessage{To: "user@example.com", Template: "reset"})
	store := &fakeStore{pending: []Pending{{ID: id, Channel: ChannelEmail, Payload: payload}}}
	mailer := &fakeMailer{}
	svc := newTestService(store, mailer)

	n, err := svc.Dispatch(context.Background())
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if n != 1 {
		t.Errorf("delivered = %d, want 1", n)
	}
	if len(mailer.sent) != 1 || mailer.sent[0].To != "user@example.com" {
		t.Errorf("mailer.sent = %+v, want one message to user@example.com", mailer.sent)
	}
	if len(store.sent) != 1 || store.sent[0] != id {
		t.Errorf("store.sent = %v, want [%v]", store.sent, id)
	}
	if len(store.failed) != 0 {
		t.Errorf("store.failed = %+v, want none", store.failed)
	}
}

func TestDispatchMailerFailsBacksOff(t *testing.T) {
	fixed := time.Date(2026, 7, 23, 12, 0, 0, 0, time.UTC)
	id := uuid.New()
	payload, _ := json.Marshal(EmailMessage{To: "user@example.com", Template: "reset"})
	store := &fakeStore{pending: []Pending{{ID: id, Channel: ChannelEmail, Payload: payload, Attempts: 0}}}
	mailer := &fakeMailer{err: errors.New("provider unavailable")}
	svc := newTestService(store, mailer)
	svc.now = func() time.Time { return fixed }

	n, err := svc.Dispatch(context.Background())
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if n != 0 {
		t.Errorf("delivered = %d, want 0", n)
	}
	if len(store.sent) != 0 {
		t.Errorf("store.sent = %v, want none (нельзя помечать доставленным)", store.sent)
	}
	if len(store.failed) != 1 {
		t.Fatalf("store.failed = %+v, want one", store.failed)
	}
	got := store.failed[0]
	if got.attempts != 1 {
		t.Errorf("attempts = %d, want 1", got.attempts)
	}
	if want := fixed.Add(time.Minute); !got.nextAt.Equal(want) {
		t.Errorf("nextAt = %v, want %v (now + base backoff)", got.nextAt, want)
	}
	if got.lastErr == "" {
		t.Error("lastErr пуст — причина сбоя обязана сохраниться для диагностики")
	}
}

func TestDispatchUnknownChannelDoesNotMail(t *testing.T) {
	id := uuid.New()
	store := &fakeStore{pending: []Pending{{ID: id, Channel: "webhook", Payload: []byte(`{}`)}}}
	mailer := &fakeMailer{}
	svc := newTestService(store, mailer)

	n, err := svc.Dispatch(context.Background())
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if n != 0 {
		t.Errorf("delivered = %d, want 0", n)
	}
	if len(mailer.sent) != 0 {
		t.Errorf("mailer вызван для чужого канала: %+v", mailer.sent)
	}
	if len(store.failed) != 1 {
		t.Errorf("store.failed = %+v, want one (неизвестный канал уходит на ретрай)", store.failed)
	}
}

// --- Enqueue -----------------------------------------------------------------

func TestEnqueueEmail(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(store, &fakeMailer{})
	msg := EmailMessage{To: "user@example.com", Template: "reset", Data: map[string]any{"link": "https://x/y"}}

	if err := svc.EnqueueEmail(context.Background(), nil, msg); err != nil {
		t.Fatalf("EnqueueEmail: %v", err)
	}
	if len(store.enqueued) != 1 {
		t.Fatalf("store.enqueued = %d rows, want 1", len(store.enqueued))
	}
	if store.enqueued[0].channel != ChannelEmail {
		t.Errorf("channel = %q, want %q", store.enqueued[0].channel, ChannelEmail)
	}
	var back EmailMessage
	if err := json.Unmarshal(store.enqueued[0].payload, &back); err != nil {
		t.Fatalf("payload не разбирается обратно: %v", err)
	}
	if back.To != msg.To || back.Template != msg.Template || back.Data["link"] != "https://x/y" {
		t.Errorf("payload = %+v, want %+v", back, msg)
	}
}

func TestEnqueueCoalesced(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(store, &fakeMailer{})
	msg := EmailMessage{To: "owner@example.com", Template: TemplateSubmissionNew, Data: map[string]any{"count": 1}}

	if err := svc.EnqueueCoalesced(context.Background(), nil, "submission:abc", msg, time.Hour); err != nil {
		t.Fatalf("EnqueueCoalesced: %v", err)
	}
	if len(store.enqueued) != 1 {
		t.Fatalf("store.enqueued = %d rows, want 1", len(store.enqueued))
	}
	e := store.enqueued[0]
	if e.coalesceKey != "submission:abc" {
		t.Errorf("coalesceKey = %q, want submission:abc", e.coalesceKey)
	}
	if e.nextAt.IsZero() {
		t.Error("next_attempt_at не задан — окно троттлинга не установлено")
	}
}

func TestEnqueueCoalescedRejectsEmptyKey(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(store, &fakeMailer{})
	if err := svc.EnqueueCoalesced(context.Background(), nil, "", EmailMessage{To: "o@e.com"}, time.Hour); err == nil {
		t.Error("EnqueueCoalesced без ключа обязан вернуть ошибку")
	}
	if len(store.enqueued) != 0 {
		t.Error("при пустом ключе строка не ставится")
	}
}

func TestEnqueueEmailRejectsEmptyRecipient(t *testing.T) {
	store := &fakeStore{}
	svc := newTestService(store, &fakeMailer{})
	if err := svc.EnqueueEmail(context.Background(), nil, EmailMessage{To: ""}); err == nil {
		t.Error("EnqueueEmail без получателя обязан вернуть ошибку")
	}
	if len(store.enqueued) != 0 {
		t.Errorf("строка записана несмотря на пустого получателя: %+v", store.enqueued)
	}
}

// --- вложения ----------------------------------------------------------------

// fakeResolver — добыча вложения: либо файл, либо ошибка. Считает вызовы, чтобы
// проверять потолок печатей на тик.
type fakeResolver struct {
	file  File
	err   error
	calls int
}

func (r *fakeResolver) Resolve(_ context.Context, _ AttachmentRef) (File, error) {
	r.calls++
	return r.file, r.err
}

func pendingWithAttachment(id uuid.UUID) Pending {
	payload, _ := json.Marshal(EmailMessage{
		To: "owner@example.com", Template: TemplateSubmissionNew,
		Data:        map[string]any{"form_title": "Анкета", "link": "https://x"},
		Attachments: []AttachmentRef{{Kind: KindSubmissionPDF, FormID: uuid.NewString(), SubmissionID: uuid.NewString()}},
	})
	return Pending{ID: id, Channel: ChannelEmail, Payload: payload}
}

// Вложение добывается при ДОСТАВКЕ и уезжает письмом; в payload его не было.
func TestDispatch_ResolvesAttachment(t *testing.T) {
	id := uuid.New()
	store := &fakeStore{pending: []Pending{pendingWithAttachment(id)}}
	mailer := &fakeMailer{}
	res := &fakeResolver{file: File{Name: "Анкета.pdf", MIME: "application/pdf", Content: []byte("%PDF")}}
	svc := newTestService(store, mailer).WithAttachments(res, 2)

	if _, err := svc.Dispatch(context.Background()); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(mailer.sent) != 1 || len(mailer.sent[0].Files) != 1 {
		t.Fatalf("письмо ушло без вложения: %+v", mailer.sent)
	}
	if got := mailer.sent[0].Files[0].Name; got != "Анкета.pdf" {
		t.Errorf("имя вложения = %q", got)
	}
	if len(store.sent) != 1 {
		t.Errorf("строка не помечена отправленной: %+v", store.sent)
	}
}

// Печать не удалась — письмо всё равно уходит, но говорит об этом владельцу
// (pdf_failed → строка в шаблоне). Откладывать письмо из-за вложения нельзя:
// сломанный принтер прятал бы от владельца сами ответы.
func TestDispatch_AttachmentFailure_SendsWithoutFile(t *testing.T) {
	id := uuid.New()
	store := &fakeStore{pending: []Pending{pendingWithAttachment(id)}}
	mailer := &fakeMailer{}
	svc := newTestService(store, mailer).WithAttachments(&fakeResolver{err: errors.New("принтер лежит")}, 2)

	if _, err := svc.Dispatch(context.Background()); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(mailer.sent) != 1 {
		t.Fatalf("письмо не ушло: %+v", mailer.sent)
	}
	if len(mailer.sent[0].Files) != 0 {
		t.Errorf("вложение приехало, хотя печать провалилась")
	}
	if mailer.sent[0].Data["pdf_failed"] != true {
		t.Errorf("письмо не сообщает о неудавшейся печати: %+v", mailer.sent[0].Data)
	}
	if len(store.failed) != 0 {
		t.Errorf("строка ушла в бэкофф из-за вложения: %+v", store.failed)
	}
}

// Резолвера нет вовсе (контур без печати) — то же самое: письмо с честной пометкой.
func TestDispatch_NoResolver_SendsWithoutFile(t *testing.T) {
	store := &fakeStore{pending: []Pending{pendingWithAttachment(uuid.New())}}
	mailer := &fakeMailer{}
	svc := newTestService(store, mailer)

	if _, err := svc.Dispatch(context.Background()); err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(mailer.sent) != 1 || mailer.sent[0].Data["pdf_failed"] != true {
		t.Fatalf("письмо без резолвера ушло не так: %+v", mailer.sent)
	}
}

// Потолок печатей на тик: сверх него письма ждут следующего прохода НЕТРОНУТЫМИ —
// ни отправленными, ни неудачными (иначе вложения растили бы attempts и уводили
// письма в бэкофф). Письма без вложений потолком не ограничены и едут в том же тике.
func TestDispatch_PrintBudget_PostponesRest(t *testing.T) {
	plain, _ := json.Marshal(EmailMessage{To: "user@example.com", Template: "reset"})
	plainID := uuid.New()
	store := &fakeStore{pending: []Pending{
		pendingWithAttachment(uuid.New()),
		pendingWithAttachment(uuid.New()),
		pendingWithAttachment(uuid.New()),
		{ID: plainID, Channel: ChannelEmail, Payload: plain},
	}}
	mailer := &fakeMailer{}
	res := &fakeResolver{file: File{Name: "a.pdf", MIME: "application/pdf", Content: []byte("%PDF")}}
	svc := newTestService(store, mailer).WithAttachments(res, 2)

	n, err := svc.Dispatch(context.Background())
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if res.calls != 2 {
		t.Errorf("печатей за тик = %d, потолок 2", res.calls)
	}
	if n != 3 {
		t.Errorf("доставлено = %d, ожидалось 3 (два с вложением + письмо без него)", n)
	}
	if len(store.failed) != 0 {
		t.Errorf("отложенное письмо помечено неудачей: %+v", store.failed)
	}
	if len(store.sent) != 3 {
		t.Errorf("помечено отправленными %d, ожидалось 3", len(store.sent))
	}
}
