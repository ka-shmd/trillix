package printer

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// ОЧЕРЕДЬ ПЕЧАТИ ОГРАНИЧЕНА. Семафор держит число одновременных браузеров, но без
// потолка очереди сотня кликов подряд (или скрипт по списку ответов) дала бы сотню
// горутин и соединений, каждое из которых ждёт своего дедлайна. Лишние обязаны
// получить отказ СРАЗУ.
//
// Печати запускаются ПО ОДНОЙ, с ожиданием после каждой: пачка горутин наперегонки
// дала бы недетерминированное число ожидающих и флаки-тест.
func TestPDF_QueueIsBounded(t *testing.T) {
	var inHandler atomic.Int64
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		inHandler.Add(1)
		<-release // держим печать, пока тест не отпустит
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = w.Write([]byte("%PDF-1.7 ok"))
	}))

	const concurrency = 2
	c := New(srv.URL, concurrency, 5*time.Second)

	var wg sync.WaitGroup
	start := func() {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.PDF(context.Background(), "/internal/print/doc/x")
		}()
	}

	// Слоты: печать занимает слот и доходит до сервера.
	for i := 1; i <= concurrency; i++ {
		start()
		waitFor(t, func() bool { return inHandler.Load() >= int64(i) })
	}
	// Очередь: слотов больше нет, каждая следующая печать встаёт в ожидание.
	for i := int64(1); i <= c.maxQueue; i++ {
		start()
		waitFor(t, func() bool { return c.waiting.Load() >= i })
	}

	if _, err := c.PDF(context.Background(), "/internal/print/doc/y"); !errors.Is(err, ErrBusy) {
		t.Errorf("сверх очереди получили %v, ждали ErrBusy", err)
	}

	unblock()
	wg.Wait()
	srv.Close()

	// Очередь рассосалась целиком: счётчик ожидающих не должен «протекать» — иначе
	// после всплеска печать отказывала бы навсегда.
	if left := c.waiting.Load(); left != 0 {
		t.Errorf("после разбора очереди ожидающих %d, ждали 0", left)
	}
}

// Недоступный сервис печати — ErrUnreachable, а не безымянная ошибка: наружу это
// 503 «печать недоступна», и отличать его от «занято» и от поломки обязан вызывающий.
func TestPDF_UnreachableIsTyped(t *testing.T) {
	c := New("http://127.0.0.1:1", 1, time.Second)

	if _, err := c.PDF(context.Background(), "/internal/print/doc/x"); !errors.Is(err, ErrUnreachable) {
		t.Errorf("получили %v, ждали ErrUnreachable", err)
	}
	if err := c.Ping(context.Background()); !errors.Is(err, ErrUnreachable) {
		t.Errorf("ping вернул %v, ждали ErrUnreachable", err)
	}
}

// Ответ, который не начинается с %PDF-, отвергается: под именем .pdf нельзя отдавать
// страницу ошибки чужого прокси.
func TestPDF_RejectsNonPDF(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>что-то другое</html>"))
	}))
	defer srv.Close()

	if _, err := New(srv.URL, 1, time.Second).PDF(context.Background(), "/internal/print/doc/x"); err == nil {
		t.Error("не-PDF принят, ждали отказ")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("состояние не наступило за 3 с")
		}
		time.Sleep(time.Millisecond)
	}
}
