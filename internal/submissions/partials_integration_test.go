//go:build integration

// Интеграционные тесты незавершённых ответов против настоящего Postgres: вертикаль
// «включить тумблер → автосохранить → пролистать в кабинете → удалить один» плюс
// вкладка «Все ответы», где оба множества склеены в одну ленту.
//
// Юнитом не покрыть ни составной курсор (он сходится или не сходится только на живом
// ORDER BY), ни UNION ALL двух выборок, ни гейт тарифа — он решается живыми
// таблицами plans/subscriptions.
package submissions_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

type partialsResp struct {
	Partials []struct {
		VisitID     string          `json:"visitId"`
		FormVersion int32           `json:"formVersion"`
		LastBlockID string          `json:"lastBlockId"`
		Answers     json.RawMessage `json:"answers"`
	} `json:"partials"`
	NextCursor *string `json:"nextCursor"`
	Total      int64   `json:"total"`
}

// getPartials — страница черновиков по 2 (как listing-тест ответов: маленький limit
// заставляет курсор реально работать, а не срабатывать один раз).
func getPartials(t *testing.T, c *http.Client, srv *httptest.Server, formID, cursor string) partialsResp {
	t.Helper()
	u := srv.URL + "/api/v1/forms/" + formID + "/partials?limit=2"
	if cursor != "" {
		u += "&cursor=" + cursor
	}
	resp, err := c.Get(u)
	if err != nil {
		t.Fatalf("get partials: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get partials: статус %d, ожидалось 200", resp.StatusCode)
	}
	var out partialsResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode partials: %v", err)
	}
	return out
}

// Пять черновиков листаются страницами по 2, новыми сверху, без дублей и потерь на
// границах; total = 5 на каждой странице; набранное доезжает до кабинета целиком.
func TestListPartials_Pagination(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	setCollectPartial(t, fid, true)

	// Порядок автосохранения = порядок updated_at; «новые сверху» — обратный ему.
	saved := make([]string, 5)
	for i := range saved {
		visitID := uuid.NewString()
		saved[i] = visitID
		if code := savePartial(t, srv, slug, visitID, "черновик"); code != http.StatusNoContent {
			t.Fatalf("автосохранение #%d: статус %d, ожидалось 204", i, code)
		}
	}

	var got []string
	cursor := ""
	for pages := 0; ; pages++ {
		if pages > 10 {
			t.Fatal("пагинация не сходится (защита от бесконечного цикла)")
		}
		page := getPartials(t, owner, srv, fid, cursor)
		if page.Total != 5 {
			t.Fatalf("total = %d, ожидалось 5", page.Total)
		}
		for _, p := range page.Partials {
			got = append(got, p.VisitID)
			if p.FormVersion != 1 {
				t.Fatalf("formVersion = %d, ожидалась 1", p.FormVersion)
			}
			if p.LastBlockID != "b1" {
				t.Fatalf("lastBlockId = %q, ожидался b1", p.LastBlockID)
			}
			if string(p.Answers) != `{"b1":"черновик"}` {
				t.Fatalf("answers = %s, ожидалось {\"b1\":\"черновик\"}", p.Answers)
			}
		}
		if page.NextCursor == nil {
			break
		}
		if len(page.Partials) != 2 {
			t.Fatalf("непоследняя страница вернула %d строк, ожидалось 2 (limit)", len(page.Partials))
		}
		cursor = *page.NextCursor
	}

	want := make([]string, len(saved))
	for i, id := range saved {
		want[len(saved)-1-i] = id
	}
	if len(got) != len(want) {
		t.Fatalf("получено %d черновиков, ожидалось %d (дубли/потери на границах)", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("порядок разошёлся на позиции %d: получен %s, ожидался %s", i, got[i], want[i])
		}
	}
}

// Даунгрейд закрывает ПОКАЗ, а не только сбор: тумблер формы мог остаться включённым
// с прежнего плана, и листинг обязан отказать сам — 402, а не пустая страница.
func TestListPartials_PlanDenied402(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	setCollectPartial(t, fid, true)
	if code := savePartial(t, srv, slug, uuid.NewString(), "черновик"); code != http.StatusNoContent {
		t.Fatalf("автосохранение: статус %d, ожидалось 204", code)
	}

	setPartialGate(t, slug, false)

	resp, err := owner.Get(srv.URL + "/api/v1/forms/" + fid + "/partials")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("листинг без права: статус %d, ожидалось 402", resp.StatusCode)
	}
}

// Анти-IDOR: чужой пользователь получает 404, а не 402 — существование формы не
// раскрывается даже разговором о тарифе (инвариант 1).
func TestListPartials_ForeignForm_404(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	slug, _ := publishedForm(t, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	setCollectPartial(t, fid, true)

	attacker, _ := authedClient(t, srv, "attacker-"+uuid.NewString()[:8]+"@example.com")
	resp, err := attacker.Get(srv.URL + "/api/v1/forms/" + fid + "/partials")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("чужая форма: статус %d, ожидалось 404", resp.StatusCode)
	}
}

// Удаление одного черновика владельцем (спека §10.6): строка уходит, остальные
// остаются, повторное удаление — 404.
func TestDeletePartial_RemovesOne(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	setCollectPartial(t, fid, true)

	victim := uuid.NewString()
	for _, visitID := range []string{uuid.NewString(), victim} {
		if code := savePartial(t, srv, slug, visitID, "черновик"); code != http.StatusNoContent {
			t.Fatalf("автосохранение: статус %d, ожидалось 204", code)
		}
	}

	resp := deleteWithCSRF(t, owner, srv, "/api/v1/forms/"+fid+"/partials/"+victim)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("удаление: статус %d, ожидалось 204", resp.StatusCode)
	}
	if got := countPartials(t, fid); got != 1 {
		t.Fatalf("в БД %d черновиков, ожидался 1", got)
	}

	again := deleteWithCSRF(t, owner, srv, "/api/v1/forms/"+fid+"/partials/"+victim)
	if again.StatusCode != http.StatusNotFound {
		t.Fatalf("повторное удаление: статус %d, ожидалось 404", again.StatusCode)
	}
}

// --- Вкладка «Все ответы»: оба множества одним списком (спека §11) ---

type feedResp struct {
	Submissions []struct {
		Kind        string  `json:"kind"`
		ID          string  `json:"id"`
		CreatedAt   string  `json:"createdAt"`
		UpdatedAt   *string `json:"updatedAt"`
		LastBlockID string  `json:"lastBlockId"`
	} `json:"submissions"`
	NextCursor *string `json:"nextCursor"`
	Total      int64   `json:"total"`
}

func getFeed(t *testing.T, c *http.Client, srv *httptest.Server, formID, cursor string) feedResp {
	t.Helper()
	u := srv.URL + "/api/v1/forms/" + formID + "/submissions?kind=all&limit=2"
	if cursor != "" {
		u += "&cursor=" + cursor
	}
	resp, err := c.Get(u)
	if err != nil {
		t.Fatalf("get feed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get feed: статус %d, ожидалось 200", resp.StatusCode)
	}
	var out feedResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode feed: %v", err)
	}
	return out
}

// Лента склеивает два множества по времени и листается общим курсором без дублей и
// потерь на границах страниц. Порядок проверяется на чередовании: ответ, черновик,
// ответ — то, чего не даст ни одна из двух выборок по отдельности.
func TestListFeed_MergesBothStreamsInTimeOrder(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	setCollectPartial(t, fid, true)

	// Порядок событий: ответ → черновик → ответ. Лента обязана вернуть их
	// зеркально (новыми сверху).
	first := submitN(t, srv, slug, 1)[0].String()
	draft := uuid.NewString()
	if code := savePartial(t, srv, slug, draft, "черновик"); code != http.StatusNoContent {
		t.Fatalf("автосохранение: статус %d, ожидалось 204", code)
	}
	last := submitN(t, srv, slug, 1)[0].String()

	var got []string
	var kinds []string
	cursor := ""
	for pages := 0; ; pages++ {
		if pages > 10 {
			t.Fatal("пагинация не сходится (защита от бесконечного цикла)")
		}
		page := getFeed(t, owner, srv, fid, cursor)
		if page.Total != 3 {
			t.Fatalf("total = %d, ожидалось 3 (два ответа и черновик)", page.Total)
		}
		for _, row := range page.Submissions {
			got = append(got, row.ID)
			kinds = append(kinds, row.Kind)
			if row.Kind == "partial" && row.UpdatedAt == nil {
				t.Fatalf("у черновика %s нет updatedAt — колонке даты нечего показать", row.ID)
			}
			if row.Kind == "submission" && row.UpdatedAt != nil {
				t.Fatalf("у отправленного ответа %s есть updatedAt, которого не было", row.ID)
			}
		}
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}

	want := []string{last, draft, first}
	if len(got) != len(want) {
		t.Fatalf("получено %d строк, ожидалось %d (дубли/потери на границах)", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("порядок разошёлся на позиции %d: получено %s (%s), ожидалось %s", i, got[i], kinds[i], want[i])
		}
	}
}

// Форма незавершённые не собирает (тумблер снят) — «Все ответы» вырождаются в
// список отправленных. Иначе вкладка показывала бы ровно то, что прячет соседняя:
// черновики прошлого плана лежат в базе до чистки.
func TestListFeed_WithoutCollectingShowsOnlySubmissions(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)

	setCollectPartial(t, fid, true)
	if code := savePartial(t, srv, slug, uuid.NewString(), "черновик"); code != http.StatusNoContent {
		t.Fatalf("автосохранение: статус %d, ожидалось 204", code)
	}
	submitN(t, srv, slug, 1)
	setCollectPartial(t, fid, false)

	page := getFeed(t, owner, srv, fid, "")
	if page.Total != 1 {
		t.Fatalf("total = %d, ожидался 1 (только отправленный)", page.Total)
	}
	for _, row := range page.Submissions {
		if row.Kind != "submission" {
			t.Fatalf("в ленте строка вида %q, а сбор незавершённых выключен", row.Kind)
		}
	}
	if got := countPartials(t, fid); got != 1 {
		t.Fatalf("черновик пропал из базы (%d строк) — вкладка не имеет права его удалять", got)
	}
}
