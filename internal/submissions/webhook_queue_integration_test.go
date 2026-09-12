//go:build integration

// Постановка доставки в вебхуки идёт ТЕМ ЖЕ SQL-утверждением, что вставка ответа
// (фаза 28, ADR §10). Проверяется здесь, против настоящего Postgres: на фейках
// «одно утверждение» не видно вовсе — там это два вызова.
package submissions_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// webhookFor заводит вебхук формы напрямую: проходить ручки кабинета ради
// проверки очереди значило бы тестировать не то.
func webhookFor(t *testing.T, slug string, enabled bool, status string) uuid.UUID {
	t.Helper()
	id := uuid.New()
	_, err := testPool.Exec(context.Background(),
		`INSERT INTO form_webhooks (id, form_id, url, secret, enabled, status)
		 SELECT $1, id, 'https://hooks.example.com/x', '\x00'::bytea, $3, $4 FROM forms WHERE slug = $2`,
		id, slug, enabled, status)
	if err != nil {
		t.Fatalf("insert webhook: %v", err)
	}
	return id
}

func queuedFor(t *testing.T, webhookID uuid.UUID) int {
	t.Helper()
	var n int
	err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM webhook_queue WHERE webhook_id = $1`, webhookID).Scan(&n)
	if err != nil {
		t.Fatalf("count queue: %v", err)
	}
	return n
}

// Принятый ответ встаёт в очередь каждого ВКЛЮЧЁННОГО вебхука формы. Выключенный
// не получает ничего: событие, которое некому доставить, лучше не заводить.
// Сломанный — получает: починка увезёт накопленное по порядку.
func TestSubmit_QueuesEnabledWebhooks(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	live := webhookFor(t, slug, true, "live")
	broken := webhookFor(t, slug, true, "broken")
	off := webhookFor(t, slug, false, "live")

	subID := uuid.NewString()
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("приём: статус %d, ожидалось 201", resp.StatusCode)
	}

	if got := queuedFor(t, live); got != 1 {
		t.Fatalf("у работающего вебхука в очереди %d, ожидался один ответ", got)
	}
	if got := queuedFor(t, broken); got != 1 {
		t.Fatalf("у сломанного вебхука в очереди %d — ответы обязаны копиться до починки", got)
	}
	if got := queuedFor(t, off); got != 0 {
		t.Fatalf("у выключенного вебхука в очереди %d, ожидался ноль", got)
	}
}

// Идемпотентный ретрай приёма (тот же submission_id) второй доставки не даёт:
// ветка очереди читает ins, а он при конфликте пуст.
func TestSubmit_IdempotentRetryDoesNotQueueTwice(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	hook := webhookFor(t, slug, true, "live")

	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	for i := 0; i < 2; i++ {
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("отправка #%d: статус %d", i+1, resp.StatusCode)
		}
	}
	if got := queuedFor(t, hook); got != 1 {
		t.Fatalf("в очереди %d строк, ожидалась одна", got)
	}
}

// Ответ сверх жёсткого капа формы откатывается — вместе с ним откатывается и
// строка очереди: они в одной транзакции.
func TestSubmit_OverLimitLeavesNoQueueRow(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	hook := webhookFor(t, slug, true, "live")
	if _, err := testPool.Exec(context.Background(),
		`UPDATE forms SET response_limit = 1 WHERE slug = $1`, slug); err != nil {
		t.Fatalf("set limit: %v", err)
	}

	first := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"A"}}`
	if resp := postSubmission(t, srv, slug, first); resp.StatusCode != http.StatusCreated {
		t.Fatalf("первый ответ: статус %d", resp.StatusCode)
	}
	second := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"B"}}`
	if resp := postSubmission(t, srv, slug, second); resp.StatusCode != http.StatusGone {
		t.Fatalf("ответ сверх капа: статус %d, ожидалось 410", resp.StatusCode)
	}

	if got := queuedFor(t, hook); got != 1 {
		t.Fatalf("в очереди %d строк, ожидалась одна — отклонённый ответ доставки не заводит", got)
	}
}

// Удалённый ответ уходит из очереди каскадом: везти его некуда.
func TestSubmit_DeletedSubmissionLeavesQueue(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	hook := webhookFor(t, slug, true, "live")

	subID := uuid.NewString()
	body := `{"submission_id":"` + subID + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
		t.Fatalf("приём: статус %d", resp.StatusCode)
	}
	if _, err := testPool.Exec(context.Background(), `DELETE FROM submissions WHERE id = $1`, subID); err != nil {
		t.Fatalf("delete submission: %v", err)
	}
	if got := queuedFor(t, hook); got != 0 {
		t.Fatalf("в очереди %d строк, ожидался ноль", got)
	}
}
