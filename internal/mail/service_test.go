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
	channel string
	payload []byte
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
