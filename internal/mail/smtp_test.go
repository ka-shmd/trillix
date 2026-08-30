package mail

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"log/slog"
	"net"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// Reply-To и своё имя отправителя — перебивки автора формы (0042). Проверяется
// главное: адрес отправителя ими НЕ подменяется. Подменённый From стоил бы
// репутации домена, с которого мы шлём все письма сервиса.
func TestBuildMessage_AuthorOverrides(t *testing.T) {
	raw, err := buildMessage(
		"Отдел кадров <no-reply@trillix.ru>", "owner@example.com",
		"Новая заявка", "Пришла заявка.", "trillix.ru", "hr@example.com", nil)
	if err != nil {
		t.Fatalf("buildMessage: %v", err)
	}
	msg := string(raw)
	for _, want := range []string{
		"From: Отдел кадров <no-reply@trillix.ru>\r\n",
		"Reply-To: hr@example.com\r\n",
	} {
		if !strings.Contains(msg, want) {
			t.Fatalf("нет заголовка %q в письме:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "hr@example.com>") {
		t.Fatal("адрес автора попал в From — подменяется только имя")
	}
}

// Без перебивок заголовка Reply-To в письме нет вовсе: пустой заголовок хуже
// отсутствующего — часть фильтров считает его признаком плохо собранного письма.
func TestBuildMessage_NoReplyToWhenUnset(t *testing.T) {
	raw, err := buildMessage(
		"Trillix <no-reply@trillix.ru>", "user@example.com",
		"Тема", "Тело", "trillix.ru", "", nil)
	if err != nil {
		t.Fatalf("buildMessage: %v", err)
	}
	if strings.Contains(string(raw), "Reply-To") {
		t.Fatal("Reply-To стоит в письме, которого о нём не просили")
	}
}

func TestBuildMessage(t *testing.T) {
	raw, err := buildMessage(
		"Trillix <no-reply@trillix.ru>", "user@example.com",
		"Подтверждение почты", "Здравствуйте!\n\nСсылка: https://x/y\n", "trillix.ru", "", nil)
	if err != nil {
		t.Fatalf("buildMessage: %v", err)
	}
	msg := string(raw)

	// Заголовки на месте.
	for _, want := range []string{
		"From: Trillix <no-reply@trillix.ru>\r\n",
		"To: user@example.com\r\n",
		"MIME-Version: 1.0\r\n",
		"Content-Type: text/plain; charset=UTF-8\r\n",
		"Content-Transfer-Encoding: base64\r\n",
		"@trillix.ru>\r\n", // Message-ID с доменом отправителя
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("нет заголовка %q в письме:\n%s", want, msg)
		}
	}

	// Кириллическая тема закодирована (RFC 2047), а не отдана сырым UTF-8.
	if !strings.Contains(msg, "Subject: =?utf-8?q?") {
		t.Errorf("тема не MIME-закодирована:\n%s", msg)
	}
	if strings.Contains(msg, "Subject: Подтверждение") {
		t.Errorf("тема ушла сырым UTF-8:\n%s", msg)
	}

	// Тело — base64, декодируется в исходный текст.
	_, bodyPart, ok := strings.Cut(msg, "\r\n\r\n")
	if !ok {
		t.Fatalf("нет разделителя заголовков/тела:\n%s", msg)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(strings.TrimSpace(bodyPart), "\r\n", ""))
	if err != nil {
		t.Fatalf("тело не декодируется из base64: %v", err)
	}
	if !strings.Contains(string(decoded), "Ссылка: https://x/y") {
		t.Errorf("тело потеряло содержимое: %q", decoded)
	}
}

func TestSMTPMailerSend(t *testing.T) {
	srv := newFakeSMTP(t)
	defer srv.Close()

	m := SMTPMailer{
		Host: srv.host, Port: srv.port,
		TLS:  TLSNone, // без AUTH — как Mailpit
		From: "Trillix <no-reply@trillix.ru>",
		Log:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	err := m.Send(context.Background(), EmailMessage{
		To:       "owner@example.com",
		Template: TemplateEmailVerification,
		Data:     map[string]any{"link": "https://trillix.ru/verify?token=abc"},
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	got := srv.wait()
	if !strings.Contains(got.from, "no-reply@trillix.ru") {
		t.Errorf("MAIL FROM без адреса отправителя: %q", got.from)
	}
	if !strings.Contains(got.rcpt, "owner@example.com") {
		t.Errorf("RCPT TO без получателя: %q", got.rcpt)
	}
	if !strings.Contains(got.data, "Subject: =?utf-8?q?") {
		t.Errorf("в DATA нет закодированной темы:\n%s", got.data)
	}
}

// --- минимальный SMTP-сервер для теста (герметичен, без Docker) ---

type capturedSession struct {
	from, rcpt, data string
}

type fakeSMTP struct {
	ln   net.Listener
	host string
	port int
	done chan capturedSession
}

func newFakeSMTP(t *testing.T) *fakeSMTP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port := 0
	for _, c := range portStr {
		port = port*10 + int(c-'0')
	}
	s := &fakeSMTP{ln: ln, host: host, port: port, done: make(chan capturedSession, 1)}
	go s.serve()
	return s
}

func (s *fakeSMTP) serve() {
	conn, err := s.ln.Accept()
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	r := bufio.NewReader(conn)
	write := func(line string) { _, _ = conn.Write([]byte(line)) }

	write("220 fake ESMTP\r\n")
	var sess capturedSession
	var once sync.Once
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			write("250 fake\r\n")
		case strings.HasPrefix(cmd, "MAIL"):
			sess.from = strings.TrimSpace(line)
			write("250 OK\r\n")
		case strings.HasPrefix(cmd, "RCPT"):
			sess.rcpt = strings.TrimSpace(line)
			write("250 OK\r\n")
		case strings.HasPrefix(cmd, "DATA"):
			write("354 end with .\r\n")
			var body strings.Builder
			for {
				dl, err := r.ReadString('\n')
				if err != nil {
					return
				}
				if strings.TrimRight(dl, "\r\n") == "." {
					break
				}
				body.WriteString(dl)
			}
			sess.data = body.String()
			write("250 OK\r\n")
		case strings.HasPrefix(cmd, "QUIT"):
			write("221 Bye\r\n")
			once.Do(func() { s.done <- sess })
			return
		default:
			write("250 OK\r\n")
		}
	}
}

func (s *fakeSMTP) wait() capturedSession { return <-s.done }

func (s *fakeSMTP) Close() { _ = s.ln.Close() }

// Вложение едет multipart/mixed: тело первой частью, файл — второй, с base64 и
// человеческим именем в filename* (RFC 5987). Без вложений письмо остаётся
// одночастным text/plain — проверено соседними тестами.
func TestBuildMessage_Attachment(t *testing.T) {
	pdf := []byte("%PDF-1.4 fake")
	raw, err := buildMessage(
		"Trillix <no-reply@trillix.ru>", "owner@example.com",
		"Новый ответ", "Тело письма.", "trillix.ru", "",
		[]File{{Name: "Анкета — 2026-08-30.pdf", MIME: "application/pdf", Content: pdf}})
	if err != nil {
		t.Fatalf("buildMessage: %v", err)
	}
	msg := string(raw)
	if !strings.Contains(msg, "Content-Type: multipart/mixed; boundary=\"") {
		t.Fatalf("письмо с вложением не multipart:\n%s", msg)
	}
	if !strings.Contains(msg, "Content-Type: application/pdf\r\n") {
		t.Fatalf("нет части с PDF:\n%s", msg)
	}
	if !strings.Contains(msg, "filename*=UTF-8''"+url.PathEscape("Анкета — 2026-08-30.pdf")) {
		t.Fatalf("имя файла не по RFC 5987:\n%s", msg)
	}
	if !strings.Contains(msg, base64.StdEncoding.EncodeToString(pdf)) {
		t.Fatalf("байты вложения не доехали:\n%s", msg)
	}
	// Граница закрыта: незакрытый multipart часть клиентов показывает пустым письмом.
	i := strings.Index(msg, "boundary=\"")
	boundary := msg[i+len("boundary=\"") : i+len("boundary=\"")+strings.Index(msg[i+len("boundary=\""):], "\"")]
	if !strings.HasSuffix(msg, "--"+boundary+"--\r\n") {
		t.Fatalf("multipart не закрыт финальной границей:\n%s", msg)
	}
}
