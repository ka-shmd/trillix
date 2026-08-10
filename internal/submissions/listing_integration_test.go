//go:build integration

// Интеграционный тест приватного листинга ответов против настоящего Postgres:
// вертикаль «опубликовать → принять N ответов → пролистать в кабинете». Упор на
// демо-критерий фазы 6 (новые сверху), корректность курсорной пагинации на границах
// страниц (без дублей и потерь), общий счётчик и анти-IDOR (чужая форма → 404).
package submissions_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/visits"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// fullStack поднимает auth + приватный листинг + публичный приём поверх контейнерного
// пула. Лимитеры пермиссивные (инвариант 6).
func fullStack(t *testing.T) *httptest.Server {
	t.Helper()
	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	visitsSvc := visits.NewService(testPool, formsSvc, entitlements.NewService(testPool, entitlements.Repo{}, time.Now), visits.Repo{})
	subSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, visitsSvc, pgtest.MailService(testPool),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now), submissions.Repo{}, "http://app.test")
	subPublic := submissions.NewPublicHandler(subSvc, ratelimit.AllowAll{}, testSecret, submissions.DefaultMinFillTime, false)
	subPrivate := submissions.NewHandler(subSvc, authH.RequireAuth, authH.RequireCSRF)

	mux := http.NewServeMux()
	authH.Routes(mux)
	subPublic.Routes(mux)
	subPrivate.Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// authedClient регистрирует пользователя по HTTP и возвращает клиента с его сессией
// и его id (для создания формы под этим пользователем).
func authedClient(t *testing.T, srv *httptest.Server, email string) (*http.Client, uuid.UUID) {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar: %v", err)
	}
	c := &http.Client{Jar: jar}
	resp, err := c.Post(srv.URL+"/api/v1/auth/register", "application/json",
		strings.NewReader(`{"email":"`+email+`","password":"supersecret1"}`))
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: статус %d, ожидалось 201", resp.StatusCode)
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode register: %v", err)
	}
	id, err := uuid.Parse(body.ID)
	if err != nil {
		t.Fatalf("parse user id: %v", err)
	}
	return c, id
}

// publishFormFor создаёт и публикует форму schema под пользователем userID; возвращает
// её slug. В отличие от publishedForm, владелец — переданный пользователь (нужно, чтобы
// HTTP-клиент из authedClient имел право листать её ответы).
func publishFormFor(t *testing.T, userID uuid.UUID, schema string) string {
	t.Helper()
	ctx := context.Background()
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	form, err := formsSvc.Create(ctx, userID, "Анкета", nil)
	if err != nil {
		t.Fatalf("create form: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, userID, form.ID, json.RawMessage(schema), form.UpdatedAt); err != nil {
		t.Fatalf("save schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, userID, form.ID); err != nil {
		t.Fatalf("publish: %v", err)
	}
	return form.Slug
}

// submitN отправляет n ответов на форму slug с UUIDv7-id (как рендерер: монотонны по
// времени → ORDER BY id DESC = хронология). Возвращает id в порядке отправки.
func submitN(t *testing.T, srv *httptest.Server, slug string, n int) []uuid.UUID {
	t.Helper()
	ids := make([]uuid.UUID, n)
	for i := range ids {
		id := domain.NewID()
		ids[i] = id
		body := `{"submission_id":"` + id.String() + `","token":"` + freshToken() + `","answers":{"b1":"Ответ"}}`
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("submit #%d: статус %d, ожидалось 201", i, resp.StatusCode)
		}
	}
	return ids
}

type listResp struct {
	Submissions []struct {
		ID          string          `json:"id"`
		FormVersion int32           `json:"formVersion"`
		Answers     json.RawMessage `json:"answers"`
	} `json:"submissions"`
	NextCursor *string `json:"nextCursor"`
	Total      int64   `json:"total"`
	Hidden     int64   `json:"hidden"`
}

func getList(t *testing.T, c *http.Client, srv *httptest.Server, formID, cursor string) listResp {
	t.Helper()
	u := srv.URL + "/api/v1/forms/" + formID + "/submissions?limit=2"
	if cursor != "" {
		u += "&cursor=" + cursor
	}
	resp, err := c.Get(u)
	if err != nil {
		t.Fatalf("get list: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get list: статус %d, ожидалось 200", resp.StatusCode)
	}
	var out listResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	return out
}

// formID достаёт id формы владельца по slug (тест публикует форму через сервис,
// который slug знает, а HTTP-листинг адресуется по id).
func formIDBySlug(t *testing.T, slug string) string {
	t.Helper()
	var id uuid.UUID
	if err := testPool.QueryRow(context.Background(), `SELECT id FROM forms WHERE slug = $1`, slug).Scan(&id); err != nil {
		t.Fatalf("form id by slug: %v", err)
	}
	return id.String()
}

// Демо-критерий фазы: пять ответов листаются страницами по 2, новые сверху, без
// дублей и потерь на границах; total = 5 на каждой странице; версия формы у каждого.
func TestListSubmissions_Pagination(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)

	sent := submitN(t, srv, slug, 5) // порядок отправки; «новые сверху» = обратный

	var got []string
	cursor := ""
	for pages := 0; ; pages++ {
		if pages > 10 {
			t.Fatal("пагинация не сходится (защита от бесконечного цикла)")
		}
		page := getList(t, owner, srv, fid, cursor)
		if page.Total != 5 {
			t.Fatalf("total = %d, ожидалось 5", page.Total)
		}
		for _, s := range page.Submissions {
			got = append(got, s.ID)
			if s.FormVersion != 1 {
				t.Fatalf("formVersion = %d, ожидалась 1", s.FormVersion)
			}
		}
		if page.NextCursor == nil {
			break
		}
		if len(page.Submissions) != 2 {
			t.Fatalf("непоследняя страница вернула %d строк, ожидалось 2 (limit)", len(page.Submissions))
		}
		cursor = *page.NextCursor
	}

	// Ожидаемый порядок: обратный порядку отправки (новые сверху).
	want := make([]string, len(sent))
	for i, id := range sent {
		want[len(sent)-1-i] = id.String()
	}
	if len(got) != len(want) {
		t.Fatalf("получено %d ответов, ожидалось %d (дубли/потери на границах)", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("порядок разошёлся на позиции %d: получен %s, ожидался %s", i, got[i], want[i])
		}
	}
}

// Анти-IDOR: чужой пользователь получает 404 на форму, где он не член воркспейса —
// существование формы и её ответов не раскрывается.
func TestListSubmissions_ForeignForm_404(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	slug, _ := publishedForm(t, requiredNameSchema) // владелец — внутренний пользователь helper'а
	fid := formIDBySlug(t, slug)
	submitN(t, srv, slug, 1)

	attacker, _ := authedClient(t, srv, "attacker-"+uuid.NewString()[:8]+"@example.com")
	resp, err := attacker.Get(srv.URL + "/api/v1/forms/" + fid + "/submissions")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("чужая форма: статус %d, ожидалось 404", resp.StatusCode)
	}
}

// Сверхлимитные ответы (over_quota, фаза 17) не видны владельцу до апгрейда: их нет
// ни в таблице, ни в счётчике total, но их число названо вслух в hidden. Молчаливое
// исчезновение собранных данных читается как потеря — это отдельное обещание.
func TestListSubmissions_OverQuotaHiddenUntilRevealed(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	c, userID := authedClient(t, srv, "quota-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, userID, requiredNameSchema)
	formID := uuid.MustParse(formIDBySlug(t, slug))

	submitN(t, srv, slug, 3)
	// Третий ответ помечаем сверхлимитным напрямую: механику пометки сторожат
	// тесты приёма (шаг 3), здесь проверяется ПОСЛЕДСТВИЕ пометки в кабинете.
	marked := markLastOverQuota(t, formID, 1)

	got := getList(t, c, srv, formID.String(), "")
	if got.Total != 2 {
		t.Errorf("total = %d, ожидалось 2 (видимые)", got.Total)
	}
	if got.Hidden != 1 {
		t.Errorf("hidden = %d, ожидался 1", got.Hidden)
	}
	if len(got.Submissions) != 2 {
		t.Errorf("в выдаче %d строк, ожидалось 2", len(got.Submissions))
	}
	// Скрытой строки в выдаче быть не должно — она самая свежая, то есть без
	// фильтра попала бы на первую же страницу.
	for _, row := range got.Submissions {
		if row.ID == marked[0].String() {
			t.Errorf("сверхлимитный ответ %s показан владельцу", row.ID)
		}
	}
	// Карточка формы обязана показывать то же число, что и таблица: «3 ответа» на
	// карточке против двух в таблице читается как пропажа данных.
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{},
			entitlements.NewService(testPool, entitlements.Repo{}, time.Now),
			pgtest.MailService(testPool), "http://localhost:5173"),
		entitlements.NewService(testPool, entitlements.Repo{}, time.Now))
	card, err := formsSvc.Get(context.Background(), userID, formID)
	if err != nil {
		t.Fatalf("get form: %v", err)
	}
	if card.SubmissionCount != 2 {
		t.Errorf("счётчик карточки = %d, ожидалось 2 (как в таблице)", card.SubmissionCount)
	}

	// Апгрейд возвращает всё — той самой операцией, которой владелец меняет план.
	n, err := submissions.Repo{}.RevealHidden(context.Background(), testPool, workspaceOf(t, formID))
	if err != nil {
		t.Fatalf("RevealHidden: %v", err)
	}
	if n != 1 {
		t.Errorf("открыто %d ответов, ожидался 1", n)
	}
	after := getList(t, c, srv, formID.String(), "")
	if after.Total != 3 || after.Hidden != 0 {
		t.Errorf("после апгрейда total/hidden = %d/%d, ожидалось 3/0", after.Total, after.Hidden)
	}
}

// Экспорт CSV скрывает сверхлимитные наравне с таблицей (решение владельца): иначе
// гейт обходится в один клик и гейтом не является.
func TestExportCSV_HidesOverQuota(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	c, userID := authedClient(t, srv, "csv-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, userID, requiredNameSchema)
	formID := uuid.MustParse(formIDBySlug(t, slug))

	submitN(t, srv, slug, 3)
	markLastOverQuota(t, formID, 2)

	resp, err := c.Get(srv.URL + "/api/v1/forms/" + formID.String() + "/submissions/export")
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	// Заголовок + одна строка данных: две скрытых в выгрузку не попали.
	lines := strings.Count(strings.TrimSpace(string(body)), "\n") + 1
	if lines != 2 {
		t.Errorf("в CSV %d строк (с заголовком), ожидалось 2: сверхлимитные не выгружаются\n%s", lines, body)
	}
}

func workspaceOf(t *testing.T, formID uuid.UUID) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	if err := testPool.QueryRow(context.Background(), `SELECT workspace_id FROM forms WHERE id = $1`, formID).Scan(&id); err != nil {
		t.Fatalf("workspace of form: %v", err)
	}
	return id
}

// markLastOverQuota помечает n самых свежих ответов формы сверхлимитными и
// возвращает их id — тесту нужно убедиться, что именно ЭТИ строки не показаны.
func markLastOverQuota(t *testing.T, formID uuid.UUID, n int) []uuid.UUID {
	t.Helper()
	rows, err := testPool.Query(context.Background(), `
		UPDATE submissions SET over_quota = true
		WHERE id IN (SELECT id FROM submissions WHERE form_id = $1 ORDER BY id DESC LIMIT $2)
		RETURNING id`, formID, n)
	if err != nil {
		t.Fatalf("mark over quota: %v", err)
	}
	defer rows.Close()
	var ids []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if e := rows.Scan(&id); e != nil {
			t.Fatalf("scan marked: %v", e)
		}
		ids = append(ids, id)
	}
	if len(ids) != n {
		t.Fatalf("помечено %d ответов, ожидалось %d", len(ids), n)
	}
	return ids
}
