//go:build integration

package blob_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/ka-shmd/trillix/internal/blob"
)

// Интеграционный тест против настоящего MinIO (S3-совместимый) — единственная
// проверка корректности sigv4: неверная канонизация/подпись даёт
// SignatureDoesNotMatch, и round-trip падает. Тег integration, поднимается через
// testcontainers (как internal/pgtest для Postgres). Один контейнер на тест —
// сценарий один.
func TestClient_RoundTrip(t *testing.T) {
	ctx := context.Background()
	endpoint, stop := startMinIO(t, ctx)
	defer stop()

	c := blob.New(blob.Config{
		Endpoint:  endpoint,
		Region:    "us-east-1",
		AccessKey: "minioadmin",
		SecretKey: "minioadmin",
		PathStyle: true,
	})

	const bucket = "app-media"
	if err := c.CreateBucket(ctx, bucket); err != nil {
		t.Fatalf("create bucket: %v", err)
	}
	// Идемпотентность CreateBucket: повторный вызов не ошибка.
	if err := c.CreateBucket(ctx, bucket); err != nil {
		t.Fatalf("create bucket (repeat): %v", err)
	}

	const key = "11111111-1111-7111-8111-111111111111/deadbeef.png"
	want := []byte("\x89PNG\r\n\x1a\n fake image bytes")

	if err := c.PutObject(ctx, bucket, key, want, "image/png"); err != nil {
		t.Fatalf("put: %v", err)
	}

	got, ct, err := c.GetObject(ctx, bucket, key)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("get body = %q, want %q", got, want)
	}
	if ct != "image/png" {
		t.Fatalf("content-type = %q, want image/png", ct)
	}

	if err := c.DeleteObject(ctx, bucket, key); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, _, err := c.GetObject(ctx, bucket, key); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("get after delete: err = %v, want ErrNotFound", err)
	}
}

// startMinIO поднимает MinIO дженерик-контейнером (без нового модуля-зависимости:
// используем уже подключённый testcontainers-go). Возвращает endpoint и стоп.
func startMinIO(t *testing.T, ctx context.Context) (endpoint string, stop func()) {
	t.Helper()
	req := testcontainers.ContainerRequest{
		// Реестр назван ЯВНО: с Docker Hub образ minio/minio пропал целиком —
		// 2026-09-12 репозиторий отдавал ноль тегов, и CI встал на «pull access
		// denied» во всех трёх пакетах, которые его поднимают. quay.io — второй
		// официальный реестр MinIO, тот же тег и тот же digest.
		// история — JOURNAL, «Образ MinIO уехал с Docker Hub»
		Image:        "quay.io/minio/minio:RELEASE.2024-01-16T16-07-38Z",
		Cmd:          []string{"server", "/data"},
		Env:          map[string]string{"MINIO_ROOT_USER": "minioadmin", "MINIO_ROOT_PASSWORD": "minioadmin"},
		ExposedPorts: []string{"9000/tcp"},
		WaitingFor: wait.ForHTTP("/minio/health/live").WithPort("9000/tcp").
			WithStartupTimeout(60 * time.Second),
	}
	container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: req,
		Started:          true,
	})
	if err != nil {
		t.Fatalf("start minio: %v", err)
	}
	stop = func() { _ = testcontainers.TerminateContainer(container) }

	host, err := container.Host(ctx)
	if err != nil {
		stop()
		t.Fatalf("minio host: %v", err)
	}
	port, err := container.MappedPort(ctx, "9000")
	if err != nil {
		stop()
		t.Fatalf("minio port: %v", err)
	}
	return fmt.Sprintf("http://%s:%s", host, port.Port()), stop
}

// Presigned-адреса против настоящего MinIO. Проверяется не «URL собрался», а два
// свойства, ради которых поток файлов в ответах вообще устроен так (спека
// design/answer-files.md §3): подписанный размер РЕАЛЬНО не даёт положить больше,
// а выдача умеет переопределить заголовки ответа на вложение.
func TestClient_Presign(t *testing.T) {
	ctx := context.Background()
	endpoint, stop := startMinIO(t, ctx)
	defer stop()

	c := blob.New(blob.Config{
		Endpoint:  endpoint,
		Region:    "us-east-1",
		AccessKey: "minioadmin",
		SecretKey: "minioadmin",
		PathStyle: true,
	})

	const bucket = "app-files"
	if err := c.CreateBucket(ctx, bucket); err != nil {
		t.Fatalf("create bucket: %v", err)
	}

	const key = "answers/22222222-2222-7222-8222-222222222222/report.pdf"
	body := []byte("%PDF-1.7 fake document bytes")
	opt := blob.PutOptions{
		ContentType:   "application/pdf",
		ContentLength: int64(len(body)),
		Expires:       5 * time.Minute,
	}

	putURL, err := c.PresignPut(bucket, key, opt, time.Now())
	if err != nil {
		t.Fatalf("presign put: %v", err)
	}

	// Тело ровно того размера, что подписан, — загрузка проходит.
	if code := doPut(t, putURL, body, "application/pdf"); code != http.StatusOK {
		t.Fatalf("presigned put: status %d, want 200", code)
	}

	// Тот же адрес, но байт больше: хранилище обязано отказать САМО — иначе
	// потолок размера держался бы только нашей проверкой, которой у владельца
	// адреса нет.
	overURL, err := c.PresignPut(bucket, key, opt, time.Now())
	if err != nil {
		t.Fatalf("presign put (over): %v", err)
	}
	if code := doPut(t, overURL, append(body, '!'), "application/pdf"); code < 400 {
		t.Fatalf("presigned put over signed length: status %d, want 4xx", code)
	}

	// Настоящий размер знает только хранилище: байты клал не Go.
	info, err := c.HeadObject(ctx, bucket, key)
	if err != nil {
		t.Fatalf("head: %v", err)
	}
	if info.Size != int64(len(body)) {
		t.Fatalf("head size = %d, want %d", info.Size, len(body))
	}
	if info.ContentType != "application/pdf" {
		t.Fatalf("head content-type = %q, want application/pdf", info.ContentType)
	}

	// Выдача: тип и расположение переопределяются подписью, а не заголовками
	// объекта, — пользовательский файл обязан скачиваться вложением.
	getURL, err := c.PresignGet(bucket, key, blob.GetOptions{
		Expires:             time.Minute,
		ResponseContentType: "application/octet-stream",
		ResponseDisposition: `attachment; filename="report.pdf"`,
	}, time.Now())
	if err != nil {
		t.Fatalf("presign get: %v", err)
	}
	resp, err := http.Get(getURL) //nolint:gosec,noctx // адрес построен тестом
	if err != nil {
		t.Fatalf("presigned get: %v", err)
	}
	got, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("presigned get: status %d, body %s", resp.StatusCode, got)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("presigned get body = %q, want %q", got, body)
	}
	if cd := resp.Header.Get("Content-Disposition"); cd != `attachment; filename="report.pdf"` {
		t.Fatalf("content-disposition = %q, want attachment", cd)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("content-type = %q, want application/octet-stream", ct)
	}

	// Просроченная подпись не работает: срок — часть подписи, а не наша проверка.
	expired, err := c.PresignGet(bucket, key, blob.GetOptions{Expires: time.Minute}, time.Now().Add(-time.Hour))
	if err != nil {
		t.Fatalf("presign get (expired): %v", err)
	}
	resp, err = http.Get(expired) //nolint:gosec,noctx // адрес построен тестом
	if err != nil {
		t.Fatalf("expired get: %v", err)
	}
	drainResp(resp)
	if resp.StatusCode < 400 {
		t.Fatalf("expired presigned get: status %d, want 4xx", resp.StatusCode)
	}
}

// doPut шлёт тело по presigned-адресу и возвращает статус.
func doPut(t *testing.T, url string, body []byte, contentType string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(body)) //nolint:noctx // тест
	if err != nil {
		t.Fatalf("build put: %v", err)
	}
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = int64(len(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	drainResp(resp)
	return resp.StatusCode
}

func drainResp(resp *http.Response) {
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}
