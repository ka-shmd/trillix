package forms

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Согласие в публичной отдаче (design/privacy-consent.md §3.4–3.5): id включённой
// ревизии едет в теле и в ETag, документ отдаётся своей ручкой с видимостью формы.

func TestPublicGet_ConsentRevision_InBodyAndETag(t *testing.T) {
	svc := brandingForm(t, false, true)
	etagOf := func() (string, *string) {
		rec, body := getPublicJSON(t, svc)
		return rec.Header().Get("ETag"), body.ConsentRevision
	}

	without, rev := etagOf()
	if rev != nil {
		t.Fatalf("без согласия в теле ревизия %q", *rev)
	}
	first, second := domain.NewID(), domain.NewID()
	svc.pf.ConsentRevisionID = &first
	withFirst, rev := etagOf()
	if rev == nil || *rev != first.String() {
		t.Fatalf("ревизия в теле = %v, ожидалась %s", rev, first)
	}
	svc.pf.ConsentRevisionID = &second
	withSecond, _ := etagOf()

	// Новая ревизия обязана менять ETag: иначе 304 оставил бы у открывавших форму старый
	// id, и ответ ушёл бы с ревизией, которая больше не текущая.
	if without == withFirst || withFirst == withSecond {
		t.Fatalf("ETag не следует за ревизией: %q, %q, %q", without, withFirst, withSecond)
	}
}

func getConsentDoc(t *testing.T, svc fakePublicSvc, target, unlock string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if unlock != "" {
		req.Header.Set(UnlockHeader, unlock)
	}
	rec := httptest.NewRecorder()
	newPublicMux(t, svc).ServeHTTP(rec, req)
	return rec
}

func TestPublicConsentDocument_Route(t *testing.T) {
	svc := brandingForm(t, false, true)
	rev := domain.NewID()
	svc.pf.ConsentRevisionID = &rev
	base := "/public/v1/forms/abc/documents/policy?revision=" + rev.String()

	rec := getConsentDoc(t, svc, base+"&version=3", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("статус %d, тело %s", rec.Code, rec.Body)
	}
	var body consentDocumentBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("тело не парсится: %v", err)
	}
	if body.Title != "policy" || body.Text != "версия 3" {
		t.Fatalf("вид документа или версия не доехали до сервиса: %+v", body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, ожидался no-store", got)
	}

	for name, target := range map[string]string{
		"битая ревизия":        "/public/v1/forms/abc/documents/policy?revision=nope",
		"чужая ревизия":        "/public/v1/forms/abc/documents/policy?revision=" + domain.NewID().String(),
		"версия не числом":     base + "&version=x",
		"версия ноль":          base + "&version=0",
		"без ревизии в адресе": "/public/v1/forms/abc/documents/consent",
	} {
		if rec := getConsentDoc(t, svc, target, ""); rec.Code != http.StatusNotFound {
			t.Errorf("%s: статус %d, ожидался 404", name, rec.Code)
		}
	}

	svc.pf.PasswordSealed = []byte("sealed")
	if rec := getConsentDoc(t, svc, base, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("форма под паролем без токена: статус %d, ожидался 401", rec.Code)
	}
	if rec := getConsentDoc(t, svc, base, testUnlockToken); rec.Code != http.StatusOK {
		t.Errorf("форма под паролем с токеном: статус %d, ожидался 200", rec.Code)
	}
}
