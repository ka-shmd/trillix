//go:build integration

package submissions_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Фильтр сводки (спека design/analytics-v2.md §6.2) через HTTP: сводка считается по
// прошедшим фильтр, unfiltered — полное число в окне; тот же фильтр режет окно «все
// ответы»; условие не о вопросе формы — 422; закрытый тариф — 402.
func TestSummary_Filter(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)
	v1 := versionID(t, formID, 1)

	insertAnswer(t, formID, v1, `{"b_src":"o1","b_rate":"5","b_note":"дорого"}`)
	insertAnswer(t, formID, v1, `{"b_src":"o1","b_rate":"3","b_note":"удобно"}`)
	insertAnswer(t, formID, v1, `{"b_src":"o2","b_rate":"1","b_note":"долго"}`)

	get := func(path string, filter domain.AnswerFilter) *http.Response {
		t.Helper()
		url := srv.URL + "/api/v1/forms/" + formID.String() + path
		if filter != nil {
			url += "?where=" + domain.EncodeAnswerFilter(filter)
		}
		resp, err := owner.Get(url)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		t.Cleanup(func() { _ = resp.Body.Close() })
		return resp
	}

	friends := domain.AnswerFilter{{BlockID: "b_src", Op: domain.OpIs, Value: "o1"}}
	resp := get("/submissions/summary", friends)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d", resp.StatusCode)
	}
	var body struct {
		summaryBody
		Unfiltered *int `json:"unfiltered"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Total != 2 || body.Unfiltered == nil || *body.Unfiltered != 3 {
		t.Errorf("в выборке %d из %v, ждали 2 из 3", body.Total, body.Unfiltered)
	}
	if _, rate := body.block(t, "b_rate"); rate["1"] != 0 || rate["5"] != 1 || rate["3"] != 1 {
		t.Errorf("шкала в выборке: %v", rate)
	}

	notes := get("/submissions/summary/b_note", friends)
	var page struct {
		Answers []struct{ Text string } `json:"answers"`
	}
	if err := json.NewDecoder(notes.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	if len(page.Answers) != 2 {
		t.Errorf("окно «все ответы» с фильтром: %+v", page.Answers)
	}

	if r := get("/submissions/summary", domain.AnswerFilter{{BlockID: "ghost", Op: domain.OpAnswered}}); r.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("условие не о вопросе: статус %d, ждали 422", r.StatusCode)
	}

	if _, err := testPool.Exec(context.Background(),
		`UPDATE plans SET limits = jsonb_set(limits, '{analytics_segments}', 'false')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `UPDATE plans SET limits = jsonb_set(limits, '{analytics_segments}', 'true')`)
	})
	if r := get("/submissions/summary", friends); r.StatusCode != http.StatusPaymentRequired {
		t.Errorf("фильтр при закрытом тарифе: статус %d, ждали 402", r.StatusCode)
	}
	if r := get("/submissions/summary", nil); r.StatusCode != http.StatusOK {
		t.Errorf("сводка без фильтра при закрытых сегментах: статус %d", r.StatusCode)
	}
}

// Таблица сопряжённости через HTTP: клетки, итог, фильтр режет и её; открытый вопрос
// — 422; закрытый тариф — 402.
func TestCrosstab_EndToEnd(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)
	v1 := versionID(t, formID, 1)
	insertAnswer(t, formID, v1, `{"b_src":"o1","b_rate":"5"}`)
	insertAnswer(t, formID, v1, `{"b_src":"o1","b_rate":"4"}`)
	insertAnswer(t, formID, v1, `{"b_src":"o2","b_rate":"5"}`)
	insertAnswer(t, formID, v1, `{"b_rate":"1"}`)

	get := func(query string) *http.Response {
		t.Helper()
		resp, err := owner.Get(srv.URL + "/api/v1/forms/" + formID.String() + "/submissions/crosstab?" + query)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = resp.Body.Close() })
		return resp
	}
	resp := get("rows=b_src&cols=b_rate")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("статус %d", resp.StatusCode)
	}
	var body struct {
		Rows []struct {
			Key   string `json:"key"`
			Label string `json:"label"`
			Total int    `json:"total"`
		} `json:"rows"`
		Cells [][]int `json:"cells"`
		Total int     `json:"total"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	// Строки: Друзья, Поиск; столбцы — деления 1..5.
	if body.Total != 3 || body.Rows[0].Label != "Друзья" || body.Rows[0].Total != 2 ||
		body.Cells[0][4] != 1 || body.Cells[0][3] != 1 || body.Cells[1][4] != 1 {
		t.Errorf("таблица: %+v", body)
	}

	filtered := get("rows=b_src&cols=b_rate&where=" + domain.EncodeAnswerFilter(domain.AnswerFilter{{BlockID: "b_rate", Op: domain.OpGte, Value: "5"}}))
	var fb struct {
		Total int `json:"total"`
	}
	if err := json.NewDecoder(filtered.Body).Decode(&fb); err != nil || fb.Total != 2 {
		t.Errorf("с фильтром: %d, %v", fb.Total, err)
	}
	if r := get("rows=b_src&cols=b_note"); r.StatusCode != http.StatusUnprocessableEntity {
		t.Errorf("открытый вопрос: статус %d, ждали 422", r.StatusCode)
	}
	if _, err := testPool.Exec(context.Background(), `UPDATE plans SET limits = jsonb_set(limits, '{analytics_segments}', 'false')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = testPool.Exec(context.Background(), `UPDATE plans SET limits = jsonb_set(limits, '{analytics_segments}', 'true')`)
	})
	if r := get("rows=b_src&cols=b_rate"); r.StatusCode != http.StatusPaymentRequired {
		t.Errorf("закрытый тариф: статус %d, ждали 402", r.StatusCode)
	}
}

// Ответ знает свой визит (0076) и получает разрез по нему: приём сохраняет visit_id,
// сегмент по устройству режет сводку, выборка меньше domain.SegmentK не раскрывается
// ни в сводке, ни в окне «все ответы», ни в таблице; ответ без визита в визитный
// сегмент не попадает, в сегмент версии — попадает.
func TestSummary_VisitSegment(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	formID := publishSummaryForm(t, ownerID)
	v1 := versionID(t, formID, 1)
	ctx := context.Background()
	var slug string
	if err := testPool.QueryRow(ctx, `SELECT slug FROM forms WHERE id = $1`, formID).Scan(&slug); err != nil {
		t.Fatal(err)
	}
	const phone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	const desktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

	answer := func(ua string) {
		t.Helper()
		visit := domain.NewID()
		if _, err := testPool.Exec(ctx, `INSERT INTO form_visits (id, form_id, form_version_id, seq, meta) VALUES ($1, $2, $3, 0, jsonb_build_object('user_agent', $4::text))`,
			visit, formID, v1, ua); err != nil {
			t.Fatal(err)
		}
		body := `{"submission_id":"` + domain.NewID().String() + `","token":"` + freshToken() + `","answers":{"b_rate":"5"},"visit_id":"` + visit.String() + `"}`
		if resp := postSubmission(t, srv, slug, body); resp.StatusCode != http.StatusCreated {
			t.Fatalf("приём ответа: %d", resp.StatusCode)
		}
	}
	for i := 0; i < 5; i++ {
		answer(phone)
	}
	answer(desktop)
	insertAnswer(t, formID, v1, `{"b_rate":"3"}`) // без визита

	var linked int
	if err := testPool.QueryRow(ctx, `SELECT count(*) FROM submissions WHERE form_id = $1 AND visit_id IS NOT NULL`, formID).Scan(&linked); err != nil || linked != 6 {
		t.Fatalf("ответов с визитом %d, ждали 6 (%v)", linked, err)
	}

	type summaryResp struct {
		Total      int  `json:"total"`
		Unfiltered *int `json:"unfiltered"`
		Withheld   bool `json:"withheld"`
		Blocks     []struct {
			BlockID string `json:"blockId"`
		} `json:"blocks"`
	}
	get := func(path, segment string, out any) {
		t.Helper()
		resp, err := owner.Get(srv.URL + "/api/v1/forms/" + formID.String() + path + "segment=" + segment)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s %s: статус %d", path, segment, resp.StatusCode)
		}
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			t.Fatal(err)
		}
	}

	var phones summaryResp
	get("/submissions/summary?", "device:%D0%A2%D0%B5%D0%BB%D0%B5%D1%84%D0%BE%D0%BD", &phones)
	if phones.Withheld || phones.Total != 5 || phones.Unfiltered == nil || *phones.Unfiltered != 7 {
		t.Errorf("телефоны: %+v", phones)
	}
	var desktops summaryResp
	get("/submissions/summary?", "device:%D0%9A%D0%BE%D0%BC%D0%BF%D1%8C%D1%8E%D1%82%D0%B5%D1%80", &desktops)
	if !desktops.Withheld || desktops.Total != 0 || len(desktops.Blocks) != 0 {
		t.Errorf("один компьютер раскрыт: %+v", desktops)
	}
	var version summaryResp
	get("/submissions/summary?", "version:1", &version)
	if version.Withheld || version.Total != 7 {
		t.Errorf("версия 1 (ответ без визита входит): %+v", version)
	}

	// Условий разреза бывает несколько, и они складываются через «И» (спека
	// analytics-v3.md §11.6). У ответов проверка идёт в Go по меткам визита:
	// «телефоны версии 1» — те же пять, «телефоны версии 2» — ни одного.
	const segPhone = "device:%D0%A2%D0%B5%D0%BB%D0%B5%D1%84%D0%BE%D0%BD"
	var phoneV1 summaryResp
	get("/submissions/summary?", segPhone+"&segment=version:1", &phoneV1)
	if phoneV1.Withheld || phoneV1.Total != 5 {
		t.Errorf("телефоны версии 1: %+v", phoneV1)
	}
	var phoneV2 summaryResp
	get("/submissions/summary?", segPhone+"&segment=version:2", &phoneV2)
	if phoneV2.Total != 0 || len(phoneV2.Blocks) != 0 {
		t.Errorf("телефоны версии 2 (таких нет): %+v", phoneV2)
	}

	var page struct {
		Answers  []any `json:"answers"`
		Withheld bool  `json:"withheld"`
	}
	get("/submissions/summary/b_rate?", "device:%D0%9A%D0%BE%D0%BC%D0%BF%D1%8C%D1%8E%D1%82%D0%B5%D1%80", &page)
	if !page.Withheld || len(page.Answers) != 0 {
		t.Errorf("окно «все ответы» раскрыло малую выборку: %+v", page)
	}
	var table struct {
		Total    int  `json:"total"`
		Withheld bool `json:"withheld"`
	}
	get("/submissions/crosstab?rows=b_src&cols=b_rate&", "device:%D0%9A%D0%BE%D0%BC%D0%BF%D1%8C%D1%8E%D1%82%D0%B5%D1%80", &table)
	if !table.Withheld {
		t.Errorf("таблица раскрыла малую выборку: %+v", table)
	}
}
