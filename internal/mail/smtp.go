package mail

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log/slog"
	"mime"
	"net"
	netmail "net/mail"
	"net/smtp"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// TLSMode — как SMTPMailer шифрует соединение. Зеркалит config.MailSMTP TLS*
// (composition root мапит одно в другое), но живёт в пакете mail, чтобы транспорт
// не зависел от config.
type TLSMode string

const (
	// TLSStartTLS — открытое соединение с апгрейдом до TLS (Postbox, порт 587).
	TLSStartTLS TLSMode = "starttls"
	// TLSImplicit — TLS с первого байта (порт 465).
	TLSImplicit TLSMode = "implicit"
	// TLSNone — без шифрования (локальный Mailpit; трафик не покидает машину).
	TLSNone TLSMode = "none"
)

// smtpDialTimeout — потолок на установку соединения и всю SMTP-сессию, если контекст
// вызова без дедлайна. Диспетчер вызывает Send из фонового воркера; без предела
// зависший провайдер держал бы попытку доставки бесконечно.
const smtpDialTimeout = 30 * time.Second

// SMTPMailer доставляет письмо через SMTP: прод — в Yandex Postbox (STARTTLS+AUTH),
// prod-local — в Mailpit (без TLS, без AUTH). Один транспорт на оба контура,
// различие — в полях. Username/Password пусты = без SMTP AUTH.
//
// From — полное значение заголовка ("Имя <addr>"); адрес конверта (MAIL FROM)
// извлекается из него разбором. Password — секрет: не логируется (инвариант 2/7),
// тело письма (со ссылками-токенами) в лог не пишется тоже — только факт доставки.
type SMTPMailer struct {
	Host     string
	Port     int
	Username string
	Password string
	TLS      TLSMode
	From     string
	Log      *slog.Logger
}

var _ Mailer = SMTPMailer{}

func (m SMTPMailer) Send(ctx context.Context, msg EmailMessage) error {
	subject, body, err := Render(msg)
	if err != nil {
		return err
	}
	from, err := netmail.ParseAddress(m.From)
	if err != nil {
		return fmt.Errorf("parse MAIL_FROM %q: %w", m.From, err)
	}
	// Имя автора подменяет только ИМЯ в заголовке From; адрес остаётся сервисным —
	// и в заголовке, и в конверте (MAIL FROM ниже берётся из from.Address).
	header := m.From
	if msg.FromName != "" {
		header = (&netmail.Address{Name: msg.FromName, Address: from.Address}).String()
	}
	raw, err := buildMessage(header, msg.To, subject, body, senderDomain(from.Address, m.Host), msg.ReplyTo, msg.Files)
	if err != nil {
		return err
	}

	client, err := m.dial(ctx)
	if err != nil {
		return fmt.Errorf("smtp dial %s: %w", m.Host, err)
	}
	defer func() { _ = client.Close() }()

	// AUTH только при заданной учётке (Mailpit её не требует). PlainAuth пойдёт
	// поверх TLS (starttls/implicit) — net/smtp отвергает PLAIN по открытому каналу.
	if m.Username != "" {
		if err := client.Auth(smtp.PlainAuth("", m.Username, m.Password, m.Host)); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := client.Mail(from.Address); err != nil {
		return fmt.Errorf("smtp MAIL FROM: %w", err)
	}
	if err := client.Rcpt(msg.To); err != nil {
		return fmt.Errorf("smtp RCPT TO: %w", err)
	}
	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err := w.Write(raw); err != nil {
		return fmt.Errorf("smtp write body: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("smtp close body: %w", err)
	}
	if err := client.Quit(); err != nil {
		return fmt.Errorf("smtp QUIT: %w", err)
	}

	// Только факт доставки: ни тела (ссылки-токены), ни пароля (инвариант 2/7).
	m.Log.Info("email delivered (smtp)",
		slog.String("from", m.From),
		slog.String("to", msg.To),
		slog.String("subject", subject))
	return nil
}

// dial устанавливает соединение и оборачивает его в SMTP-клиента по режиму TLS.
// Контекст управляет только TCP/TLS-рукопожатием; net/smtp дальше без контекста,
// поэтому на соединение ставится дедлайн (из ctx либо smtpDialTimeout).
func (m SMTPMailer) dial(ctx context.Context) (*smtp.Client, error) {
	addr := net.JoinHostPort(m.Host, strconv.Itoa(m.Port))
	deadline := time.Now().Add(smtpDialTimeout)
	if d, ok := ctx.Deadline(); ok {
		deadline = d
	}

	var conn net.Conn
	var err error
	if m.TLS == TLSImplicit {
		conn, err = (&tls.Dialer{Config: &tls.Config{ServerName: m.Host}}).DialContext(ctx, "tcp", addr)
	} else {
		conn, err = (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	}
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(deadline)

	client, err := smtp.NewClient(conn, m.Host)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if m.TLS == TLSStartTLS {
		if err := client.StartTLS(&tls.Config{ServerName: m.Host}); err != nil {
			_ = client.Close()
			return nil, fmt.Errorf("starttls: %w", err)
		}
	}
	return client, nil
}

// senderDomain — домен для Message-ID: часть отправителя после @ (Postbox правит
// DKIM по нему), с фолбэком на SMTP-хост, если адрес без домена.
func senderDomain(address, fallback string) string {
	if at := strings.LastIndexByte(address, '@'); at >= 0 && at < len(address)-1 {
		return address[at+1:]
	}
	return fallback
}

// buildMessage собирает письмо RFC 5322: заголовки + plain-text тело, а при
// вложениях — multipart/mixed с телом первой частью. Тема MIME-кодируется
// (RFC 2047) — она кириллическая; тело едет base64 с переносами по 76 символов
// (RFC 2045), заявленное Content-Transfer-Encoding. Message-ID и Date добавляются
// осознанно: без них спам-фильтры (и mail-tester) снижают оценку.
//
// Multipart собирается руками, а не mime/multipart: тот пишет части как есть, а нам
// нужно base64 с переносами и свои заголовки на каждой части — обёртка вокруг него
// вышла бы длиннее прямой сборки.
func buildMessage(from, to, subject, body, domain, replyTo string, files []File) ([]byte, error) {
	messageID, err := randomMessageID(domain)
	if err != nil {
		return nil, err
	}
	var boundary string
	if len(files) > 0 {
		if boundary, err = randomBoundary(); err != nil {
			return nil, err
		}
	}
	var b strings.Builder
	writeHeader(&b, "From", from)
	writeHeader(&b, "To", to)
	// Reply-To ставит автор формы: «Ответить» в его почтовом клиенте уедет туда,
	// куда он просил, а не на сервисный адрес, который писем не читает.
	if replyTo != "" {
		writeHeader(&b, "Reply-To", replyTo)
	}
	writeHeader(&b, "Subject", mime.QEncoding.Encode("utf-8", subject))
	writeHeader(&b, "Date", time.Now().Format(time.RFC1123Z))
	writeHeader(&b, "Message-ID", messageID)
	writeHeader(&b, "MIME-Version", "1.0")
	if len(files) == 0 {
		writeHeader(&b, "Content-Type", "text/plain; charset=UTF-8")
		writeHeader(&b, "Content-Transfer-Encoding", "base64")
		b.WriteString("\r\n")
		b.WriteString(wrapBase64([]byte(body)))
		return []byte(b.String()), nil
	}

	writeHeader(&b, "Content-Type", `multipart/mixed; boundary="`+boundary+`"`)
	b.WriteString("\r\n")
	b.WriteString("--" + boundary + "\r\n")
	writeHeader(&b, "Content-Type", "text/plain; charset=UTF-8")
	writeHeader(&b, "Content-Transfer-Encoding", "base64")
	b.WriteString("\r\n")
	b.WriteString(wrapBase64([]byte(body)))
	for _, f := range files {
		b.WriteString("\r\n--" + boundary + "\r\n")
		writeHeader(&b, "Content-Type", f.MIME)
		writeHeader(&b, "Content-Transfer-Encoding", "base64")
		writeHeader(&b, "Content-Disposition", attachmentDisposition(f.Name))
		b.WriteString("\r\n")
		b.WriteString(wrapBase64(f.Content))
	}
	b.WriteString("\r\n--" + boundary + "--\r\n")
	return []byte(b.String()), nil
}

// attachmentDisposition — имя файла в письме. Кириллица едет в filename* по RFC 5987
// (тот же приём, что у скачивания PDF из кабинета), а ASCII-имя в filename остаётся
// техническим: старые клиенты ломают кириллицу в нём.
func attachmentDisposition(name string) string {
	return fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s",
		"submission.pdf", url.PathEscape(name))
}

// randomBoundary — разделитель частей multipart. Случайный: совпадение с байтами
// вложения разорвало бы письмо посередине.
func randomBoundary() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("multipart boundary entropy: %w", err)
	}
	return "trillix-" + hex.EncodeToString(buf[:]), nil
}

func writeHeader(b *strings.Builder, name, value string) {
	b.WriteString(name)
	b.WriteString(": ")
	b.WriteString(value)
	b.WriteString("\r\n")
}

// randomMessageID — "<hex@domain>"; локальная часть случайна (уникальность письма),
// доменная берётся у отправителя. Не доменная сущность — свой ID, не domain.NewID.
func randomMessageID(domain string) (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("message-id entropy: %w", err)
	}
	return "<" + hex.EncodeToString(buf[:]) + "@" + domain + ">", nil
}

// wrapBase64 кодирует данные в base64 и режет на строки по 76 символов, разделённые
// CRLF, как требует RFC 2045 для этого Content-Transfer-Encoding. Берёт байты, а не
// строку: через неё же едут вложения, и лишняя копия мегабайтного PDF ни к чему.
func wrapBase64(src []byte) string {
	encoded := base64.StdEncoding.EncodeToString(src)
	const lineLen = 76
	var b strings.Builder
	for len(encoded) > lineLen {
		b.WriteString(encoded[:lineLen])
		b.WriteString("\r\n")
		encoded = encoded[lineLen:]
	}
	b.WriteString(encoded)
	b.WriteString("\r\n")
	return b.String()
}
