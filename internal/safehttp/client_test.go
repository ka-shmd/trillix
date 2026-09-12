package safehttp

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// fakeResolver — резолв при сохранении без сети. Имя, которого нет в карте, не
// резолвится; каждый вызов считается.
type fakeResolver struct {
	hosts map[string][]string
	calls atomic.Int32
}

func (r *fakeResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.calls.Add(1)
	ss, ok := r.hosts[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	out := make([]netip.Addr, len(ss))
	for i, s := range ss {
		out[i] = netip.MustParseAddr(s)
	}
	return out, nil
}

func TestValidate(t *testing.T) {
	res := &fakeResolver{hosts: map[string][]string{
		"hooks.zapier.com":  {"3.221.30.10", "2600:1f18::1"},
		"internal.example":  {"10.0.0.5"},
		"mixed.example":     {"93.184.216.34", "10.0.0.5"},
		"metadata.example":  {"169.254.169.254"},
		"mapped.example":    {"::ffff:127.0.0.1"},
		"example.com":       {"93.184.216.34"},
		"app.trillix.ru":    {"93.184.216.34"},
		"docker-db.example": {"172.18.0.2"},
	}}
	c := New(PublicOnly{}, Options{
		OwnHosts: []string{"app.trillix.ru", "F.trillix.ru"},
		Resolver: res,
	})

	cases := []struct {
		raw  string
		want error // nil — адрес принят
	}{
		{"https://hooks.zapier.com/hooks/catch/1/abc", nil},
		{"  https://example.com/hook?x=1  ", nil},
		{"https://example.com:8443/hook", nil},

		{"http://example.com/hook", ErrScheme},
		{"example.com/hook", ErrScheme},
		{"ftp://example.com/", ErrScheme},
		{"https://user:pass@example.com/", ErrUserInfo},
		{"https://token@example.com/", ErrUserInfo},
		{"", ErrMalformed},
		{"   ", ErrMalformed},
		{"https://", ErrMalformed},
		{"https:///path", ErrMalformed},
		{"https:opaque", ErrMalformed},
		{"https://example.com/" + strings.Repeat("a", MaxURLLength), ErrMalformed},
		{"https://exa mple.com/", ErrMalformed},

		{"https://app.trillix.ru/api/v1/x", ErrOwnHost},
		{"https://APP.trillix.ru./x", ErrOwnHost},
		{"https://f.trillix.ru/r/slug", ErrOwnHost},

		{"https://127.0.0.1/", ErrForbiddenAddress},
		{"https://[::1]:8443/", ErrForbiddenAddress},
		{"https://169.254.169.254/latest/meta-data", ErrForbiddenAddress},
		{"https://internal.example/", ErrForbiddenAddress},
		{"https://mixed.example/", ErrForbiddenAddress},
		{"https://metadata.example/", ErrForbiddenAddress},
		{"https://mapped.example/", ErrForbiddenAddress},
		{"https://docker-db.example/", ErrForbiddenAddress},

		{"https://nx.example/", ErrNotFound},
	}
	for _, tc := range cases {
		u, err := c.Validate(context.Background(), tc.raw)
		if tc.want == nil {
			if err != nil {
				t.Errorf("Validate(%q): %v, ожидался успех", tc.raw, err)
				continue
			}
			if u.Hostname() == "" {
				t.Errorf("Validate(%q): пустой хост", tc.raw)
			}
			continue
		}
		if !errors.Is(err, tc.want) {
			t.Errorf("Validate(%q) = %v, ожидалось %v", tc.raw, err, tc.want)
		}
	}
}

// Адрес-литерал и имя не латиницей резолвер не спрашивают: первому нечего
// резолвить, второе stdlib без punycode не разрешит — его проверит соединение.
func TestValidate_SkipsResolverWhenNothingToResolve(t *testing.T) {
	res := &fakeResolver{}
	c := New(PublicOnly{}, Options{Resolver: res})
	for _, raw := range []string{"https://8.8.8.8/hook", "https://[2606:4700::1111]/hook", "https://пример.рф/hook"} {
		if _, err := c.Validate(context.Background(), raw); err != nil {
			t.Errorf("Validate(%q): %v", raw, err)
		}
	}
	if n := res.calls.Load(); n != 0 {
		t.Fatalf("резолвер спрошен %d раз, ожидалось ни одного", n)
	}
}

func TestValidate_AllowAllAcceptsLoopback(t *testing.T) {
	c := New(AllowAll{}, Options{Resolver: &fakeResolver{}})
	if _, err := c.Validate(context.Background(), "https://127.0.0.1:8443/hook"); err != nil {
		t.Fatalf("AllowAll обязан пускать loopback тестового сервера: %v", err)
	}
}

// tlsServer — httptest-сервер и клиент, который ему доверяет. Каждый входящий
// запрос считается: «сервер не видел запроса» — главный признак сработавшей защиты.
func tlsServer(t *testing.T, h http.HandlerFunc) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func trusting(srv *httptest.Server) *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	return pool
}

func TestPost_Delivers(t *testing.T) {
	var gotBody, gotSig, gotType string
	srv, _ := tlsServer(t, func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody, gotSig, gotType = string(b), r.Header.Get("Trillix-Signature"), r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusAccepted)
	})
	c := New(AllowAll{}, Options{RootCAs: trusting(srv)})

	header := http.Header{}
	header.Set("Content-Type", "application/json")
	header.Set("Trillix-Signature", "t=1,v1=ab")
	resp, err := c.Post(context.Background(), srv.URL+"/hook", header, []byte(`{"version":1}`))
	if err != nil {
		t.Fatalf("Post: %v", err)
	}
	if resp.StatusCode != http.StatusAccepted {
		t.Fatalf("код = %d, ожидалось 202", resp.StatusCode)
	}
	if gotBody != `{"version":1}` || gotSig != "t=1,v1=ab" || gotType != "application/json" {
		t.Fatalf("получатель увидел тело %q, подпись %q, тип %q", gotBody, gotSig, gotType)
	}
}

// Защита живёт в соединении, а не в разборе адреса: PublicOnly не даёт соединиться
// с loopback, и получатель запроса не видит вовсе.
func TestPost_ForbidsLoopbackAtConnect(t *testing.T) {
	srv, hits := tlsServer(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	c := New(PublicOnly{}, Options{RootCAs: trusting(srv)})

	_, err := c.Post(context.Background(), srv.URL+"/hook", nil, nil)
	if Classify(err) != FailureForbidden {
		t.Fatalf("Classify = %v (%v), ожидался FailureForbidden", Classify(err), err)
	}
	if hits.Load() != 0 {
		t.Fatal("запрос дошёл до получателя во внутренней сети")
	}
}

// Имя, которое резолвится во внутренний адрес, отсекается при соединении —
// ровно так выглядит смена DNS после сохранения: Validate адрес пропустил, а
// соединение идёт уже по новому ответу DNS.
func TestPost_ForbidsNameResolvingToLoopback(t *testing.T) {
	srv, hits := tlsServer(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	c := New(PublicOnly{}, Options{RootCAs: trusting(srv)})

	_, err := c.Post(context.Background(), fmt.Sprintf("https://localhost:%d/hook", port), nil, nil)
	if Classify(err) != FailureForbidden {
		t.Fatalf("Classify = %v (%v), ожидался FailureForbidden", Classify(err), err)
	}
	if hits.Load() != 0 {
		t.Fatal("запрос дошёл до получателя во внутренней сети")
	}
}

// Токен в пути адреса — секрет (Zapier, Make): текст ошибки его не несёт, иначе
// он уехал бы в лог вместе с причиной.
func TestPost_ErrorDoesNotCarryPath(t *testing.T) {
	srv, _ := tlsServer(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	c := New(PublicOnly{}, Options{RootCAs: trusting(srv)})

	_, err := c.Post(context.Background(), srv.URL+"/hooks/catch/123/SECRETTOKEN?k=QUERYSECRET", nil, nil)
	if err == nil {
		t.Fatal("ожидался отказ")
	}
	if s := err.Error(); strings.Contains(s, "SECRETTOKEN") || strings.Contains(s, "QUERYSECRET") {
		t.Fatalf("текст ошибки несёт путь адреса: %s", s)
	}
}

func TestPost_DoesNotFollowRedirects(t *testing.T) {
	var followed atomic.Bool
	srv, _ := tlsServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/next" {
			followed.Store(true)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, "/next", http.StatusTemporaryRedirect)
	})
	c := New(AllowAll{}, Options{RootCAs: trusting(srv)})

	resp, err := c.Post(context.Background(), srv.URL+"/hook", nil, nil)
	if err != nil {
		t.Fatalf("Post: %v", err)
	}
	if resp.StatusCode != http.StatusTemporaryRedirect {
		t.Fatalf("код = %d, ожидался 307 как исход", resp.StatusCode)
	}
	if followed.Load() {
		t.Fatal("редирект выполнен")
	}
}

// Прокси из окружения не используется: проверять пришлось бы адрес прокси, а не
// получателя. Проверяется устройством транспорта — поведенческий тест здесь
// бессилен: net/http сам не ходит через прокси к localhost.
func TestPost_IgnoresEnvironmentProxy(t *testing.T) {
	c := New(PublicOnly{}, Options{})
	if c.transport.Proxy != nil {
		t.Fatal("у транспорта задан Proxy — соединение ушло бы через прокси мимо control")
	}
}

func TestPost_Timeout(t *testing.T) {
	srv, _ := tlsServer(t, func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
	})
	c := New(AllowAll{}, Options{RootCAs: trusting(srv), Timeout: 150 * time.Millisecond})

	start := time.Now()
	_, err := c.Post(context.Background(), srv.URL+"/hook", nil, nil)
	if Classify(err) != FailureTimeout {
		t.Fatalf("Classify = %v (%v), ожидался FailureTimeout", Classify(err), err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Post вернулся через %s — потолок запроса не держится", d)
	}
}

// Бесконечное тело ответа не держит слот: дочитали BodyLimit и закрыли.
func TestPost_EndlessBodyDoesNotHang(t *testing.T) {
	srv, _ := tlsServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		chunk := []byte(strings.Repeat("x", 32<<10))
		for r.Context().Err() == nil {
			if _, err := w.Write(chunk); err != nil {
				return
			}
			w.(http.Flusher).Flush()
		}
	})
	const timeout = 3 * time.Second
	c := New(AllowAll{}, Options{RootCAs: trusting(srv), Timeout: timeout})

	start := time.Now()
	resp, err := c.Post(context.Background(), srv.URL+"/hook", nil, nil)
	if err != nil {
		t.Fatalf("Post: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("код = %d", resp.StatusCode)
	}
	// Без потолка тело читалось бы до таймаута запроса, и исход всё равно
	// выглядел бы успехом — различает их только время.
	if d := time.Since(start); d > timeout/2 {
		t.Fatalf("Post вернулся через %s — тело дочитывалось до таймаута", d)
	}
}

func TestPost_UntrustedCertificateIsTLSFailure(t *testing.T) {
	srv, hits := tlsServer(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	c := New(AllowAll{}, Options{}) // системные корни — сертификату httptest не доверяют

	_, err := c.Post(context.Background(), srv.URL+"/hook", nil, nil)
	if Classify(err) != FailureTLS {
		t.Fatalf("Classify = %v (%v), ожидался FailureTLS", Classify(err), err)
	}
	if hits.Load() != 0 {
		t.Fatal("запрос ушёл по непроверенному TLS")
	}
}

// Адрес, ставший недопустимым после сохранения (например, домен стал своим при
// смене конфига), отказывает без сети.
func TestPost_RechecksURL(t *testing.T) {
	c := New(AllowAll{}, Options{OwnHosts: []string{"app.trillix.ru"}})
	_, err := c.Post(context.Background(), "https://app.trillix.ru/hook", nil, nil)
	if Classify(err) != FailureInvalidURL {
		t.Fatalf("Classify = %v (%v), ожидался FailureInvalidURL", Classify(err), err)
	}
}

func TestClassify(t *testing.T) {
	opErr := func(err error) error {
		return &url.Error{Op: "Post", URL: "https://x", Err: &net.OpError{Op: "dial", Net: "tcp", Err: err}}
	}
	cases := []struct {
		name string
		err  error
		want Failure
	}{
		{"нет ошибки", nil, FailureOther},
		{"схема", ErrScheme, FailureInvalidURL},
		{"логин в адресе", ErrUserInfo, FailureInvalidURL},
		{"свой хост", fmt.Errorf("x: %w", ErrOwnHost), FailureInvalidURL},
		{"запрет в control", opErr(fmt.Errorf("%w: 10.0.0.1", ErrForbiddenAddress)), FailureForbidden},
		{"DNS при соединении", opErr(&net.DNSError{Err: "no such host", Name: "x", IsNotFound: true}), FailureNotFound},
		{"DNS с таймаутом — всё равно DNS", opErr(&net.DNSError{Err: "timeout", Name: "x", IsTimeout: true}), FailureNotFound},
		{"DNS при сохранении", fmt.Errorf("%w: x", ErrNotFound), FailureNotFound},
		{"сертификат", &tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, FailureTLS},
		{"не TLS на порту", fmt.Errorf("post x: %w", tls.RecordHeaderError{Msg: "first record does not look like a TLS handshake"}), FailureTLS},
		{"отказ соединения", opErr(os.NewSyscallError("connect", syscall.ECONNREFUSED)), FailureRefused},
		{"дедлайн контекста", fmt.Errorf("post x: %w", context.DeadlineExceeded), FailureTimeout},
		{"дедлайн сокета", opErr(os.ErrDeadlineExceeded), FailureTimeout},
		{"сброс соединения", opErr(os.NewSyscallError("read", syscall.ECONNRESET)), FailureOther},
		{"прочее", errors.New("unexpected EOF"), FailureOther},
	}
	for _, tc := range cases {
		if got := Classify(tc.err); got != tc.want {
			t.Errorf("%s: Classify = %v, ожидалось %v", tc.name, got, tc.want)
		}
	}
}
