//go:build integration

// Интеграционные тесты закрытия формы (фаза 8.5 шаг 4) против настоящего Postgres:
// снятие вручную и дата закрытия → 410; лимит ответов — жёсткий кап (ADR §10),
// проверяемый в т.ч. гонкой; идемпотентный ретрай проходит мимо лимита.
package submissions_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// closableForm публикует форму с обязательным полем b1 и возвращает slug, id формы,
// id владельца и сервис форм — чтобы тест мог менять живые настройки закрытия.
func closableForm(t *testing.T) (slug string, userID, formID uuid.UUID, formsSvc *forms.Service) {
	t.Helper()
	ctx := context.Background()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	formsSvc = forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))

	user, _, err := authSvc.Register(ctx, "own-"+uuid.NewString()[:8]+"@example.com", "supersecret1")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	form, err := formsSvc.Create(ctx, user.ID, "Мероприятие", nil)
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

// --- Частичные ответы (спека design/analytics-tally.md §10) ---

// setCollectPartial включает тумблер сбора прямо в базе: через сервис пришлось бы
// заводить пользователя и сессию, а предмет теста — публичный путь.
func setCollectPartial(t *testing.T, formID string, on bool) {
	t.Helper()
	if _, err := testPool.Exec(context.Background(),
		`UPDATE forms SET collect_partial = $2 WHERE id = $1`, formID, on); err != nil {
		t.Fatalf("set collect_partial: %v", err)
	}
}

// setPartialGate закрывает/открывает возможность на плане — тем же UPDATE, каким
// владелец включит гейт на проде.
func setPartialGate(t *testing.T, slug string, allowed bool) {
	t.Helper()
	value := "false"
	if allowed {
		value = "true"
	}
	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, '{submissions_partial}', $1::jsonb)
		 WHERE code = (SELECT s.plan_code FROM subscriptions s
		               JOIN workspace_members o ON o.user_id = s.user_id AND o.role = 'owner'
		               JOIN forms f ON f.workspace_id = o.workspace_id WHERE f.slug = $2)`,
		value, slug); err != nil {
		t.Fatalf("set partial gate: %v", err)
	}
	t.Cleanup(func() {
		if _, err := testPool.Exec(context.Background(),
			`UPDATE plans SET limits = jsonb_set(limits, '{submissions_partial}', 'true')`); err != nil {
			t.Fatalf("reset partial gate: %v", err)
		}
	})
}

func countPartials(t *testing.T, formID string) int {
	t.Helper()
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM partial_submissions WHERE form_id = $1`, formID).Scan(&n); err != nil {
		t.Fatalf("count partials: %v", err)
	}
	return n
}

// savePartial шлёт автосохранение и возвращает статус.
func savePartial(t *testing.T, srv *httptest.Server, slug, visitID, text string) int {
	t.Helper()
	body := `{"visit_id":"` + visitID + `","token":"` + freshToken() +
		`","version":1,"answers":{"b1":"` + text + `"},"last_block_id":"b1"}`
	resp, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/partial", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post partial: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

// submitWithVisit отправляет ответ с тем же visit_id, что и черновик, — так приём
// узнаёт, какой черновик убрать.
func submitWithVisit(t *testing.T, srv *httptest.Server, slug, visitID string) int {
	t.Helper()
	body := `{"submission_id":"` + uuid.NewString() + `","token":"` + freshToken() +
		`","visit_id":"` + visitID + `","answers":{"b1":"Анна"}}`
	resp, err := http.Post(srv.URL+"/public/v1/forms/"+slug+"/submissions", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("post submission: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode
}

// Сквозной сбор черновика: тумблер включён → автосохранение пишет строку →
// отправка ответа её убирает. Юнитом не покрыть: между ними живой тариф, живая
// колонка формы и порядок «сначала коммит ответа, потом удаление черновика».
func TestPartial_CollectedAndDroppedOnSubmit(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	formID := formIDBySlug(t, slug)
	setCollectPartial(t, formID, true)
	// План с правом собирать черновики: с 0041 у free его нет, и без этой строки
	// тест доказывал бы гейт, а не механику сбора.
	setPartialGate(t, slug, true)

	visitID := domain.NewID().String()
	if code := savePartial(t, srv, slug, visitID, "черновик"); code != http.StatusNoContent {
		t.Fatalf("автосохранение: статус %d, ждали 204", code)
	}
	if got := countPartials(t, formID); got != 1 {
		t.Fatalf("черновиков = %d, ждали 1", got)
	}

	// Повторное автосохранение перезаписывает строку, а не плодит вторую: черновик
	// это состояние, а не событие.
	if code := savePartial(t, srv, slug, visitID, "черновик подлиннее"); code != http.StatusNoContent {
		t.Fatalf("второе автосохранение: статус %d", code)
	}
	if got := countPartials(t, formID); got != 1 {
		t.Fatalf("после второго сохранения черновиков = %d, ждали 1", got)
	}

	if code := submitWithVisit(t, srv, slug, visitID); code != http.StatusCreated {
		t.Fatalf("приём ответа: статус %d, ждали 201", code)
	}
	if got := countPartials(t, formID); got != 0 {
		t.Errorf("черновиков после отправки = %d, ждали 0: ставший ответом удаляется", got)
	}
}

// Выключенный тумблер — ручки для формы всё равно что нет: 404, а не 403.
// Существование настройки чужой формы посторонним не раскрывается.
func TestPartial_DisabledToggleIs404(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)

	if code := savePartial(t, srv, slug, domain.NewID().String(), "черновик"); code != http.StatusNotFound {
		t.Fatalf("статус %d, ждали 404 при выключенном тумблере", code)
	}
}

// Даунгрейд останавливает сбор немедленно: тумблер остался включённым, а тариф
// его больше не разрешает — ручка отвечает 404, как при выключенном.
func TestPartial_DowngradeStopsCollection(t *testing.T) {
	resetDB(t)
	srv := newServer(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	formID := formIDBySlug(t, slug)
	setCollectPartial(t, formID, true)
	setPartialGate(t, slug, false)

	if code := savePartial(t, srv, slug, domain.NewID().String(), "черновик"); code != http.StatusNotFound {
		t.Fatalf("статус %d, ждали 404 после даунгрейда", code)
	}
}
