//go:build integration

// Жизненный цикл файла ответа: выдача автору, удаление вместе с ответом, сборка
// сирот. Всё против настоящих Postgres и MinIO — состояние бакета проверяется
// напрямую, а не по нашему же коду.
package answerfiles_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/answerfiles"
	"github.com/ka-shmd/trillix/internal/blob"
)

// Демо фазы: автор скачивает приложенный файл — редиректом на короткую подпись,
// вложением и с тем же содержимым.
func TestDownload_AuthorGetsFile(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	body := []byte("%PDF-1.7 содержимое резюме")
	uploadID := attachFile(t, srv, slug, body)

	// Редирект не следуем сами: сперва смотрим на сам ответ кабинета.
	noRedirect := *author
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	r, err := noRedirect.Get(srv.URL + "/api/v1/files/" + uploadID)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer func() { _ = r.Body.Close() }()
	if r.StatusCode != http.StatusFound {
		t.Fatalf("статус %d, ожидался 302", r.StatusCode)
	}
	if cc := r.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, подпись не должна кэшироваться", cc)
	}

	// Теперь по самой подписи: те же байты, и обязательно вложением.
	got, err := http.Get(r.Header.Get("Location")) //nolint:gosec,noctx // адрес выдан нашим же сервисом
	if err != nil {
		t.Fatalf("storage get: %v", err)
	}
	defer func() { _ = got.Body.Close() }()
	data, _ := io.ReadAll(got.Body)
	if string(data) != string(body) {
		t.Errorf("содержимое разошлось: %q", string(data))
	}
	if cd := got.Header.Get("Content-Disposition"); cd == "" || cd[:len("attachment")] != "attachment" {
		t.Errorf("Content-Disposition = %q, файл обязан скачиваться вложением", cd)
	}
	if ct := got.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Errorf("Content-Type = %q, тип объекта не должен использоваться при выдаче", ct)
	}
}

// Анти-IDOR: чужой файл — 404, а не 403; существование чужих ответов не
// раскрывается. Ровно тот случай, ради которого право резолвится от ФОРМЫ файла,
// а не от id в адресе.
func TestDownload_ForeignUserGetsNotFound(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	stranger := registerUser(t, srv, "stranger@example.com")
	slug := publishFileForm(t, author, srv)

	uploadID := attachFile(t, srv, slug, []byte("%PDF-1.7 чужое резюме"))

	r, err := stranger.Get(srv.URL + "/api/v1/files/" + uploadID)
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer func() { _ = r.Body.Close() }()
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("чужое скачивание: статус %d, ожидался 404", r.StatusCode)
	}
}

// Демо фазы: удаление ответа уносит и файл из бакета.
func TestDeleteSubmission_RemovesObject(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	uploadID := attachFile(t, srv, slug, []byte("%PDF-1.7 удаляемое"))
	key := objectKeyOf(t, uploadID)
	formID, submissionID := idsOf(t, uploadID)

	r := doJSON(t, author, srv, http.MethodDelete,
		"/api/v1/forms/"+formID+"/submissions/"+submissionID, ``)
	decodeInto(t, r, http.StatusNoContent, nil)

	if _, err := blob.New(testS3).HeadObject(context.Background(), filesBucket, key); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("объект пережил удаление ответа: err = %v", err)
	}
	var n int
	if err := testPool.QueryRow(context.Background(),
		`SELECT count(*) FROM submission_files WHERE id = $1`, uuid.MustParse(uploadID)).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatal("строка загрузки пережила удаление ответа")
	}
}

// Демо фазы: загрузка без отправленной формы исчезает из бакета сама.
func TestCleanupOrphans_RemovesUnclaimed(t *testing.T) {
	resetDB(t)
	srv, files := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	body := []byte("%PDF-1.7 брошенное")
	slot := issueSlot(t, srv, slug, slotBody{
		Token: freshToken(), BlockID: "cv",
		FileName: "cv.pdf", SizeBytes: int64(len(body)), ContentType: "application/pdf",
	})
	putObject(t, slot.URL, body, slot.ContentType)
	key := objectKeyOf(t, slot.UploadID)

	// Свежая сирота не трогается: TTL — сутки, и чистка не имеет права снести
	// файл человека, который ещё заполняет форму.
	n, err := files.CleanupOrphans(context.Background(), time.Now())
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if n != 0 {
		t.Fatalf("свежая загрузка снесена (%d шт.)", n)
	}

	// Через сутки — снесена вместе с объектом. Время подаётся аргументом, а не
	// ожиданием: тесты детерминированы, sleep запрещён.
	n, err = files.CleanupOrphans(context.Background(), time.Now().Add(answerfiles.OrphanTTL+time.Minute))
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
	if n != 1 {
		t.Fatalf("снесено %d сирот, ожидалась одна", n)
	}
	if _, err := blob.New(testS3).HeadObject(context.Background(), filesBucket, key); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("объект сироты остался в бакете: err = %v", err)
	}
}

// --- helpers ---

// attachFile проходит весь путь респондента и возвращает id заявленной загрузки.
func attachFile(t *testing.T, srv *httptest.Server, slug string, body []byte) string {
	t.Helper()
	slot := issueSlot(t, srv, slug, slotBody{
		Token: freshToken(), BlockID: "cv",
		FileName: "резюме.pdf", SizeBytes: int64(len(body)), ContentType: "application/pdf",
	})
	putObject(t, slot.URL, body, slot.ContentType)
	submitAnswer(t, srv, slug, freshToken(), map[string]any{"cv": []string{slot.UploadID}}, http.StatusCreated)
	return slot.UploadID
}

func objectKeyOf(t *testing.T, uploadID string) string {
	t.Helper()
	var key string
	if err := testPool.QueryRow(context.Background(),
		`SELECT object_key FROM submission_files WHERE id = $1`, uuid.MustParse(uploadID)).Scan(&key); err != nil {
		t.Fatalf("object_key: %v", err)
	}
	return key
}

func idsOf(t *testing.T, uploadID string) (formID, submissionID string) {
	t.Helper()
	if err := testPool.QueryRow(context.Background(),
		`SELECT form_id, submission_id FROM submission_files WHERE id = $1`,
		uuid.MustParse(uploadID)).Scan(&formID, &submissionID); err != nil {
		t.Fatalf("ids: %v", err)
	}
	return formID, submissionID
}
