//go:build integration

package forms_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// Раздел «Персональные данные» (design/privacy-consent.md): сохранение пишет ревизию и
// действует на опубликованной форме без перепубликации, документ ревизии живёт после
// правок, дубликат уносит согласие, удаление формы уносит ревизии.

type consentDTO struct {
	Enabled  bool `json:"enabled"`
	Operator struct {
		Name    string `json:"name"`
		Address string `json:"address"`
		Email   string `json:"email"`
	} `json:"operator"`
	Consent struct {
		Mode string `json:"mode"`
	} `json:"consent"`
	RevisionID *string `json:"revisionId"`
}

type consentDocDTO struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

const consentBody = `{"enabled":true,"operator":{"name":"ООО «Ромашка»","inn":"","address":"Казань","email":"pd@romashka.ru"},` +
	`"purpose":"","retention":"","consent":{"mode":"template","text":""},"policy":{"mode":"template","text":""}}`

func putConsent(t *testing.T, c *http.Client, url, body string, wantStatus int) consentDTO {
	t.Helper()
	r := do(t, c, http.MethodPut, url, body, csrfFromURL(t, c, url))
	if r.StatusCode != wantStatus {
		t.Fatalf("PUT consent: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	var dto consentDTO
	if wantStatus == http.StatusOK {
		decode(t, r, &dto)
	} else {
		closeBody(t, r)
	}
	return dto
}

// csrfFromURL — csrf по адресу сервера, выделенному из полного адреса ручки.
func csrfFromURL(t *testing.T, c *http.Client, full string) string {
	t.Helper()
	return csrf(t, c, full[:strings.Index(full, "/api/")])
}

func getConsentDocument(t *testing.T, url string, wantStatus int) consentDocDTO {
	t.Helper()
	r := do(t, newClient(t), http.MethodGet, url, "", "")
	if r.StatusCode != wantStatus {
		t.Fatalf("GET %s: статус %d, ожидалось %d; тело=%s", url, r.StatusCode, wantStatus, body2(t, r))
	}
	var doc consentDocDTO
	if wantStatus == http.StatusOK {
		decode(t, r, &doc)
	} else {
		closeBody(t, r)
	}
	return doc
}

func TestForms_Consent(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-consent@example.com")
	bob := registerUser(t, srv, "bob-consent@example.com")

	form := createForm(t, alice, srv, "Запись")
	schema := `{"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Телефон"}]},{"id":"b1","groupId":"g_b1","type":"phone","settings":{}}]}`
	patchDraftSchema(t, alice, srv, form.ID, schema, form.UpdatedAt, http.StatusOK)
	publishForm(t, alice, srv, form.ID, http.StatusOK)
	consentURL := srv.URL + "/api/v1/forms/" + form.ID + "/consent"

	// Раздел не сохраняли — выключен, ревизии нет, на форме галочки нет.
	r := do(t, alice, http.MethodGet, consentURL, "", "")
	var initial consentDTO
	decode(t, r, &initial)
	if initial.Enabled || initial.RevisionID != nil || initial.Consent.Mode != "template" {
		t.Fatalf("начальное состояние: %+v", initial)
	}
	if pub, _ := getPublicConsent(t, srv.URL, form.Slug); pub != nil {
		t.Fatalf("до включения в публичной форме ревизия %s", *pub)
	}

	// Включённое без адреса не сохраняется.
	putConsent(t, alice, consentURL, strings.Replace(consentBody, `"Казань"`, `""`, 1), http.StatusUnprocessableEntity)
	// Чужой форме — 404, как у всего приватного.
	putConsent(t, bob, consentURL, consentBody, http.StatusNotFound)

	saved := putConsent(t, alice, consentURL, consentBody, http.StatusOK)
	if !saved.Enabled || saved.RevisionID == nil {
		t.Fatalf("сохранённое: %+v", saved)
	}
	// Без перепубликации: опубликованная форма сразу несёт ревизию.
	pubRev, etag := getPublicConsent(t, srv.URL, form.Slug)
	if pubRev == nil || *pubRev != *saved.RevisionID {
		t.Fatalf("ревизия в публичной форме = %v, ожидалась %s", pubRev, *saved.RevisionID)
	}

	docURL := srv.URL + "/public/v1/forms/" + form.Slug + "/documents/consent?revision=" + *saved.RevisionID
	first := getConsentDocument(t, docURL, http.StatusOK)
	for _, want := range []string{"ООО «Ромашка», адрес: Казань", "«Телефон»", "pd@romashka.ru"} {
		if !strings.Contains(first.Text, want) {
			t.Errorf("в документе нет %q:\n%s", want, first.Text)
		}
	}

	// Повтор без изменений — та же ревизия; правка реквизитов — новая, и документ
	// старой ревизии показывает прежний текст.
	if again := putConsent(t, alice, consentURL, consentBody, http.StatusOK); *again.RevisionID != *saved.RevisionID {
		t.Fatalf("повтор без изменений дал новую ревизию %s", *again.RevisionID)
	}
	edited := putConsent(t, alice, consentURL, strings.Replace(consentBody, "Казань", "Самара", 1), http.StatusOK)
	if *edited.RevisionID == *saved.RevisionID {
		t.Fatal("правка реквизитов не дала новой ревизии")
	}
	if old := getConsentDocument(t, docURL, http.StatusOK); old.Text != first.Text {
		t.Fatalf("документ старой ревизии изменился после правки:\n%s", old.Text)
	}
	newDoc := getConsentDocument(t, srv.URL+"/public/v1/forms/"+form.Slug+"/documents/policy?revision="+*edited.RevisionID, http.StatusOK)
	if !strings.Contains(newDoc.Text, "Самара") {
		t.Fatalf("политика новой ревизии без нового адреса:\n%s", newDoc.Text)
	}
	if _, etag2 := getPublicConsent(t, srv.URL, form.Slug); etag2 == etag {
		t.Fatal("ETag публичной формы не сменился с новой ревизией")
	}

	// Выключение: галочки нет, документ выключенной ревизии не отдаётся, реквизиты целы.
	off := putConsent(t, alice, consentURL, strings.Replace(consentBody, `"enabled":true`, `"enabled":false`, 1), http.StatusOK)
	if off.Enabled || off.Operator.Address != "Казань" {
		t.Fatalf("выключенное: %+v", off)
	}
	if pub, _ := getPublicConsent(t, srv.URL, form.Slug); pub != nil {
		t.Fatalf("выключенное согласие осталось в публичной форме: %s", *pub)
	}
	getConsentDocument(t, srv.URL+"/public/v1/forms/"+form.Slug+"/documents/consent?revision="+*off.RevisionID, http.StatusNotFound)

	// Дубликат уносит согласие своей ревизией.
	putConsent(t, alice, consentURL, consentBody, http.StatusOK)
	dup := duplicateForm(t, alice, srv, form.ID, http.StatusCreated)
	r = do(t, alice, http.MethodGet, srv.URL+"/api/v1/forms/"+dup.ID+"/consent", "", "")
	var dupConsent consentDTO
	decode(t, r, &dupConsent)
	if !dupConsent.Enabled || dupConsent.RevisionID == nil || dupConsent.Operator.Name != "ООО «Ромашка»" {
		t.Fatalf("согласие копии: %+v", dupConsent)
	}

	// Удаление формы уносит её ревизии (кольцевые внешние ключи не мешают).
	deleteForm(t, alice, srv, form.ID, http.StatusNoContent)
	var orphans int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM form_consent_revisions r WHERE NOT EXISTS (SELECT 1 FROM forms f WHERE f.id = r.form_id)`).Scan(&orphans); err != nil || orphans != 0 {
		t.Fatalf("после удаления формы осталось ревизий-сирот: %d (%v)", orphans, err)
	}
}

func TestForms_ConsentPreview(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-preview@example.com")
	form := createForm(t, alice, srv, "Анкета гостя")

	url := srv.URL + "/api/v1/forms/" + form.ID + "/consent/preview"
	body := `{"operator":{"name":"ИП Иванов","inn":"123456789012","address":"Тула","email":"i@example.com"},` +
		`"purpose":"","retention":"","consent":{"mode":"template","text":""},"policy":{"mode":"custom","text":"Своя политика"}}`
	r := do(t, alice, http.MethodPost, url, body, csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusOK {
		t.Fatalf("preview: статус %d; тело=%s", r.StatusCode, body2(t, r))
	}
	var preview struct {
		Consent consentDocDTO `json:"consent"`
		Policy  consentDocDTO `json:"policy"`
	}
	decode(t, r, &preview)
	if !strings.Contains(preview.Consent.Text, "ИП Иванов, ИНН 123456789012, адрес: Тула") ||
		!strings.Contains(preview.Consent.Text, "«Анкета гостя»") {
		t.Fatalf("предпросмотр согласия:\n%s", preview.Consent.Text)
	}
	if preview.Policy.Text != "Своя политика" {
		t.Fatalf("свой текст политики = %q", preview.Policy.Text)
	}
	// Предпросмотр ничего не сохраняет.
	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM form_consent_revisions`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("предпросмотр записал ревизий: %d (%v)", n, err)
	}
}

// getPublicConsent — ревизия согласия и ETag публичной формы.
func getPublicConsent(t *testing.T, base, slug string) (*string, string) {
	t.Helper()
	r := do(t, newClient(t), http.MethodGet, base+"/public/v1/forms/"+slug, "", "")
	if r.StatusCode != http.StatusOK {
		t.Fatalf("GET public: статус %d; тело=%s", r.StatusCode, body2(t, r))
	}
	var pub struct {
		ConsentRevision *string `json:"consentRevision"`
	}
	etag := r.Header.Get("ETag")
	if err := json.NewDecoder(r.Body).Decode(&pub); err != nil {
		t.Fatalf("decode public: %v", err)
	}
	closeBody(t, r)
	return pub.ConsentRevision, etag
}
