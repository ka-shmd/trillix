package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/ratelimit"
)

// gatedProbe собирает цепочку middleware → next, который отмечает, что до него дошли.
func gatedProbe(svc authService, wrap func(*Handler, http.Handler) http.Handler) (http.Handler, *bool) {
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false)
	reached := new(bool)
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		*reached = true
		w.WriteHeader(http.StatusNoContent)
	})
	return wrap(h, next), reached
}

func sessionRequest(method, path, body string) *http.Request {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "live-session"})
	return req
}

func TestRequireAuth_ConsentGate(t *testing.T) {
	user := User{ID: domain.NewID(), Email: "a@b.com"}
	requireAuth := func(h *Handler, next http.Handler) http.Handler { return h.RequireAuth(next) }

	t.Run("соглашение не принято — 403 consent_required, дальше не пускает", func(t *testing.T) {
		svc := &fakeAuthService{user: user, consentRequired: true}
		mw, reached := gatedProbe(svc, requireAuth)
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, sessionRequest(http.MethodGet, "/x", ""))
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "consent_required") {
			t.Fatalf("статус = %d, тело = %s", rec.Code, rec.Body)
		}
		if *reached {
			t.Fatal("гейт пропустил запрос")
		}
		if svc.consentAsked != user.ID {
			t.Fatalf("гейт спросил про %s, ожидался %s", svc.consentAsked, user.ID)
		}
	})

	t.Run("принято — пропускает", func(t *testing.T) {
		mw, reached := gatedProbe(&fakeAuthService{user: user}, requireAuth)
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, sessionRequest(http.MethodGet, "/x", ""))
		if rec.Code != http.StatusNoContent || !*reached {
			t.Fatalf("статус = %d, дошёл = %v", rec.Code, *reached)
		}
	})

	t.Run("гейт упал — 500, а не пропуск", func(t *testing.T) {
		svc := &fakeAuthService{user: user, consentErr: errConsentGateMissing}
		mw, reached := gatedProbe(svc, requireAuth)
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, sessionRequest(http.MethodGet, "/x", ""))
		if rec.Code != http.StatusInternalServerError || *reached {
			t.Fatalf("статус = %d, дошёл = %v", rec.Code, *reached)
		}
	})

	t.Run("без сессии — 401 до гейта", func(t *testing.T) {
		svc := &fakeAuthService{consentRequired: true}
		mw, _ := gatedProbe(svc, requireAuth)
		rec := httptest.NewRecorder()
		mw.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("статус = %d, ожидалось 401", rec.Code)
		}
		if svc.consentAsked != uuid.Nil {
			t.Fatal("гейт спрашивали без сессии")
		}
	})
}

func TestRequireSession_IgnoresConsentGate(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID()}, consentRequired: true}
	mw, reached := gatedProbe(svc, func(h *Handler, next http.Handler) http.Handler { return h.RequireSession(next) })
	rec := httptest.NewRecorder()
	mw.ServeHTTP(rec, sessionRequest(http.MethodGet, "/x", ""))
	if rec.Code != http.StatusNoContent || !*reached {
		t.Fatalf("статус = %d, дошёл = %v", rec.Code, *reached)
	}
}

func TestMe_ReportsConsentRequired(t *testing.T) {
	for _, required := range []bool{true, false} {
		svc := &fakeAuthService{user: User{ID: domain.NewID(), Email: "a@b.com"}, consentRequired: required}
		srv := newTestHandler(svc, ratelimit.AllowAll{})
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, sessionRequest(http.MethodGet, "/api/v1/auth/me", ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("статус = %d; тело = %s", rec.Code, rec.Body)
		}
		var body struct {
			Email           string `json:"email"`
			ConsentRequired bool   `json:"consentRequired"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.ConsentRequired != required || body.Email != "a@b.com" {
			t.Fatalf("тело = %+v, ожидался consentRequired=%v", body, required)
		}
	}
}

func TestLogout_WorksBehindConsentGate(t *testing.T) {
	svc := &fakeAuthService{user: User{ID: domain.NewID()}, consentRequired: true}
	srv := newTestHandler(svc, ratelimit.AllowAll{})
	req := sessionRequest(http.MethodPost, "/api/v1/auth/logout", "")
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || !svc.loggedOut {
		t.Fatalf("статус = %d, вышел = %v", rec.Code, svc.loggedOut)
	}
}

func TestConsentRequired_WithoutGateFails(t *testing.T) {
	_, err := newService(&fakeStore{}).ConsentRequired(context.Background(), domain.NewID())
	if !errors.Is(err, errConsentGateMissing) {
		t.Fatalf("err = %v, ожидалась errConsentGateMissing", err)
	}
}

type stubGate struct{ required bool }

func (g stubGate) ConsentRequired(context.Context, uuid.UUID) (bool, error) { return g.required, nil }

func TestConsentRequired_AsksGate(t *testing.T) {
	svc := newService(&fakeStore{}).WithConsents(stubGate{required: true})
	required, err := svc.ConsentRequired(context.Background(), domain.NewID())
	if err != nil || !required {
		t.Fatalf("required = %v, err = %v", required, err)
	}
}

func TestSaveSignupProfile_Validation(t *testing.T) {
	str := func(s string) *string { return &s }
	cases := []struct {
		name string
		p    SignupProfile
		ok   bool
	}{
		{"всё пропущено", SignupProfile{}, true},
		{"частное лицо целиком", SignupProfile{Kind: str("person"), FullName: str("Иванов Иван"), Occupation: str("freelance"), Profession: str("дизайнер"), Purpose: str("leads"), Referral: str("article")}, true},
		{"компания целиком", SignupProfile{Kind: str("company"), FullName: str("Иванов Иван"), CompanyName: str("ООО «Ромашка»"), Industry: str("it"), JobPosition: str("owner")}, true},
		{"чужой вид", SignupProfile{Kind: str("robot")}, false},
		{"чужая цель", SignupProfile{Purpose: str("")}, false},
		{"чужой источник", SignupProfile{Referral: str("tv")}, false},
		{"чужое занятие", SignupProfile{Kind: str("person"), Occupation: str("pilot")}, false},
		{"чужая сфера", SignupProfile{Kind: str("company"), Industry: str("space")}, false},
		{"чужая должность", SignupProfile{Kind: str("company"), JobPosition: str("ceo")}, false},
		{"ФИО длиннее 200", SignupProfile{FullName: str(strings.Repeat("я", 201))}, false},
		{"профессия длиннее 100", SignupProfile{Kind: str("person"), Profession: str(strings.Repeat("я", 101))}, false},
		{"название длиннее 300", SignupProfile{Kind: str("company"), CompanyName: str(strings.Repeat("я", 301))}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			err := newService(store).SaveSignupProfile(context.Background(), domain.NewID(), tc.p)
			if tc.ok && (err != nil || store.signupProfile == nil) {
				t.Fatalf("err = %v, сохранено = %v", err, store.signupProfile != nil)
			}
			if !tc.ok && (!errors.Is(err, domain.ErrValidation) || store.signupProfile != nil) {
				t.Fatalf("err = %v, сохранено = %v", err, store.signupProfile != nil)
			}
		})
	}
}

func TestSaveSignupProfile_Normalizes(t *testing.T) {
	str := func(s string) *string { return &s }
	store := &fakeStore{}
	// Человек заполнил вкладку компании, переключился на частное лицо и отправил.
	err := newService(store).SaveSignupProfile(context.Background(), domain.NewID(), SignupProfile{
		Kind: str("person"), FullName: str("  Иванов Иван  "), Profession: str("   "),
		CompanyName: str("ООО «Ромашка»"), Industry: str("it"), JobPosition: str("owner"), Occupation: str("study"),
	})
	if err != nil {
		t.Fatal(err)
	}
	p := store.signupProfile
	if p.FullName == nil || *p.FullName != "Иванов Иван" {
		t.Fatalf("ФИО не обрезано: %v", p.FullName)
	}
	if p.Profession != nil {
		t.Fatalf("пустая профессия сохранена: %q", *p.Profession)
	}
	if p.Occupation == nil || p.CompanyName != nil || p.Industry != nil || p.JobPosition != nil {
		t.Fatalf("поля чужой вкладки не отброшены: %+v", p)
	}
}

func TestSaveSignupProfile_Handler(t *testing.T) {
	user := User{ID: domain.NewID()}
	svc := &fakeAuthService{user: user}
	h := NewHandler(svc, ratelimit.AllowAll{}, ratelimit.AllowAll{}, false, testAppOrigin, false).
		WithAccount(AccountLimits{
			PasswordChange: ratelimit.AllowAll{}, TwoFactor: ratelimit.AllowAll{},
			DeleteAccount: ratelimit.AllowAll{}, Avatar: ratelimit.AllowAll{},
		})
	mux := http.NewServeMux()
	h.AccountRoutes(mux)

	req := sessionRequest(http.MethodPut, "/api/v1/account/signup-profile",
		`{"kind":"person","purpose":null,"referral":"search","fullName":"Иванов Иван","occupation":"study","profession":"дизайнер","companyName":null,"industry":null,"jobPosition":null}`)
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d; тело = %s", rec.Code, rec.Body)
	}
	p := svc.signupProfile
	if svc.signupProfileUser != user.ID || p.Kind == nil || *p.Kind != "person" || p.Purpose != nil || p.Referral == nil || *p.Referral != "search" ||
		p.FullName == nil || *p.FullName != "Иванов Иван" || p.Profession == nil || *p.Profession != "дизайнер" {
		t.Fatalf("до сервиса дошло %s %+v", svc.signupProfileUser, p)
	}
}
