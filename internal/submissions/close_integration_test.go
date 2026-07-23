//go:build integration

// Интеграционные тесты закрытия формы (фаза 8.5 шаг 4) против настоящего Postgres:
// снятие вручную и дата закрытия → 410; лимит ответов — жёсткий кап (ADR §10),
// проверяемый в т.ч. гонкой; идемпотентный ретрай проходит мимо лимита.
package submissions_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// closableForm публикует форму с обязательным полем b1 и возвращает slug, id формы,
// id владельца и сервис форм — чтобы тест мог менять живые настройки закрытия.
func closableForm(t *testing.T) (slug string, userID, formID uuid.UUID, formsSvc *forms.Service) {
	t.Helper()
	ctx := context.Background()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, nil, time.Hour, "")
	formsSvc = forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{})

	user, _, err := authSvc.Register(ctx, "own-"+uuid.NewString()[:8]+"@example.com", "supersecret1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	form, err := formsSvc.Create(ctx, user.ID, "Мероприятие")
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, user.ID, form.ID, []byte(requiredNameSchema), form.UpdatedAt); err != nil {
		t.Fatalf("save schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, user.ID, form.ID); err != nil {
		t.Fatalf("publish: %v", err)
	}
	return form.Slug, user.ID, form.ID, formsSvc
}

func answerBody() string {
	return `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
}

// Снятая вручную форма (status=closed) → 410 «приём закрыт» (не 404): форма была
// публичной. В БД ничего не появляется.
func TestSubmit_ManuallyClosed_410(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, userID, formID, formsSvc := closableForm(t)

	if _, err := formsSvc.Unpublish(context.Background(), userID, formID); err != nil {
		t.Fatalf("unpublish: %v", err)
	}
	resp := postSubmission(t, srv, slug, answerBody())
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("статус %d, ожидалось 410 (снятая форма)", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("в закрытую форму ответ не должен попасть, в БД %d строк", n)
	}
}

// Дата закрытия в прошлом → 410; форма остаётся published в БД (status не флипаем,
// закрытость вычисляется).
func TestSubmit_PastCloseDate_410(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, userID, formID, formsSvc := closableForm(t)

	past := time.Now().Add(-time.Hour)
	if _, err := formsSvc.UpdateCloseSettings(context.Background(), userID, formID,
		domain.CloseSettings{CloseAt: &past}); err != nil {
		t.Fatalf("set close date: %v", err)
	}
	resp := postSubmission(t, srv, slug, answerBody())
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("статус %d, ожидалось 410 (дата прошла)", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 0 {
		t.Fatalf("после даты закрытия ответ не должен попасть, в БД %d строк", n)
	}
}

// Дата закрытия в будущем не мешает приёму (страховка «не закрыли раньше времени»).
func TestSubmit_FutureCloseDate_Accepts(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, userID, formID, formsSvc := closableForm(t)

	future := time.Now().Add(time.Hour)
	if _, err := formsSvc.UpdateCloseSettings(context.Background(), userID, formID,
		domain.CloseSettings{CloseAt: &future}); err != nil {
		t.Fatalf("set close date: %v", err)
	}
	resp := postSubmission(t, srv, slug, answerBody())
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("статус %d, ожидалось 201 (дата ещё не наступила)", resp.StatusCode)
	}
}

// Лимит: приём до лимита проходит, за лимитом — 410; в БД ровно лимит строк.
func TestSubmit_LimitReached_HardCap(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, userID, formID, formsSvc := closableForm(t)

	limit := int32(2)
	if _, err := formsSvc.UpdateCloseSettings(context.Background(), userID, formID,
		domain.CloseSettings{ResponseLimit: &limit}); err != nil {
		t.Fatalf("set limit: %v", err)
	}

	for i := 0; i < 2; i++ {
		if resp := postSubmission(t, srv, slug, answerBody()); resp.StatusCode != http.StatusCreated {
			t.Fatalf("ответ #%d: статус %d, ожидалось 201", i+1, resp.StatusCode)
		}
	}
	// Третий — сверх лимита.
	if resp := postSubmission(t, srv, slug, answerBody()); resp.StatusCode != http.StatusGone {
		t.Fatalf("ответ сверх лимита: статус %d, ожидалось 410", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 2 {
		t.Fatalf("в БД %d строк, ожидалось ровно 2 (жёсткий кап)", n)
	}
}

// Идемпотентный ретрай уже принятого ответа проходит МИМО лимита: форма заполнена
// (2/2), но повтор существующего id снова 201 и не плодит строк.
func TestSubmit_RetryBypassesLimit(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, userID, formID, formsSvc := closableForm(t)

	limit := int32(2)
	if _, err := formsSvc.UpdateCloseSettings(context.Background(), userID, formID,
		domain.CloseSettings{ResponseLimit: &limit}); err != nil {
		t.Fatalf("set limit: %v", err)
	}

	firstID := uuid.NewString()
	first := `{"submission_id":"` + firstID + `","token":"` + freshToken() + `","answers":{"b1":"Анна"}}`
	if resp := postSubmission(t, srv, slug, first); resp.StatusCode != http.StatusCreated {
		t.Fatalf("первый ответ: статус %d, ожидалось 201", resp.StatusCode)
	}
	if resp := postSubmission(t, srv, slug, answerBody()); resp.StatusCode != http.StatusCreated {
		t.Fatalf("второй ответ: статус %d, ожидалось 201", resp.StatusCode)
	}
	// Форма заполнена (2/2). Ретрай первого id обязан пройти (ответ уже принят).
	if resp := postSubmission(t, srv, slug, first); resp.StatusCode != http.StatusCreated {
		t.Fatalf("ретрай принятого ответа у заполненной формы: статус %d, ожидалось 201", resp.StatusCode)
	}
	if n := countSubmissions(t); n != 2 {
		t.Fatalf("ретрай не должен плодить строк, в БД %d, ожидалось 2", n)
	}
}

// Гонка: множество одновременных приёмов при лимите N — жёсткий кап не пускает
// лишнего (в БД ровно N), число успехов (201) равно N, ни один принятый ответ не
// потерян (успех == сохранённая строка), нет 500.
func TestSubmit_Limit_ConcurrentRace_ExactCap(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, userID, formID, formsSvc := closableForm(t)

	const limit = 10
	const attempts = 60
	lim := int32(limit)
	if _, err := formsSvc.UpdateCloseSettings(context.Background(), userID, formID,
		domain.CloseSettings{ResponseLimit: &lim}); err != nil {
		t.Fatalf("set limit: %v", err)
	}

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		created int
		gone    int
		other   int
	)
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/submissions",
				"application/json", strings.NewReader(answerBody()))
			if err != nil {
				mu.Lock()
				other++
				mu.Unlock()
				return
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			mu.Lock()
			switch resp.StatusCode {
			case http.StatusCreated:
				created++
			case http.StatusGone:
				gone++
			default:
				other++
			}
			mu.Unlock()
		}()
	}
	wg.Wait()

	if other != 0 {
		t.Fatalf("неожиданные статусы (не 201/410): %d", other)
	}
	if created != limit {
		t.Fatalf("успехов (201) %d, ожидалось ровно %d (жёсткий кап)", created, limit)
	}
	if gone != attempts-limit {
		t.Fatalf("отказов (410) %d, ожидалось %d", gone, attempts-limit)
	}
	if n := countSubmissions(t); n != limit {
		t.Fatalf("в БД %d строк, ожидалось ровно %d (перебор недопустим, данные не потеряны)", n, limit)
	}
}
