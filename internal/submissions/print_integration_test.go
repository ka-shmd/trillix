//go:build integration

// Печать ответа в PDF против настоящего Postgres: вертикаль «опубликовать → принять
// ответ → нажать кнопку в кабинете → получить файл». Роль headless-Chromium играет
// фейковый принтер: он ходит по тому же адресу печатной страницы, что и настоящий,
// поэтому проверяется весь путь до документа — право, токен, данные на листе, — и
// не проверяется только сама печать браузером (её негде гонять в CI).
package submissions_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/printer"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/visits"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// printedPage — что фейковый принтер увидел на печатной странице. Заполняется в
// момент печати; тест читает её после ответа ручки.
type printedPage struct {
	html   string
	status int
}

// printStack поднимает кабинет с печатью: api (auth + листинг + печатная страница) и
// фейковый принтер, который вместо браузера скачивает страницу обычным GET.
func printStack(t *testing.T) (*httptest.Server, *printedPage) {
	t.Helper()

	authSvc := auth.NewService(testPool, postgres.TxRunner{Pool: testPool}, auth.Repo{}, pgtest.MailService(testPool), time.Hour, "")
	authH := auth.NewHandler(authSvc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, "http://localhost:5173", false)

	ent := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, ent,
			pgtest.MailService(testPool), "http://localhost:5173"), ent)
	visitsSvc := visits.NewService(testPool, formsSvc, ent, visits.Repo{}, nil, nil)
	subSvc := submissions.NewService(testPool, postgres.TxRunner{Pool: testPool}, formsSvc, visitsSvc,
		pgtest.MailService(testPool), ent, submissions.Repo{}, "http://app.test")

	subPublic := submissions.NewPublicHandler(subSvc, ratelimit.AllowAll{}, testSecret, submissions.DefaultMinFillTime, false)

	printPage, err := submissions.NewPrintPageHandler(subSvc, testSecret, writePrintHTML(t))
	if err != nil {
		t.Fatalf("print page handler: %v", err)
	}

	// Адрес api известен только после старта сервера, а принтеру он нужен раньше:
	// замыкание читает переменную в момент запроса, когда сервер уже поднят.
	var apiURL string
	seen := &printedPage{}
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Path string `json:"path"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		resp, err := http.Get(apiURL + req.Path)
		if err != nil {
			http.Error(w, "fetch page", http.StatusBadGateway)
			return
		}
		defer func() { _ = resp.Body.Close() }()
		body, _ := io.ReadAll(resp.Body)
		seen.html, seen.status = string(body), resp.StatusCode
		if resp.StatusCode != http.StatusOK {
			http.Error(w, "page not printable", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.7 напечатано"))
	}))
	t.Cleanup(fake.Close)

	subPrivate := submissions.NewHandler(subSvc, authH.RequireAuth, authH.RequireCSRF).
		WithPrinter(printer.New(fake.URL, 2, 10*time.Second), testSecret)

	mux := http.NewServeMux()
	authH.Routes(mux)
	subPublic.Routes(mux)
	subPrivate.Routes(mux)
	printPage.Routes(mux)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	apiURL = srv.URL
	return srv, seen
}

// writePrintHTML кладёт заглушку собранного print.html: настоящую страницу собирает
// vite, а Go от неё нужен ровно один плейсхолдер.
func writePrintHTML(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "print.html")
	html := "<!doctype html><html><body><div id=\"root\"></div><!--print-data--></body></html>"
	if err := os.WriteFile(path, []byte(html), 0o600); err != nil {
		t.Fatalf("write print.html: %v", err)
	}
	return path
}

func getPDF(t *testing.T, c *http.Client, srv *httptest.Server, formID, subID string) *http.Response {
	t.Helper()
	resp, err := c.Get(srv.URL + "/api/v1/forms/" + formID + "/print/" + subID)
	if err != nil {
		t.Fatalf("get pdf: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// Критерий приёмки задачи: у строки ответа есть кнопка «Скачать PDF», и она отдаёт
// файл, на котором ответ этого респондента.
func TestPrintPDF_EndToEnd(t *testing.T) {
	resetDB(t)
	srv, page := printStack(t)
	owner, ownerID := authedClient(t, srv, "print-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	subID := submitN(t, srv, slug, 1)[0].String()

	resp := getPDF(t, owner, srv, fid, subID)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/pdf" {
		t.Errorf("Content-Type = %q, ждали application/pdf", ct)
	}
	if cd := resp.Header.Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") {
		t.Errorf("Content-Disposition = %q, ждали вложение", cd)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.HasPrefix(string(body), "%PDF-") {
		t.Errorf("тело не похоже на PDF: %.20q", body)
	}

	// На печатной странице — вопрос той версии и ответ этого респондента.
	if !strings.Contains(page.html, `id="print-data"`) {
		t.Fatalf("данные не впечатаны в страницу: %.200q", page.html)
	}
	if !strings.Contains(page.html, "Ответ") || !strings.Contains(page.html, subID) {
		t.Errorf("на странице нет ответа или его id: %.400q", page.html)
	}
	if !strings.Contains(page.html, "b1") {
		t.Errorf("на странице нет вопроса формы: %.400q", page.html)
	}
}

// Печатается схема ТОЙ версии, по которой отправлен ответ, а не текущей: вопрос,
// удалённый автором позже, обязан остаться на листе вместе со своим ответом.
func TestPrintPDF_UsesSubmissionVersion(t *testing.T) {
	resetDB(t)
	srv, page := printStack(t)
	owner, ownerID := authedClient(t, srv, "print-ver-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	subID := submitN(t, srv, slug, 1)[0].String()

	// Автор переписывает форму целиком и публикует вторую версию.
	republish(t, ownerID, fid, `{"blocks":[{"id":"t_b9","groupId":"g_b9","type":"title","text":[{"t":"Город"}]},{"id":"b9","groupId":"g_b9","type":"short_text","settings":{}}]}`)

	if resp := getPDF(t, owner, srv, fid, subID); resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", resp.StatusCode)
	}
	if !strings.Contains(page.html, "Имя") {
		t.Errorf("на листе нет вопроса версии ответа: %.400q", page.html)
	}
	if strings.Contains(page.html, "Город") {
		t.Errorf("на лист попал вопрос новой версии: %.400q", page.html)
	}
}

// Анти-IDOR: чужой ответ не печатается и его существование не подтверждается.
func TestPrintPDF_ForeignFormIs404(t *testing.T) {
	resetDB(t)
	srv, _ := printStack(t)
	_, ownerID := authedClient(t, srv, "print-own-"+uuid.NewString()[:8]+"@example.com")
	stranger, _ := authedClient(t, srv, "print-str-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	subID := submitN(t, srv, slug, 1)[0].String()

	if resp := getPDF(t, stranger, srv, fid, subID); resp.StatusCode != http.StatusNotFound {
		t.Errorf("чужой получил статус %d, ожидалось 404", resp.StatusCode)
	}
}

// Несуществующий ответ — 404 ДО того, как поднимется браузер: печать не должна
// стоить запуска процесса, чтобы вернуть пустой лист.
func TestPrintPDF_MissingSubmissionIs404(t *testing.T) {
	resetDB(t)
	srv, page := printStack(t)
	owner, ownerID := authedClient(t, srv, "print-404-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)

	if resp := getPDF(t, owner, srv, fid, uuid.NewString()); resp.StatusCode != http.StatusNotFound {
		t.Errorf("статус %d, ожидалось 404", resp.StatusCode)
	}
	if page.html != "" {
		t.Error("принтер был вызван на несуществующем ответе")
	}
}

// Печатная страница без токена (или с чужим) недоступна: она отдаёт чужой ответ без
// всякой сессии, и единственное, что её защищает, — подпись.
func TestPrintPage_RejectsBadToken(t *testing.T) {
	resetDB(t)
	srv, _ := printStack(t)

	for _, tok := range []string{"мусор", uuid.NewString(), ""} {
		resp, err := http.Get(srv.URL + "/internal/print/doc/" + tok)
		if err != nil {
			t.Fatalf("get print page: %v", err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Errorf("токен %q принят, ждали отказ", tok)
		}
	}
}

// republish переписывает черновик формы и публикует новую версию.
func republish(t *testing.T, userID uuid.UUID, formID, schema string) {
	t.Helper()
	ctx := context.Background()
	ent := entitlements.NewService(testPool, entitlements.Repo{}, time.Now)
	formsSvc := forms.NewService(testPool, postgres.TxRunner{Pool: testPool}, forms.Repo{},
		workspaces.NewService(testPool, postgres.TxRunner{Pool: testPool}, workspaces.Repo{}, ent,
			pgtest.MailService(testPool), "http://localhost:5173"), ent)
	id := uuid.MustParse(formID)
	form, err := formsSvc.Get(ctx, userID, id)
	if err != nil {
		t.Fatalf("get form: %v", err)
	}
	if _, err := formsSvc.UpdateDraftSchema(ctx, userID, id, json.RawMessage(schema), form.UpdatedAt); err != nil {
		t.Fatalf("save schema: %v", err)
	}
	if _, err := formsSvc.Publish(ctx, userID, id); err != nil {
		t.Fatalf("publish: %v", err)
	}
}
