package safehttp

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"syscall"
	"time"
)

const (
	// DefaultTimeout — потолок всего запроса: соединение, TLS, ожидание ответа и
	// чтение тела. Слот доставщика занят ровно столько, сколько молчит получатель.
	DefaultTimeout = 5 * time.Second
	// BodyLimit — сколько байт тела ответа дочитывается перед закрытием. Само тело
	// не нужно (исход — только код), но бесконечный ответ не должен держать слот.
	// Тем же числом ограничены заголовки ответа.
	BodyLimit = 64 << 10
	// MaxURLLength — потолок длины адреса.
	MaxURLLength = 2048
)

var (
	// ErrScheme — адрес не https: в теле запроса персональные данные респондента.
	ErrScheme = errors.New("safehttp: адрес не https")
	// ErrUserInfo — логин и пароль в адресе (user:pass@host).
	ErrUserInfo = errors.New("safehttp: логин и пароль в адресе")
	// ErrMalformed — адрес не разбирается, пуст или длиннее MaxURLLength.
	ErrMalformed = errors.New("safehttp: адрес не разбирается")
	// ErrOwnHost — адрес самого продукта (кабинет, формы).
	ErrOwnHost = errors.New("safehttp: адрес самого продукта")
	// ErrForbiddenAddress — адрес назначения во внутренней или служебной сети.
	ErrForbiddenAddress = errors.New("safehttp: адрес во внутренней сети")
	// ErrNotFound — имя не резолвится.
	ErrNotFound = errors.New("safehttp: имя не резолвится")
)

// Resolver — резолв имени при сохранении адреса; *net.Resolver его реализует.
// Соединение резолвит имя само — сюда подмена в тестах не дотягивается, и это
// правильно: проверку при соединении подменяет только Guard.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Options — настройка клиента. Нулевое значение годится для боя, кроме OwnHosts.
type Options struct {
	// OwnHosts — хосты самого продукта (APP_ORIGIN, PUBLIC_RENDERER_BASE_URL):
	// запрос туда запрещён. Сравнение без учёта регистра и завершающей точки.
	OwnHosts []string
	// Timeout — потолок запроса; ноль — DefaultTimeout.
	Timeout time.Duration
	// RootCAs — доверенные корни TLS; nil — системные. Задают только тесты
	// (сертификат httptest-сервера).
	RootCAs *x509.CertPool
	// Resolver — резолв при сохранении; nil — net.DefaultResolver.
	Resolver Resolver
}

// Client — исходящий HTTP по пользовательскому адресу. Безопасен для
// одновременного использования.
type Client struct {
	guard     Guard
	own       map[string]bool
	resolver  Resolver
	transport *http.Transport
	http      *http.Client
}

// Response — исход запроса. Тела нет: это чужой текст на чужом языке, до экрана он
// не доезжает, а в лог не пишется — в нём могут оказаться данные.
type Response struct {
	StatusCode int
	Duration   time.Duration
}

// New собирает клиент. guard — PublicOnly в боевой сборке, AllowAll в тестах.
func New(guard Guard, opts Options) *Client {
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	resolver := opts.Resolver
	if resolver == nil {
		resolver = net.DefaultResolver
	}
	own := make(map[string]bool, len(opts.OwnHosts))
	for _, h := range opts.OwnHosts {
		own[normalizeHost(h)] = true
	}
	c := &Client{guard: guard, own: own, resolver: resolver}

	dialer := &net.Dialer{Timeout: timeout, Control: c.control}
	c.transport = &http.Transport{
		// ⚠ Мина: ProxyFromEnvironment отдал бы соединение прокси из окружения, и
		// Control проверял бы адрес прокси, а не получателя.
		Proxy:       nil,
		DialContext: dialer.DialContext,
		TLSClientConfig: &tls.Config{
			RootCAs:    opts.RootCAs,
			MinVersion: tls.VersionTLS12,
		},
		// Со своим DialContext и TLSClientConfig HTTP/2 без этого флага выключен.
		ForceAttemptHTTP2:      true,
		TLSHandshakeTimeout:    timeout,
		ResponseHeaderTimeout:  timeout,
		MaxResponseHeaderBytes: BodyLimit,
		MaxIdleConns:           32,
		MaxIdleConnsPerHost:    2,
		IdleConnTimeout:        90 * time.Second,
	}
	c.http = &http.Client{
		Transport: c.transport,
		Timeout:   timeout,
		// Редирект не выполняется: 3xx возвращается вызывающему как исход. Иначе
		// публичный адрес перенаправлял бы во внутреннюю сеть, и проверять пришлось
		// бы каждый шаг.
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	return c
}

// control — проверка адреса, к которому реально идёт соединение: IP здесь уже
// после резолва. Неразборчивый адрес запрещается — отказ закрытым.
func (c *Client) control(_, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return fmt.Errorf("%w: %q", ErrForbiddenAddress, address)
	}
	if !c.guard.Allowed(ap.Addr()) {
		return fmt.Errorf("%w: %s", ErrForbiddenAddress, ap.Addr())
	}
	return nil
}

// Validate проверяет адрес при сохранении: разбор, схема, свои хосты и адреса,
// в которые имя резолвится СЕЙЧАС. Любой запрещённый адрес среди них — отказ.
//
// Это не защита, а внятный отказ сразу: DNS можно сменить после сохранения,
// поэтому то же правило действует при каждом соединении (control).
func (c *Client) Validate(ctx context.Context, raw string) (*url.URL, error) {
	u, err := c.parse(raw)
	if err != nil {
		return nil, err
	}
	host := u.Hostname()
	if ip, err := netip.ParseAddr(host); err == nil {
		if !c.guard.Allowed(ip) {
			return nil, fmt.Errorf("%w: %s", ErrForbiddenAddress, ip)
		}
		return u, nil
	}
	if !isASCII(host) {
		// Имя не латиницей (пример.рф): резолвер stdlib punycode не делает, а
		// net/http при соединении делает. Пред-проверка пропускается, control
		// проверит адрес при соединении.
		return u, nil
	}
	addrs, err := c.resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %w", ErrNotFound, host, err)
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("%w: %s", ErrNotFound, host)
	}
	for _, a := range addrs {
		if !c.guard.Allowed(a) {
			return nil, fmt.Errorf("%w: %s → %s", ErrForbiddenAddress, host, a)
		}
	}
	return u, nil
}

// Post отправляет body на адрес и возвращает код ответа. Не-2xx — не ошибка, а
// исход: как с ним быть, решает вызывающий. Ошибка — запрос не состоялся.
func (c *Client) Post(ctx context.Context, rawURL string, header http.Header, body []byte) (Response, error) {
	u, err := c.parse(rawURL)
	if err != nil {
		return Response{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return Response{}, fmt.Errorf("%w: %s", ErrMalformed, u.Hostname())
	}
	for k, v := range header {
		req.Header[k] = v
	}
	start := time.Now()
	resp, err := c.http.Do(req)
	if err != nil {
		// ⚠ Мина: *url.Error печатает адрес целиком, а в пути у Zapier и Make лежит
		// токен. Наружу уходит причина с одним хостом.
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return Response{}, fmt.Errorf("post %s: %w", u.Hostname(), err)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, BodyLimit))
	_ = resp.Body.Close()
	return Response{StatusCode: resp.StatusCode, Duration: time.Since(start)}, nil
}

// parse — разбор без сети: схема, форма, логин в адресе, свои хосты.
func (c *Client) parse(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > MaxURLLength {
		return nil, ErrMalformed
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, ErrMalformed
	}
	// Схема проверяется раньше формы: «example.com/hook» без схемы — это
	// «допишите https://», а не «адрес не разбирается».
	if u.Scheme != "https" {
		return nil, ErrScheme
	}
	if u.Opaque != "" || u.Hostname() == "" {
		return nil, ErrMalformed
	}
	if u.User != nil {
		return nil, ErrUserInfo
	}
	if c.own[normalizeHost(u.Hostname())] {
		return nil, ErrOwnHost
	}
	return u, nil
}

func normalizeHost(h string) string {
	return strings.ToLower(strings.TrimSuffix(h, "."))
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// Failure — род отказа запроса. По нему вызывающий решает, ретраить или считать
// цель сломанной, и выбирает человеческий текст причины.
type Failure int

const (
	// FailureOther — всё, что не распознано: обрыв, сброс соединения и прочее.
	FailureOther Failure = iota
	// FailureInvalidURL — адрес больше не проходит разбор (например, домен стал
	// своим после смены конфига). Сам собой не починится.
	FailureInvalidURL
	// FailureForbidden — адрес назначения во внутренней сети.
	FailureForbidden
	// FailureNotFound — имя не резолвится.
	FailureNotFound
	// FailureTLS — сертификат не прошёл проверку или на порту не TLS.
	FailureTLS
	// FailureRefused — соединение отклонено.
	FailureRefused
	// FailureTimeout — получатель не уложился в Timeout.
	FailureTimeout
)

// Classify раскладывает ошибку Validate или Post по родам.
//
// Порядок проверок несущий: отказ control и ошибка DNS приходят завёрнутыми в
// *net.OpError, который тоже умеет Timeout(), — проверь таймаут первым, и
// «адрес во внутренней сети» превратится в «не ответил вовремя».
func Classify(err error) Failure {
	var (
		dnsErr  *net.DNSError
		certErr *tls.CertificateVerificationError
		recErr  tls.RecordHeaderError
		netErr  net.Error
	)
	switch {
	case err == nil:
		return FailureOther
	case errors.Is(err, ErrScheme), errors.Is(err, ErrUserInfo),
		errors.Is(err, ErrMalformed), errors.Is(err, ErrOwnHost):
		return FailureInvalidURL
	case errors.Is(err, ErrForbiddenAddress):
		return FailureForbidden
	case errors.Is(err, ErrNotFound), errors.As(err, &dnsErr):
		return FailureNotFound
	case errors.As(err, &certErr), errors.As(err, &recErr):
		return FailureTLS
	case errors.Is(err, syscall.ECONNREFUSED):
		return FailureRefused
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, os.ErrDeadlineExceeded),
		errors.As(err, &netErr) && netErr.Timeout():
		return FailureTimeout
	default:
		return FailureOther
	}
}
