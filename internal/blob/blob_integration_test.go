//go:build integration

package blob_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/ka-shmd/trierra/internal/blob"
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
		Image:        "minio/minio:RELEASE.2024-01-16T16-07-38Z",
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
