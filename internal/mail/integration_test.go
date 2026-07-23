//go:build integration

// Интеграционный тест outbox против настоящего Postgres в контейнере (PROCESS §3):
// полный цикл «намерение → диспетчер → доставка», ретрай при сбое транспорта и
// транзакционность записи. Гоняется под тегом `integration`; обычный `go test`
// его не собирает.
package mail_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
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
	if _, err := testPool.Exec(context.Background(), `TRUNCATE outbox`); err != nil {
		t.Fatalf("truncate: %v", err)
	}
}

// spyMailer считает вызовы и по флагу возвращает ошибку (имитация недоступного провайдера).
type spyMailer struct {
	mu   sync.Mutex
	sent []mail.EmailMessage
	fail bool
}

func (s *spyMailer) Send(_ context.Context, msg mail.EmailMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("provider unavailable")
	}
	s.sent = append(s.sent, msg)
	return nil
}

func (s *spyMailer) calls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sent)
}

func newSvc(mailer mail.Mailer) *mail.Service {
	return mail.NewService(testPool, mail.Repo{}, mailer,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
		50, mail.Backoff{Base: time.Minute, Max: time.Hour})
}

type rowState struct {
	attempts  int32
	nextAt    time.Time
	sentAt    pgtype.Timestamptz
	lastError pgtype.Text
}

func loadRow(t *testing.T) rowState {
	t.Helper()
	var r rowState
	var next pgtype.Timestamptz
	err := testPool.QueryRow(context.Background(),
		`SELECT attempts, next_attempt_at, sent_at, last_error FROM outbox`).
		Scan(&r.attempts, &next, &r.sentAt, &r.lastError)
	if err != nil {
		t.Fatalf("load outbox row: %v", err)
	}
	r.nextAt = next.Time
	return r
}

func TestOutboxDeliversAndMarksSent(t *testing.T) {
	resetDB(t)
	ctx := context.Background()
	spy := &spyMailer{}
	svc := newSvc(spy)

	if err := svc.EnqueueEmail(ctx, testPool, mail.EmailMessage{To: "user@example.com", Template: "reset"}); err != nil {
		t.Fatalf("EnqueueEmail: %v", err)
	}

	n, err := svc.Dispatch(ctx)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if n != 1 {
		t.Fatalf("delivered = %d, want 1", n)
	}
	if spy.calls() != 1 {
		t.Errorf("mailer calls = %d, want 1", spy.calls())
	}

	row := loadRow(t)
	if !row.sentAt.Valid {
		t.Error("sent_at пуст — доставленное письмо обязано быть помечено")
	}
	if row.attempts != 0 {
		t.Errorf("attempts = %d, want 0 (успех с первой попытки)", row.attempts)
	}

	// Повторный прогон не шлёт письмо второй раз: доставленное вне выборки.
	n2, err := svc.Dispatch(ctx)
	if err != nil {
		t.Fatalf("second Dispatch: %v", err)
	}
	if n2 != 0 || spy.calls() != 1 {
		t.Errorf("повторная доставка: n=%d calls=%d, want 0 и 1", n2, spy.calls())
	}
}

// Коалесинг (слайс D): пока письмо с ключом не отправлено, повторные постановки
// инкрементят один счётчик; после отправки новое событие открывает новое окно
// (новая строка), а не воскрешает отправленную — частичный индекс её не видит.
func TestOutboxCoalescesWhilePendingAndOpensNewWindowAfterSent(t *testing.T) {
	resetDB(t)
	ctx := context.Background()
	svc := newSvc(&spyMailer{})

	digest := func() mail.EmailMessage {
		return mail.EmailMessage{
			To:       "owner@example.com",
			Template: mail.TemplateSubmissionDigest,
			Data:     map[string]any{"form_title": "F", "link": "u", "count": 1},
		}
	}
	for i := 0; i < 2; i++ {
		if err := svc.EnqueueCoalesced(ctx, testPool, "submission:x", digest(), 0); err != nil {
			t.Fatalf("EnqueueCoalesced #%d: %v", i, err)
		}
	}
	var rows, maxCount int
	if err := testPool.QueryRow(ctx,
		`SELECT count(*), coalesce(max((payload#>>'{data,count}')::int), 0)
		 FROM outbox WHERE coalesce_key = 'submission:x' AND sent_at IS NULL`).Scan(&rows, &maxCount); err != nil {
		t.Fatalf("coalesce state: %v", err)
	}
	if rows != 1 || maxCount != 2 {
		t.Fatalf("во время окна: строк=%d count=%d, ожидалось 1 и 2", rows, maxCount)
	}

	if _, err := svc.Dispatch(ctx); err != nil { // delay 0 → готово сразу, метится sent
		t.Fatalf("Dispatch: %v", err)
	}

	if err := svc.EnqueueCoalesced(ctx, testPool, "submission:x", digest(), 0); err != nil {
		t.Fatalf("EnqueueCoalesced after sent: %v", err)
	}
	var total, pending int
	if err := testPool.QueryRow(ctx,
		`SELECT count(*), count(*) FILTER (WHERE sent_at IS NULL)
		 FROM outbox WHERE coalesce_key = 'submission:x'`).Scan(&total, &pending); err != nil {
		t.Fatalf("count: %v", err)
	}
	if total != 2 || pending != 1 {
		t.Fatalf("после отправки: всего=%d неотправленных=%d, ожидалось 2 и 1 (новое окно)", total, pending)
	}
}

func TestOutboxRetriesOnFailureAndSurvives(t *testing.T) {
	resetDB(t)
	ctx := context.Background()
	spy := &spyMailer{fail: true}
	svc := newSvc(spy)

	if err := svc.EnqueueEmail(ctx, testPool, mail.EmailMessage{To: "user@example.com", Template: "reset"}); err != nil {
		t.Fatalf("EnqueueEmail: %v", err)
	}

	n, err := svc.Dispatch(ctx)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if n != 0 {
		t.Errorf("delivered = %d, want 0 (провайдер недоступен)", n)
	}

	// Строка пережила сбой и осталась к доставке: sent_at пуст, попытка учтена,
	// следующая отложена в будущее, причина сохранена.
	row := loadRow(t)
	if row.sentAt.Valid {
		t.Error("sent_at проставлен при сбое доставки — письмо не ушло")
	}
	if row.attempts != 1 {
		t.Errorf("attempts = %d, want 1", row.attempts)
	}
	if !row.nextAt.After(time.Now()) {
		t.Errorf("next_attempt_at = %v, ожидался бэкофф в будущее", row.nextAt)
	}
	if !row.lastError.Valid || row.lastError.String == "" {
		t.Error("last_error пуст — причина сбоя обязана сохраниться")
	}

	// Немедленный повторный прогон не трогает строку: срок следующей попытки не наступил.
	n2, err := svc.Dispatch(ctx)
	if err != nil {
		t.Fatalf("second Dispatch: %v", err)
	}
	if n2 != 0 {
		t.Errorf("second delivered = %d, want 0", n2)
	}
	if row2 := loadRow(t); row2.attempts != 1 {
		t.Errorf("attempts после досрочного прогона = %d, want 1 (не должна пытаться раньше бэкоффа)", row2.attempts)
	}
}

// Запись в outbox идёт в транзакции продюсера: откат этой транзакции уносит и
// письмо (transactional outbox — событие и доставка фиксируются атомарно).
func TestOutboxEnqueueIsTransactional(t *testing.T) {
	resetDB(t)
	ctx := context.Background()
	svc := newSvc(&spyMailer{})

	sentinel := errors.New("rollback")
	err := postgres.WithTx(ctx, testPool, func(tx pgx.Tx) error {
		if e := svc.EnqueueEmail(ctx, tx, mail.EmailMessage{To: "user@example.com", Template: "reset"}); e != nil {
			return e
		}
		return sentinel // откатываем транзакцию продюсера
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("WithTx вернул %v, ждали sentinel", err)
	}

	var count int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM outbox`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Errorf("в outbox %d строк после отката, want 0", count)
	}
}
