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
