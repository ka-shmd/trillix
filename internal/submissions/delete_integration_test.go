//go:build integration

// Интеграционный тест удаления одного ответа (GDPR-гигиена): владелец удаляет свой
// ответ (счётчик падает, ответа больше нет), чужой получает 404, неизвестный id —
// 404. Удаление — мутация: требует CSRF-заголовок (double-submit).
package submissions_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/google/uuid"
)

// deleteWithCSRF шлёт DELETE с заголовком X-CSRF-Token, равным cookie csrf_token
// (как это делает фронтовый apiRequest). Без него RequireCSRF вернёт 403.
func deleteWithCSRF(t *testing.T, c *http.Client, srv *httptest.Server, path string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, srv.URL+path, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	u, _ := url.Parse(srv.URL)
	for _, ck := range c.Jar.Cookies(u) {
		if ck.Name == "csrf_token" {
			req.Header.Set("X-CSRF-Token", ck.Value)
		}
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("do delete: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestDeleteSubmission_RemovesOne(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	ids := submitN(t, srv, slug, 3)

	victim := ids[1].String()
	resp := deleteWithCSRF(t, owner, srv, "/api/v1/forms/"+fid+"/submissions/"+victim)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("удаление: статус %d, ожидалось 204", resp.StatusCode)
	}

	page := getList(t, owner, srv, fid, "")
	if page.Total != 2 {
		t.Fatalf("после удаления total = %d, ожидалось 2", page.Total)
	}
	for _, s := range page.Submissions {
		if s.ID == victim {
			t.Fatalf("удалённый ответ %s всё ещё в списке", victim)
		}
	}
}

// Повторное удаление того же id → 404 (идемпотентность на уровне «уже нет»).
func TestDeleteSubmission_Unknown_404(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	owner, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)

	resp := deleteWithCSRF(t, owner, srv, "/api/v1/forms/"+fid+"/submissions/"+uuid.NewString())
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("несуществующий ответ: статус %d, ожидалось 404", resp.StatusCode)
	}
}

// Анти-IDOR: чужой не удаляет ответ формы, где он не член воркспейса → 404.
func TestDeleteSubmission_ForeignForm_404(t *testing.T) {
	resetDB(t)
	srv := fullStack(t)
	_, ownerID := authedClient(t, srv, "owner-"+uuid.NewString()[:8]+"@example.com")
	slug := publishFormFor(t, ownerID, requiredNameSchema)
	fid := formIDBySlug(t, slug)
	ids := submitN(t, srv, slug, 1)

	attacker, _ := authedClient(t, srv, "attacker-"+uuid.NewString()[:8]+"@example.com")
	resp := deleteWithCSRF(t, attacker, srv, "/api/v1/forms/"+fid+"/submissions/"+ids[0].String())
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("чужое удаление: статус %d, ожидалось 404", resp.StatusCode)
	}
}
