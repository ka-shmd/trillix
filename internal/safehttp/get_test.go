package safehttp

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestGet_ReturnsBody(t *testing.T) {
	srv, _ := tlsServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("0123456789"))
	})
	c := New(AllowAll{}, Options{RootCAs: trusting(srv)})

	// Тело ровно в потолок — не «больше потолка».
	resp, body, err := c.Get(context.Background(), srv.URL+"/pic.png", 10)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if resp.StatusCode != http.StatusOK || string(body) != "0123456789" {
		t.Fatalf("код %d, тело %q", resp.StatusCode, body)
	}
}

func TestGet_BodyOverLimit(t *testing.T) {
	srv, _ := tlsServer(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("0123456789A"))
	})
	c := New(AllowAll{}, Options{RootCAs: trusting(srv)})

	_, body, err := c.Get(context.Background(), srv.URL+"/pic.png", 10)
	if !errors.Is(err, ErrBodyTooLarge) {
		t.Fatalf("err = %v, ожидался ErrBodyTooLarge", err)
	}
	if body != nil {
		t.Fatal("обрезанное тело не должно возвращаться")
	}
}

// Редирект не выполняется и у Get: 3xx приходит вызывающему исходом, тела нет.
func TestGet_RedirectIsOutcome(t *testing.T) {
	srv, hits := tlsServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://127.0.0.1/secret", http.StatusFound)
	})
	c := New(AllowAll{}, Options{RootCAs: trusting(srv)})

	resp, body, err := c.Get(context.Background(), srv.URL+"/pic.png", 10)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if resp.StatusCode != http.StatusFound || body != nil || hits.Load() != 1 {
		t.Fatalf("код %d, тело %q, запросов %d — ожидался один 302 без тела", resp.StatusCode, body, hits.Load())
	}
}

func TestGet_ForbidsLoopbackAtConnect(t *testing.T) {
	srv, hits := tlsServer(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	c := New(PublicOnly{}, Options{RootCAs: trusting(srv)})

	_, _, err := c.Get(context.Background(), srv.URL+"/pic.png", 10)
	if Classify(err) != FailureForbidden {
		t.Fatalf("Classify = %v (%v), ожидался FailureForbidden", Classify(err), err)
	}
	if hits.Load() != 0 {
		t.Fatal("запрос дошёл до сервера во внутренней сети")
	}
}
