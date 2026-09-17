//go:build integration

// Гейт согласия и ручки согласий против настоящего Postgres, с настоящей сессией auth:
// что кабинет закрыт до принятия, что пишется в журнал и что открывает кабинет обратно
// (docs/design/signup-consent.md §1, пп. 2–5).
package legal_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/legal"
	"github.com/ka-shmd/trillix/internal/pgtest"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

const origin = "http://localhost:5173"

type consentStack struct {
	srv   *httptest.Server
	auth  *auth.Service
	legal *legal.Service
}

func newConsentStack(t *testing.T, eds ...legal.Edition) consentStack {
	t.Helper()
	authSvc := newAuthService()
	legalSvc := legal.NewService(testPool, postgres.TxRunner{Pool: testPool}, legal.Repo{}, authSvc, eds, time.Now)
	if _, err := legalSvc.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	authSvc.WithConsents(legalSvc)
	allow := ratelimit.AllowAll{}
	authH := auth.NewHandler(authSvc, allow, allow, false, origin, false).
		WithAccount(auth.AccountLimits{PasswordChange: allow, TwoFactor: allow, DeleteAccount: allow, Avatar: allow})
	mux := http.NewServeMux()
	authH.Routes(mux)
	authH.AccountRoutes(mux)
	legal.NewHandler(legalSvc, authH.RequireSession, authH.RequireCSRF).Routes(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return consentStack{srv: srv, auth: authSvc, legal: legalSvc}
}

var past = day(2026, 1, 1)

func termsEd(version string, effective time.Time, material bool) legal.Edition {
	e := edition(legal.KindTerms, version, "соглашение "+version, effective, false)
	e.RequiresReacceptance = material
	return e
}

func baseEditions() []legal.Edition {
	return []legal.Edition{
		termsEd("2026-01-01", past, true),
		edition(legal.KindPrivacy, "2026-01-01", "политика", past, false),
		edition(legal.KindMarketing, "2026-01-01", "рассылки", past, false),
	}
}

type client struct {
	t    *testing.T
	http *http.Client
	base string
}

func newHTTPClient(t *testing.T, base string) client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	return client{t: t, http: &http.Client{Jar: jar}, base: base}
}

func (c client) csrf() string {
	u, _ := url.Parse(c.base)
	for _, ck := range c.http.Jar.Cookies(u) {
		if ck.Name == "csrf_token" {
			return ck.Value
		}
	}
	return ""
}

// do отправляет запрос с CSRF-заголовком из jar и возвращает статус и тело.
func (c client) do(method, path, body string) (int, string) {
	c.t.Helper()
	req, err := http.NewRequest(method, c.base+path, strings.NewReader(body))
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Firefox на Linux")
	if tok := c.csrf(); tok != "" {
		req.Header.Set("X-CSRF-Token", tok)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(raw)
}

func (c client) register(email string) {
	c.t.Helper()
	if code, body := c.do(http.MethodPost, "/api/v1/auth/register", `{"email":"`+email+`","password":"supersecret1"}`); code != http.StatusCreated {
		c.t.Fatalf("регистрация: %d %s", code, body)
	}
}

type consentsDTO struct {
	Screen *string `json:"screen"`
	Terms  *struct {
		Version         string  `json:"version"`
		Label           string  `json:"label"`
		Link            string  `json:"link"`
		AcceptedVersion *string `json:"acceptedVersion"`
	} `json:"terms"`
	Marketing *struct {
		Version     string `json:"version"`
		Label       string `json:"label"`
		ToggleLabel string `json:"toggleLabel"`
		Granted     bool   `json:"granted"`
	} `json:"marketing"`
	History []struct {
		Kind   string `json:"kind"`
		Action string `json:"action"`
		Source string `json:"source"`
	} `json:"history"`
}

func (c client) consents() consentsDTO {
	c.t.Helper()
	code, body := c.do(http.MethodGet, "/api/v1/account/consents", "")
	if code != http.StatusOK {
		c.t.Fatalf("GET consents: %d %s", code, body)
	}
	var v consentsDTO
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		c.t.Fatal(err)
	}
	return v
}

func (c client) meConsentRequired() bool {
	c.t.Helper()
	code, body := c.do(http.MethodGet, "/api/v1/auth/me", "")
	if code != http.StatusOK {
		c.t.Fatalf("me: %d %s", code, body)
	}
	var me struct {
		ConsentRequired bool `json:"consentRequired"`
	}
	if err := json.Unmarshal([]byte(body), &me); err != nil {
		c.t.Fatal(err)
	}
	return me.ConsentRequired
}

// privateStatus — статус приватной ручки за RequireAuth.
func (c client) privateStatus() int {
	c.t.Helper()
	code, _ := c.do(http.MethodGet, "/api/v1/account/identities", "")
	return code
}

type eventRow struct {
	kind, action, source, checkbox, email, userAgent string
}

func events(t *testing.T, email string) []eventRow {
	t.Helper()
	rows, err := testPool.Query(context.Background(), `
		SELECT d.kind, e.action, e.source, e.checkbox_text, e.email, e.user_agent
		FROM consent_events e
		JOIN legal_documents d ON d.id = e.document_id
		JOIN users u ON u.id = e.user_id
		WHERE u.email = $1
		ORDER BY e.created_at, e.id`, email)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []eventRow
	for rows.Next() {
		var r eventRow
		if err := rows.Scan(&r.kind, &r.action, &r.source, &r.checkbox, &r.email, &r.userAgent); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func signupCompleted(t *testing.T, email string) bool {
	t.Helper()
	var done bool
	if err := testPool.QueryRow(context.Background(),
		`SELECT signup_completed_at IS NOT NULL FROM users WHERE email = $1`, email).Scan(&done); err != nil {
		t.Fatal(err)
	}
	return done
}

func TestConsent_PasswordSignup(t *testing.T) {
	resetDB(t)
	st := newConsentStack(t, baseEditions()...)
	c := newHTTPClient(t, st.srv.URL)
	const email = "new@example.com"
	c.register(email)

	if !c.meConsentRequired() {
		t.Fatal("после регистрации /me не просит согласия")
	}
	if code := c.privateStatus(); code != http.StatusForbidden {
		t.Fatalf("приватная ручка до согласия: %d, ожидалось 403", code)
	}
	if code, body := c.do(http.MethodGet, "/api/v1/account/identities", ""); !strings.Contains(body, "consent_required") {
		t.Fatalf("тело отказа %d %s без consent_required", code, body)
	}
	v := c.consents()
	if v.Screen == nil || *v.Screen != "signup" || v.Terms == nil || v.Terms.Version != "2026-01-01" ||
		v.Terms.Label != "Принимаю Пользовательское соглашение" || v.Terms.Link != "Пользовательское соглашение" ||
		v.Marketing == nil || v.Marketing.Granted {
		t.Fatalf("состояние до согласия: %+v", v)
	}

	t.Run("рассылки без соглашения — 422", func(t *testing.T) {
		code, _ := c.do(http.MethodPost, "/api/v1/account/consents", `{"accept":[{"kind":"marketing","version":"2026-01-01"}]}`)
		if code != http.StatusUnprocessableEntity || len(events(t, email)) != 0 {
			t.Fatalf("статус %d, событий %d", code, len(events(t, email)))
		}
	})

	for name, body := range map[string]string{
		"пусто":                  `{}`,
		"устаревшая редакция":    `{"accept":[{"kind":"terms","version":"2025-12-01"}]}`,
		"политику не принимают":  `{"accept":[{"kind":"privacy","version":"2026-01-01"}]}`,
		"соглашение не отзывают": `{"withdraw":["terms"]}`,
		"дважды":                 `{"accept":[{"kind":"terms","version":"2026-01-01"},{"kind":"terms","version":"2026-01-01"}]}`,
		"лишнее поле":            `{"accept":[],"userId":"x"}`,
	} {
		t.Run("422: "+name, func(t *testing.T) {
			if code, resp := c.do(http.MethodPost, "/api/v1/account/consents", body); code != http.StatusUnprocessableEntity {
				t.Fatalf("статус %d %s", code, resp)
			}
		})
	}

	t.Run("без CSRF — 403", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodPost, st.srv.URL+"/api/v1/account/consents", strings.NewReader(`{"accept":[{"kind":"terms","version":"2026-01-01"}]}`))
		resp, err := c.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden || len(events(t, email)) != 0 {
			t.Fatalf("статус %d", resp.StatusCode)
		}
	})

	t.Run("без сессии — 401", func(t *testing.T) {
		anon := newHTTPClient(t, st.srv.URL)
		if code, _ := anon.do(http.MethodGet, "/api/v1/account/consents", ""); code != http.StatusUnauthorized {
			t.Fatalf("статус %d", code)
		}
	})

	// «Завершить регистрацию» с обеими галочками.
	code, body := c.do(http.MethodPost, "/api/v1/account/consents",
		`{"accept":[{"kind":"terms","version":"2026-01-01"},{"kind":"marketing","version":"2026-01-01"}]}`)
	if code != http.StatusOK {
		t.Fatalf("принятие: %d %s", code, body)
	}
	got := events(t, email)
	want := []eventRow{
		{"terms", "accepted", "signup_password", "Принимаю Пользовательское соглашение", email, "Firefox на Linux"},
		{"marketing", "accepted", "signup_password", "Даю согласие на получение новостей и предложений Trillix", email, "Firefox на Linux"},
	}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("журнал = %+v\nожидалось %+v", got, want)
	}
	if !signupCompleted(t, email) {
		t.Fatal("регистрация не отмечена завершённой")
	}
	if c.meConsentRequired() || c.privateStatus() != http.StatusOK {
		t.Fatal("после принятия кабинет всё ещё закрыт")
	}
	if v := c.consents(); v.Screen != nil || !v.Marketing.Granted || v.Terms.AcceptedVersion == nil {
		t.Fatalf("состояние после принятия: %+v", v)
	}

	t.Run("повтор не пишет событий", func(t *testing.T) {
		c.do(http.MethodPost, "/api/v1/account/consents",
			`{"accept":[{"kind":"terms","version":"2026-01-01"},{"kind":"marketing","version":"2026-01-01"}]}`)
		if n := len(events(t, email)); n != 2 {
			t.Fatalf("событий %d, ожидалось 2", n)
		}
	})

	t.Run("тумблер рассылок", func(t *testing.T) {
		if code, _ := c.do(http.MethodPost, "/api/v1/account/consents", `{"withdraw":["marketing"]}`); code != http.StatusOK {
			t.Fatalf("отзыв: %d", code)
		}
		c.do(http.MethodPost, "/api/v1/account/consents", `{"withdraw":["marketing"]}`) // повтор — без события
		if v := c.consents(); v.Marketing.Granted {
			t.Fatal("после отзыва согласие действует")
		}
		if code, _ := c.do(http.MethodPost, "/api/v1/account/consents", `{"accept":[{"kind":"marketing","version":"2026-01-01"}]}`); code != http.StatusOK {
			t.Fatalf("повторное согласие: %d", code)
		}
		got := events(t, email)
		if len(got) != 4 {
			t.Fatalf("журнал = %+v", got)
		}
		wantTail := []eventRow{
			{"marketing", "withdrawn", "settings", "Новости и предложения Trillix", email, "Firefox на Linux"},
			{"marketing", "accepted", "settings", "Новости и предложения Trillix", email, "Firefox на Linux"},
		}
		if got[2] != wantTail[0] || got[3] != wantTail[1] {
			t.Fatalf("хвост журнала = %+v", got[2:])
		}
		if v := c.consents(); !v.Marketing.Granted || len(v.History) != 4 || v.History[0].Action != "accepted" {
			t.Fatalf("история = %+v", v.History)
		}
	})
}

func TestConsent_ProviderSignup(t *testing.T) {
	resetDB(t)
	st := newConsentStack(t, baseEditions()...)
	ctx := context.Background()
	const email = "ya@example.com"
	_, token, err := st.auth.LoginWithIdentity(ctx, auth.IdentityProfile{Provider: "yandex", ProviderUserID: "42", Email: email}, auth.Device{})
	if err != nil {
		t.Fatal(err)
	}
	c := newHTTPClient(t, st.srv.URL)
	u, _ := url.Parse(st.srv.URL)
	c.http.Jar.SetCookies(u, []*http.Cookie{{Name: "session", Value: token}, {Name: "csrf_token", Value: "tok"}})

	if v := c.consents(); v.Screen == nil || *v.Screen != "signup" {
		t.Fatalf("экран: %+v", v.Screen)
	}
	if code, body := c.do(http.MethodPost, "/api/v1/account/consents", `{"accept":[{"kind":"terms","version":"2026-01-01"}]}`); code != http.StatusOK {
		t.Fatalf("принятие: %d %s", code, body)
	}
	got := events(t, email)
	if len(got) != 1 || got[0].source != "signup_yandex" {
		t.Fatalf("журнал = %+v", got)
	}
}

func TestConsent_NewEditions(t *testing.T) {
	resetDB(t)
	st := newConsentStack(t, baseEditions()...)
	c := newHTTPClient(t, st.srv.URL)
	const email = "old@example.com"
	c.register(email)
	c.do(http.MethodPost, "/api/v1/account/consents", `{"accept":[{"kind":"terms","version":"2026-01-01"}]}`)
	if c.meConsentRequired() {
		t.Fatal("после принятия гейт закрыт")
	}

	t.Run("несущественная редакция кабинет не закрывает", func(t *testing.T) {
		eds := append(baseEditions(), termsEd("2026-03-01", day(2026, 3, 1), false))
		newConsentStack(t, eds...) // публикация: сверка кладёт редакцию в базу
		if c.meConsentRequired() || c.privateStatus() != http.StatusOK {
			t.Fatal("несущественная редакция закрыла кабинет")
		}
	})

	t.Run("существенная — экран update и source update_screen", func(t *testing.T) {
		eds := append(baseEditions(), termsEd("2026-03-01", day(2026, 3, 1), false), termsEd("2026-05-01", day(2026, 5, 1), true))
		newConsentStack(t, eds...)
		if !c.meConsentRequired() || c.privateStatus() != http.StatusForbidden {
			t.Fatal("существенная редакция не закрыла кабинет")
		}
		v := c.consents()
		if v.Screen == nil || *v.Screen != "update" || v.Terms.Version != "2026-05-01" {
			t.Fatalf("состояние: screen=%v terms=%+v", v.Screen, v.Terms)
		}
		if code, _ := c.do(http.MethodPost, "/api/v1/account/consents", `{"accept":[{"kind":"terms","version":"2026-01-01"}]}`); code != http.StatusUnprocessableEntity {
			t.Fatalf("принятие старой редакции: %d, ожидалось 422", code)
		}
		if code, _ := c.do(http.MethodPost, "/api/v1/account/consents", `{"accept":[{"kind":"terms","version":"2026-05-01"}]}`); code != http.StatusOK {
			t.Fatalf("принятие новой: %d", code)
		}
		got := events(t, email)
		if last := got[len(got)-1]; last.source != "update_screen" || last.kind != "terms" {
			t.Fatalf("последнее событие %+v", last)
		}
		if c.meConsentRequired() {
			t.Fatal("после принятия новой редакции гейт закрыт")
		}
	})
}

func TestConsent_LegacyAccountSeesUpdateScreen(t *testing.T) {
	resetDB(t)
	st := newConsentStack(t, baseEditions()...)
	c := newHTTPClient(t, st.srv.URL)
	const email = "legacy@example.com"
	c.register(email)
	// Так миграция 0071 отметила аккаунты, заведённые до неё: регистрация завершена,
	// согласий нет.
	if _, err := testPool.Exec(context.Background(), `UPDATE users SET signup_completed_at = created_at WHERE email = $1`, email); err != nil {
		t.Fatal(err)
	}
	if v := c.consents(); v.Screen == nil || *v.Screen != "update" {
		t.Fatalf("экран: %v", v.Screen)
	}
}

func TestConsent_CompleteSignupForSeed(t *testing.T) {
	resetDB(t)
	st := newConsentStack(t, baseEditions()...)
	c := newHTTPClient(t, st.srv.URL)
	const email = "seed@example.com"
	c.register(email)
	pgtest.CompleteSignup(t, testPool, email)
	pgtest.CompleteSignup(t, testPool, email) // идемпотентно
	got := events(t, email)
	if len(got) != 1 || got[0].source != "seed" || !signupCompleted(t, email) || c.privateStatus() != http.StatusOK {
		t.Fatalf("журнал = %+v", got)
	}
}
