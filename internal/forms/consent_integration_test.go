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
	Documents  string  `json:"documents"`
	RevisionID *string `json:"revisionId"`
}

type consentDocDTO struct {
	Title string `json:"title"`
	Text  string `json:"text"`
}

const consentBody = `{"enabled":true,"operator":{"name":"ООО «Ромашка»","inn":"","address":"Казань","email":"pd@romashka.ru"},` +
	`"purpose":"","retention":"","documents":"template","consentText":"","policyText":""}`

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
	if initial.Enabled || initial.RevisionID != nil || initial.Documents != "template" {
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
	preview := func(body string) (consent, policy consentDocDTO) {
		t.Helper()
		r := do(t, alice, http.MethodPost, url, body, csrf(t, alice, srv.URL))
		if r.StatusCode != http.StatusOK {
			t.Fatalf("preview: статус %d; тело=%s", r.StatusCode, body2(t, r))
		}
		var out struct {
			Consent consentDocDTO `json:"consent"`
			Policy  consentDocDTO `json:"policy"`
		}
		decode(t, r, &out)
		return out.Consent, out.Policy
	}
	operator := `{"operator":{"name":"ИП Иванов","inn":"123456789012","address":"Тула","email":"i@example.com"},"purpose":"","retention":"",`

	consent, _ := preview(operator + `"documents":"template","consentText":"","policyText":"Своя политика"}`)
	if !strings.Contains(consent.Text, "ИП Иванов, ИНН 123456789012, адрес: Тула") ||
		!strings.Contains(consent.Text, "«Анкета гостя»") {
		t.Fatalf("предпросмотр согласия:\n%s", consent.Text)
	}
	if _, policy := preview(operator + `"documents":"custom","consentText":"Своё","policyText":"Своя политика"}`); policy.Text != "Своя политика" {
		t.Fatalf("свой текст политики = %q", policy.Text)
	}
	// Предпросмотр ничего не сохраняет.
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT (SELECT count(*) FROM form_consent_revisions) + (SELECT count(*) FROM consent_operators)`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("предпросмотр записал ревизий: %d (%v)", n, err)
	}
}

type consentOperatorDTO struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	INN     string `json:"inn"`
	Address string `json:"address"`
	Email   string `json:"email"`
}

func listConsentOperators(t *testing.T, c *http.Client, base, workspaceID string, wantStatus int) []consentOperatorDTO {
	t.Helper()
	r := do(t, c, http.MethodGet, base+"/api/v1/workspaces/"+workspaceID+"/consent-operators", "", "")
	if r.StatusCode != wantStatus {
		t.Fatalf("GET consent-operators: статус %d, ожидалось %d; тело=%s", r.StatusCode, wantStatus, body2(t, r))
	}
	if wantStatus != http.StatusOK {
		closeBody(t, r)
		return nil
	}
	var out struct {
		Items []consentOperatorDTO `json:"items"`
	}
	decode(t, r, &out)
	return out.Items
}

// Список реквизитов пространства (design/privacy-consent.md §3.6): пополняется
// сохранением типового включённого согласия, не дублирует, не виден чужим, строка
// убирается без последствий для форм.
func TestForms_ConsentOperators(t *testing.T) {
	resetDB(t)
	srv := newStack(t)
	alice := registerUser(t, srv, "alice-operators@example.com")
	bob := registerUser(t, srv, "bob-operators@example.com")

	first := createForm(t, alice, srv, "Первая")
	second := createForm(t, alice, srv, "Вторая")
	var ws string
	if err := testPool.QueryRow(context.Background(),
		`SELECT workspace_id::text FROM forms WHERE id = $1`, first.ID).Scan(&ws); err != nil {
		t.Fatalf("пространство формы: %v", err)
	}
	consentURL := func(formID string) string { return srv.URL + "/api/v1/forms/" + formID + "/consent" }

	if got := listConsentOperators(t, alice, srv.URL, ws, http.StatusOK); len(got) != 0 {
		t.Fatalf("список до сохранений: %+v", got)
	}

	putConsent(t, alice, consentURL(first.ID), consentBody, http.StatusOK)
	putConsent(t, alice, consentURL(second.ID), consentBody, http.StatusOK)
	got := listConsentOperators(t, alice, srv.URL, ws, http.StatusOK)
	if len(got) != 1 || got[0].Name != "ООО «Ромашка»" || got[0].Address != "Казань" || got[0].Email != "pd@romashka.ru" {
		t.Fatalf("тот же набор из двух форм: %+v", got)
	}

	// Другой адрес — второй набор, и он свежее. Выключенное и свои документы не пишут.
	putConsent(t, alice, consentURL(second.ID), strings.Replace(consentBody, "Казань", "Самара", 1), http.StatusOK)
	putConsent(t, alice, consentURL(first.ID),
		strings.NewReplacer(`"enabled":true`, `"enabled":false`, "Ромашка", "Выключенная").Replace(consentBody), http.StatusOK)
	putConsent(t, alice, consentURL(first.ID),
		strings.NewReplacer("Ромашка", "Своя", `"documents":"template","consentText":"","policyText":""`,
			`"documents":"custom","consentText":"С","policyText":"П"`).Replace(consentBody), http.StatusOK)
	got = listConsentOperators(t, alice, srv.URL, ws, http.StatusOK)
	if len(got) != 2 || got[0].Address != "Самара" || got[1].Address != "Казань" {
		t.Fatalf("после второго набора: %+v", got)
	}

	// Наименование и адрес на потолке длины — строка индекса не упирается в предел btree.
	long := strings.NewReplacer("ООО «Ромашка»", strings.Repeat("Я", 300), "Казань", strings.Repeat("Ж", 500)).Replace(consentBody)
	putConsent(t, alice, consentURL(second.ID), long, http.StatusOK)
	putConsent(t, alice, consentURL(first.ID), long, http.StatusOK)
	if got = listConsentOperators(t, alice, srv.URL, ws, http.StatusOK); len(got) != 3 {
		t.Fatalf("длинный набор дважды: %d строк, ожидалось 3", len(got))
	}

	// Чужому — 404 и на список, и на удаление.
	listConsentOperators(t, bob, srv.URL, ws, http.StatusNotFound)
	delURL := srv.URL + "/api/v1/consent-operators/" + got[2].ID
	if r := do(t, bob, http.MethodDelete, delURL, "", csrf(t, bob, srv.URL)); r.StatusCode != http.StatusNotFound {
		t.Fatalf("DELETE чужого: статус %d", r.StatusCode)
	} else {
		closeBody(t, r)
	}

	r := do(t, alice, http.MethodDelete, delURL, "", csrf(t, alice, srv.URL))
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE: статус %d; тело=%s", r.StatusCode, body2(t, r))
	}
	closeBody(t, r)
	if got = listConsentOperators(t, alice, srv.URL, ws, http.StatusOK); len(got) != 2 {
		t.Fatalf("после удаления: %+v", got)
	}
	// Удаление строки списка форму не трогает: реквизиты второй формы на месте.
	r = do(t, alice, http.MethodGet, consentURL(second.ID), "", "")
	var kept consentDTO
	decode(t, r, &kept)
	if kept.Operator.Address != strings.Repeat("Ж", 500) {
		t.Fatalf("реквизиты формы после удаления из списка: %+v", kept.Operator)
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
