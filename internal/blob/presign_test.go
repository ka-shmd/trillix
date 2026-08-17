package blob

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

func testClient() *Client {
	return New(Config{
		Endpoint:  "https://s3.example.com",
		Region:    "ru-1",
		AccessKey: "AKID",
		SecretKey: "secret",
		PathStyle: true,
	})
}

// Состав подписи загрузки. Проверяется без Docker то, что интеграционный тест
// проверяет поведением: размер и тип ВХОДЯТ в подписанные заголовки — значит,
// запрос с другими значениями хранилище отвергнет само.
func TestPresignPut_SignsLengthAndType(t *testing.T) {
	raw, err := testClient().PresignPut("files", "answers/a/b.pdf", PutOptions{
		ContentType:   "application/pdf",
		ContentLength: 1024,
		Expires:       5 * time.Minute,
	}, time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("presign: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	q := u.Query()
	if got, want := q.Get("X-Amz-SignedHeaders"), "content-length;content-type;host"; got != want {
		t.Fatalf("signed headers = %q, want %q", got, want)
	}
	if got := q.Get("X-Amz-Expires"); got != "300" {
		t.Fatalf("expires = %q, want 300", got)
	}
	if got, want := q.Get("X-Amz-Credential"), "AKID/20260817/ru-1/s3/aws4_request"; got != want {
		t.Fatalf("credential = %q, want %q", got, want)
	}
	if q.Get("X-Amz-Signature") == "" {
		t.Fatal("подпись пуста")
	}
	if u.Path != "/files/answers/a/b.pdf" {
		t.Fatalf("path = %q", u.Path)
	}
}

// Подпись загрузки детерминирована при фиксированном времени: рефакторинг
// канонизации, изменивший результат, покраснеет здесь, а не на проде.
func TestPresignPut_Deterministic(t *testing.T) {
	at := time.Date(2026, 8, 17, 10, 0, 0, 0, time.UTC)
	opt := PutOptions{ContentType: "application/pdf", ContentLength: 1024, Expires: 5 * time.Minute}
	first, err := testClient().PresignPut("files", "answers/a/b.pdf", opt, at)
	if err != nil {
		t.Fatalf("presign: %v", err)
	}
	second, err := testClient().PresignPut("files", "answers/a/b.pdf", opt, at)
	if err != nil {
		t.Fatalf("presign (repeat): %v", err)
	}
	if first != second {
		t.Fatalf("подпись не детерминирована:\n%s\n%s", first, second)
	}
}

// Переопределения ответа кодируются по RFC 3986: пробел — %20, а не «+».
// Иначе то, что ушло в сеть, разошлось бы с тем, что подписано, и хранилище
// ответило бы SignatureDoesNotMatch на каждом имени файла с пробелом.
func TestPresignGet_EncodesDispositionWithoutPlus(t *testing.T) {
	raw, err := testClient().PresignGet("files", "answers/a/b.pdf", GetOptions{
		Expires:             time.Minute,
		ResponseContentType: "application/octet-stream",
		ResponseDisposition: `attachment; filename="отчёт 1.pdf"`,
	}, time.Now())
	if err != nil {
		t.Fatalf("presign: %v", err)
	}
	query := raw[strings.Index(raw, "?")+1:]
	if strings.Contains(query, "+") {
		t.Fatalf("в query есть «+»: %s", query)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got, want := u.Query().Get("response-content-disposition"), `attachment; filename="отчёт 1.pdf"`; got != want {
		t.Fatalf("disposition = %q, want %q", got, want)
	}
}

func TestPresign_RejectsBadInput(t *testing.T) {
	c := testClient()
	tests := map[string]func() error{
		"нулевой срок": func() error {
			_, err := c.PresignGet("files", "k", GetOptions{Expires: 0}, time.Now())
			return err
		},
		"срок больше семи суток": func() error {
			_, err := c.PresignGet("files", "k", GetOptions{Expires: 8 * 24 * time.Hour}, time.Now())
			return err
		},
		"нулевая длина тела": func() error {
			_, err := c.PresignPut("files", "k", PutOptions{ContentLength: 0, Expires: time.Minute}, time.Now())
			return err
		},
	}
	for name, call := range tests {
		t.Run(name, func(t *testing.T) {
			if err := call(); err == nil {
				t.Fatal("ошибки нет, а должна быть")
			}
		})
	}
}
