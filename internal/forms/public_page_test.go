package forms

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/domain"
)

func getHTMLPage(t *testing.T, svc publicFormService, slug string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	newPublicMux(svc).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/r/"+slug, nil))
	return rec
}

func TestPublicHTML_Published_HasOGMeta(t *testing.T) {
	schema := json.RawMessage(`{"schemaVersion":1,"blocks":[
		{"id":"b1","type":"short_text","label":"Ваше имя"},
		{"id":"b2","type":"short_text","label":"Оценка"}]}`)
	svc := fakePublicSvc{pf: PublicForm{Title: "Опрос клиентов", Version: 1, Schema: schema, VersionID: uuid.New()}}

	rec := getHTMLPage(t, svc, "abc123")
	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, ожидалось 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, ожидался text/html", ct)
	}
	body := rec.Body.String()

	for _, want := range []string{
		`<meta property="og:title" content="Опрос клиентов">`,
		`<meta property="og:image" content="http://localhost:5174/og-preview.png">`,
		`<meta property="og:url" content="http://localhost:5174/r/abc123">`,
		`<meta property="og:description" content="Ваше имя · Оценка">`, // подзаголовок из блоков
		`<meta name="description" content="Ваше имя · Оценка">`,        // стандартный SEO-мета
		`src="http://localhost:5174/src/main.tsx"`,                     // тело грузит SPA
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("в HTML нет %q\n---\n%s", want, body)
		}
	}
}

// Инъекция в title не должна прорасти сырым тегом в HTML (html/template экранирует).
func TestPublicHTML_TitleInjection_Escaped(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{
		Title:     `Опрос "><script>alert(1)</script>`,
		Version:   1,
		Schema:    json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		VersionID: uuid.New(),
	}}

	body := getHTMLPage(t, svc, "abc").Body.String()
	if strings.Contains(body, "<script>alert(1)") {
		t.Fatalf("сырой инъектированный <script> в выводе:\n%s", body)
	}
	// Экранированная форма присутствует (значит title вставлен, но обезврежен).
	if !strings.Contains(body, "&lt;script&gt;alert(1)") {
		t.Fatalf("ожидался экранированный script в мете:\n%s", body)
	}
}

// Пустая форма без вопросов → og:description опускается (тизера нет), но
// стандартный <meta name="description"> присутствует с фолбэком (SEO).
func TestPublicHTML_NoBlocks_OmitsOGButKeepsMetaDescription(t *testing.T) {
	svc := fakePublicSvc{pf: PublicForm{Title: "Пустая", Version: 1, Schema: json.RawMessage(`{"blocks":[]}`), VersionID: uuid.New()}}
	body := getHTMLPage(t, svc, "abc").Body.String()
	if strings.Contains(body, "og:description") {
		t.Fatalf("для формы без вопросов og:description не ожидался:\n%s", body)
	}
	if !strings.Contains(body, `<meta name="description" content="`+fallbackMetaDescription+`">`) {
		t.Fatalf("ожидался фолбэк-мета описания для пустой формы:\n%s", body)
	}
}

func TestPublicHTML_NotPublished_Returns404(t *testing.T) {
	svc := fakePublicSvc{err: domain.ErrNotFound}
	if code := getHTMLPage(t, svc, "draft").Code; code != http.StatusNotFound {
		t.Fatalf("статус %d, ожидалось 404 (черновик/закрытая по HTML-пути не раскрывается)", code)
	}
}

func TestOGDescriptionFromSchema(t *testing.T) {
	// Берёт до трёх непустых label, пропускает пустые, режет по рунам.
	long := strings.Repeat("я", 250)
	cases := []struct {
		name   string
		schema string
		want   string
	}{
		{"три блока", `{"blocks":[{"label":"A"},{"label":"B"},{"label":"C"},{"label":"D"}]}`, "A · B · C"},
		{"пустые пропускаются", `{"blocks":[{"label":"  "},{"label":"X"}]}`, "X"},
		{"нет блоков", `{"blocks":[]}`, ""},
		{"битая схема", `{oops`, ""},
		{"обрезка по рунам", `{"blocks":[{"label":"` + long + `"}]}`, string([]rune(long)[:200]) + "…"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ogDescriptionFromSchema(json.RawMessage(c.schema)); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}
