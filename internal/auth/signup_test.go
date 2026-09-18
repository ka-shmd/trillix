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
		name        string
		first, last string
		p           SignupProfile
		ok          bool
	}{
		{"всё пропущено", "", "", SignupProfile{}, true},
		{"частное лицо целиком", "Иван", "Иванов", SignupProfile{Kind: str("person"), Occupation: str("freelance"), Profession: str("дизайнер"), Purpose: str("leads"), Referral: str("article")}, true},
		{"компания целиком", "Иван", "Иванов", SignupProfile{Kind: str("company"), CompanyName: str("ООО «Ромашка»"), Industry: str("it"), JobPosition: str("owner")}, true},
		{"чужой вид", "", "", SignupProfile{Kind: str("robot")}, false},
		{"чужая цель", "", "", SignupProfile{Purpose: str("")}, false},
		{"чужой источник", "", "", SignupProfile{Referral: str("tv")}, false},
		{"чужое занятие", "", "", SignupProfile{Kind: str("person"), Occupation: str("pilot")}, false},
		{"чужая сфера", "", "", SignupProfile{Kind: str("company"), Industry: str("space")}, false},
		{"чужая должность", "", "", SignupProfile{Kind: str("company"), JobPosition: str("ceo")}, false},
		{"имя длиннее 100", strings.Repeat("я", 101), "", SignupProfile{}, false},
		{"фамилия длиннее 100", "", strings.Repeat("я", 101), SignupProfile{}, false},
		{"профессия длиннее 100", "", "", SignupProfile{Kind: str("person"), Profession: str(strings.Repeat("я", 101))}, false},
		{"название длиннее 300", "", "", SignupProfile{Kind: str("company"), CompanyName: str(strings.Repeat("я", 301))}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeStore{}
			err := newService(store).SaveSignupProfile(context.Background(), domain.NewID(), tc.first, tc.last, tc.p)
			saved := store.signupProfile != nil
			if tc.ok && (err != nil || !saved || !store.profileUpdated) {
				t.Fatalf("err = %v, анкета = %v, имя = %v", err, saved, store.profileUpdated)
			}
			// Отказ не пишет ни анкету, ни имя: половина экрана без другой не сохраняется.
			if !tc.ok && (!errors.Is(err, domain.ErrValidation) || saved || store.profileUpdated) {
				t.Fatalf("err = %v, анкета = %v, имя = %v", err, saved, store.profileUpdated)
			}
		})
	}
}

func TestSaveSignupProfile_Normalizes(t *testing.T) {
	str := func(s string) *string { return &s }
	store := &fakeStore{}
	userID := domain.NewID()
	// Человек заполнил вкладку компании, переключился на частное лицо и отправил.
	err := newService(store).SaveSignupProfile(context.Background(), userID, "  Иван  ", "   ", SignupProfile{
		Kind: str("person"), Profession: str("   "),
		CompanyName: str("ООО «Ромашка»"), Industry: str("it"), JobPosition: str("owner"), Occupation: str("study"),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Имя — в профиль аккаунта, обрезанным; пустая фамилия стирается, а не пишется пробелами.
	if store.profileUser != userID || store.profileFirstName == nil || *store.profileFirstName != "Иван" || store.profileLastName != nil {
		t.Fatalf("в профиль ушло %s %v %v", store.profileUser, store.profileFirstName, store.profileLastName)
	}
	p := store.signupProfile
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
		`{"firstName":"Иван","lastName":"Иванов","kind":"person","purpose":null,"referral":"search","occupation":"study","profession":"дизайнер","companyName":null,"industry":null,"jobPosition":null}`)
	req.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "tok"})
	req.Header.Set(csrfHeaderName, "tok")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("статус = %d; тело = %s", rec.Code, rec.Body)
	}
	p := svc.signupProfile
	if svc.signupProfileUser != user.ID || svc.signupFirstName != "Иван" || svc.signupLastName != "Иванов" ||
		p.Kind == nil || *p.Kind != "person" || p.Purpose != nil || p.Referral == nil || *p.Referral != "search" ||
		p.Profession == nil || *p.Profession != "дизайнер" {
		t.Fatalf("до сервиса дошло %s %q %q %+v", svc.signupProfileUser, svc.signupFirstName, svc.signupLastName, p)
	}
}
