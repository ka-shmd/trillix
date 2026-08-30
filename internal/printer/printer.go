// Package printer — клиент сервиса печати: отдаёт адрес страницы, получает PDF.
//
// Печатает не этот код, а контейнер `printer` (cmd/printer): headless-Chromium в
// api-образ не кладётся — тот distroless и без shell (ADR §10). Здесь только
// HTTP-разговор с ним и ЕДИНСТВЕННОЕ ограничение, ради которого этот пакет
// существует: одновременных печатей не больше нескольких.
//
// Ограничение живёт у клиента, а не у сервиса печати, потому что защищать надо
// СЕБЯ: без него сотня одновременных запросов на PDF подняла бы сотню браузеров и
// съела память машины, на которой рядом работает Postgres.
package printer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"
)

// ErrBusy — все слоты печати заняты и ждать больше нельзя. Наружу это 503 с
// Retry-After, а не таймаут: честное «сейчас занято, повторите» лучше соединения,
// которое висит до дедлайна и обрывается.
var ErrBusy = errors.New("printer: all print slots busy")

// ErrUnreachable — до сервиса печати не достучались: он не поднят, лежит или адрес
// в конфиге не тот (классика — прод-адрес `http://printer:8090` в dev, где имени
// `printer` не существует). Отдельный сентинел, потому что наружу это 503
// «печать недоступна», а НЕ 500: код цел, не работает связь с соседним сервисом, и
// человеку у экрана надо сказать именно это.
var ErrUnreachable = errors.New("printer: service unreachable")

// maxPDFBytes — потолок размера ответа принтера. Печать ОДНОГО ответа формы — это
// единицы страниц; десять мегабайт означают, что печатается не то, что мы думаем,
// и читать это целиком в память не надо.
const maxPDFBytes = 10 << 20

// Client — клиент сервиса печати.
type Client struct {
	baseURL string
	http    *http.Client
	// slots — семафор одновременных печатей. Буферизованный канал, а не мьютекс:
	// его можно ждать вместе с отменой контекста.
	slots chan struct{}
	// waiting — сколько запросов сейчас стоит в очереди за слотом, и потолок этой
	// очереди. Семафор ограничивает БРАУЗЕРЫ, но не ждущих: без потолка сотня
	// одновременных кликов (или скрипт по списку ответов) даёт сотню горутин и
	// соединений, каждое из которых держится до своего дедлайна в четверть минуты.
	// Переполненная очередь отвечает сразу — «занято» лучше, чем ожидание, которое
	// всё равно не дождётся.
	waiting  atomic.Int64
	maxQueue int64
}

// New собирает клиента. concurrency — сколько документов печатается одновременно;
// timeout — потолок на одну печать (браузер, который завис на чужой картинке, не
// должен держать слот вечно).
func New(baseURL string, concurrency int, timeout time.Duration) *Client {
	if concurrency < 1 {
		concurrency = 1
	}
	return &Client{
		baseURL: baseURL,
		http:    &http.Client{Timeout: timeout},
		slots:   make(chan struct{}, concurrency),
		// Вчетверо больше, чем печатается одновременно: небольшая очередь сглаживает
		// всплеск (два человека нажали разом), большая — только копит ожидание.
		maxQueue: int64(concurrency) * 4,
	}
}

// PDF печатает страницу по ПУТИ на нашем же api и возвращает документ.
//
// Путь, а не полный адрес, — намеренно: origin знает сам сервис печати, и попросить
// его напечатать что-то за пределами нашего api нельзя в принципе. Иначе ручка
// печати превратилась бы в SSRF-примитив, который ходит куда скажут и приносит
// результат картинкой.
//
// Ожидание слота ограничено контекстом вызывающего: тот, кто ждёт дольше своего
// дедлайна, получает ErrBusy, а не растущую очередь.
func (c *Client) PDF(ctx context.Context, path string) ([]byte, error) {
	if n := c.waiting.Add(1); n > c.maxQueue {
		c.waiting.Add(-1)
		return nil, ErrBusy
	}
	select {
	case c.slots <- struct{}{}:
		c.waiting.Add(-1)
		defer func() { <-c.slots }()
	case <-ctx.Done():
		c.waiting.Add(-1)
		return nil, ErrBusy
	}

	body, err := json.Marshal(struct {
		Path string `json:"path"`
	}{Path: path})
	if err != nil {
		return nil, fmt.Errorf("printer: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/print", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("printer: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		// Причина внутри (dial, DNS, таймаут) остаётся в цепочке — она уезжает в лог
		// api и отвечает на вопрос «почему», — но снаружи это одно состояние.
		return nil, fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		// Тело ошибки читаем ограниченно: это текст нашего же сервиса, но полагаться
		// на его размер незачем.
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("printer: status %d: %s", resp.StatusCode, bytes.TrimSpace(msg))
	}

	pdf, err := io.ReadAll(io.LimitReader(resp.Body, maxPDFBytes+1))
	if err != nil {
		return nil, fmt.Errorf("printer: read response: %w", err)
	}
	if len(pdf) > maxPDFBytes {
		return nil, fmt.Errorf("printer: document larger than %d bytes", maxPDFBytes)
	}
	if !bytes.HasPrefix(pdf, []byte("%PDF-")) {
		// Признак того, что вместо документа приехала страница ошибки прокси или
		// чужой сервис по тому же адресу. Отдавать это автору под именем .pdf нельзя.
		return nil, errors.New("printer: response is not a PDF")
	}
	return pdf, nil
}

// Ping проверяет, отвечает ли сервис печати. Зовётся при старте api: опечатка в
// PRINTER_URL иначе всплывает только при первом клике по «Скачать PDF», у человека,
// который её не делал.
//
// Отказ НЕ роняет процесс: печать — не критичная подсистема, а принтер может
// подняться позже (в compose он стартует рядом, порядок не гарантирован).
func (c *Client) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/healthz", nil)
	if err != nil {
		return fmt.Errorf("printer: build ping: %w", err)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: healthz status %d", ErrUnreachable, resp.StatusCode)
	}
	return nil
}
