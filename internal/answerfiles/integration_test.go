//go:build integration

// Интеграционный тест файлов в ответах против настоящих Postgres и MinIO (PROCESS
// §3). Проверяется вертикаль целиком, потому что именно на её стыках живут все
// свойства фазы: автор публикует форму с вопросом-файлом → респондент получает
// слот → кладёт байты ПРЯМО в хранилище по подписи → отправляет ответ → загрузка
// становится заявленной.
//
// Отказы проверяются тем же путём и по одному: .exe и файл сверх потолка не должны
// доезжать до бакета вовсе, а ответ со ссылкой на чужую загрузку — до базы.
package answerfiles_test

import (
	"bytes"
	"context"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/pgtest"
)

const filesBucket = "app-files"

// Схема формы с одним вопросом-файлом: подпись и поле в одной группе.
const fileFormSchema = `{"schemaVersion":1,"blocks":[
	{"id":"t_cv","groupId":"g_cv","type":"title","text":[{"t":"Резюме"}]},
	{"id":"cv","groupId":"g_cv","type":"file","settings":{"maxFiles":2,"maxFileSize":5}}
]}`

var (
	testPool *pgxpool.Pool
	testS3   blob.Config
)

func TestMain(m *testing.M) {
	ctx := context.Background()

	pool, stopPG, err := pgtest.Start(ctx)
	if err != nil {
		panic(err)
	}
	testPool = pool

	endpoint, stopMinio, err := startMinIO(ctx)
	if err != nil {
		stopPG()
		panic(err)
	}
	testS3 = blob.Config{
		Endpoint:  endpoint,
		Region:    "us-east-1",
		AccessKey: "minioadmin",
		SecretKey: "minioadmin",
		PathStyle: true,
	}
	if err := blob.New(testS3).CreateBucket(ctx, filesBucket); err != nil {
		stopMinio()
		stopPG()
		panic(err)
	}

	code := m.Run()
	stopMinio()
	stopPG()
	os.Exit(code)
}

// Демо фазы в виде теста: PDF доезжает до бакета, ответ его заявляет.
func TestUpload_RoundTrip(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	pdf := []byte("%PDF-1.7 " + strings.Repeat("x", 1000))
	slot := issueSlot(t, srv, slug, slotBody{
		Token:       freshToken(),
		BlockID:     "cv",
		FileName:    "моё резюме.pdf",
		SizeBytes:   int64(len(pdf)),
		ContentType: "application/pdf",
	})

	// Байты идут МИМО нашего процесса — прямо в хранилище по подписи.
	putObject(t, slot.URL, pdf, slot.ContentType)

	submitAnswer(t, srv, slug, freshToken(), map[string]any{"cv": []string{slot.UploadID}}, http.StatusCreated)

	var claimed bool
	var name string
	err := testPool.QueryRow(context.Background(),
		`SELECT claimed_at IS NOT NULL, original_name FROM submission_files WHERE id = $1`,
		uuid.MustParse(slot.UploadID)).Scan(&claimed, &name)
	if err != nil {
		t.Fatalf("строка загрузки: %v", err)
	}
	if !claimed {
		t.Error("загрузка осталась незаявленной после приёма ответа")
	}
	if name != "моё резюме.pdf" {
		t.Errorf("имя файла = %q, ждали «моё резюме.pdf»", name)
	}
}

// Демо фазы: .exe отбивается ДО начала загрузки — байты в бакет не уходят вовсе.
func TestUpload_RejectsDeniedType(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	for _, ct := range []string{"application/x-msdownload", "image/svg+xml", "text/html"} {
		r := issueSlotRaw(t, srv, slug, slotBody{
			Token: freshToken(), BlockID: "cv",
			FileName: "payload", SizeBytes: 100, ContentType: ct,
		})
		if r.StatusCode != http.StatusUnprocessableEntity {
			t.Errorf("%s: статус %d, ожидался 422", ct, r.StatusCode)
		}
		_ = r.Body.Close()
	}
}

// Файл сверх потолка блока (5 МиБ в схеме) — тоже до загрузки.
func TestUpload_RejectsOversized(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	r := issueSlotRaw(t, srv, slug, slotBody{
		Token: freshToken(), BlockID: "cv",
		FileName: "big.pdf", SizeBytes: 6 << 20, ContentType: "application/pdf",
	})
	defer func() { _ = r.Body.Close() }()
	if r.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("статус %d, ожидался 413", r.StatusCode)
	}
}

// Подпись выписана на один размер: тело длиннее хранилище не примет само.
func TestUpload_SignedSizeHolds(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	body := []byte("%PDF-1.7 маленький")
	slot := issueSlot(t, srv, slug, slotBody{
		Token: freshToken(), BlockID: "cv",
		FileName: "cv.pdf", SizeBytes: int64(len(body)), ContentType: "application/pdf",
	})

	req, _ := http.NewRequest(http.MethodPut, slot.URL, bytes.NewReader(append(body, '!')))
	req.Header.Set("Content-Type", slot.ContentType)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 400 {
		t.Fatalf("хранилище приняло тело сверх подписанного размера: статус %d", resp.StatusCode)
	}
}

// Ответ, называющий загрузку, которой нет (или чужую), не принимается: иначе в
// таблице автора оказалась бы ссылка на файл, которого он не получал.
func TestSubmit_RejectsUnknownUpload(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	submitAnswer(t, srv, slug, freshToken(),
		map[string]any{"cv": []string{uuid.New().String()}}, http.StatusUnprocessableEntity)

	var n int
	if err := testPool.QueryRow(context.Background(), `SELECT count(*) FROM submissions`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("ответ со ссылкой на чужую загрузку принят (%d строк)", n)
	}
}

// Ответ, названный без загруженных байтов: слот выдан, PUT не сделан — приём
// обязан заметить, что объекта нет, и отказать.
func TestSubmit_RejectsSlotWithoutBytes(t *testing.T) {
	resetDB(t)
	srv, _ := newStack(t)
	author := registerUser(t, srv, "author@example.com")
	slug := publishFileForm(t, author, srv)

	slot := issueSlot(t, srv, slug, slotBody{
		Token: freshToken(), BlockID: "cv",
		FileName: "cv.pdf", SizeBytes: 100, ContentType: "application/pdf",
	})
	submitAnswer(t, srv, slug, freshToken(),
		map[string]any{"cv": []string{slot.UploadID}}, http.StatusUnprocessableEntity)
}
