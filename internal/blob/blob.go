// Package blob — агностичный клиент S3-совместимого объектного хранилища (слой-1
// подсистемы медиа, docs/DESIGN-s3-media.md). Знает только транспорт: подписанные
// sigv4 запросы PUT/GET/DELETE и создание бакета; не знает слов «картинка»/«форма».
// Один на всё приложение; доменные хранилища (MediaStore и будущий UploadStore
// Фазы 17) — надстройка над ним, а каждый потребитель объявляет свой узкий
// интерфейс (конвенция internal/CLAUDE.md), а не тянет весь клиент.
//
// Провайдеро-независим: и MinIO (dev/prod-local), и арендованное S3 (прод) говорят
// на одном протоколе — различие контуров живёт в Config (endpoint/creds/bucket),
// код один. Секрет (SecretKey) не логируется (инвариант 7).
package blob

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// ErrNotFound — объект (или бакет) отсутствует: ответ 404. Отдельный сентинел,
// чтобы потребитель отличал «нет объекта» от транспортной ошибки.
var ErrNotFound = errors.New("blob: object not found")

// Config — параметры подключения к хранилищу. PathStyle=true (endpoint/bucket/key)
// требуется MinIO и большинством РФ-провайдеров; false — virtual-hosted
// (bucket.endpoint), путь AWS по умолчанию.
type Config struct {
	Endpoint  string // scheme://host[:port], без пути
	Region    string // регион подписи (MinIO игнорирует, но подпись его включает)
	AccessKey string
	SecretKey string // секрет: не логировать
	PathStyle bool
}

// Client — S3-клиент. Потокобезопасен (иммутабелен после New).
type Client struct {
	cfg  Config
	http *http.Client
}

// New строит клиент. Таймаут — верхняя граница на запрос (картинки малы); отмена
// через контекст соблюдается независимо.
func New(cfg Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: 60 * time.Second}}
}

// CreateBucket создаёт бакет (PUT /bucket). Идемпотентен: «уже существует» (owned
// by you) ошибкой не считается. В проде бакеты заводит init-контейнер mc; метод
// нужен интеграционным тестам и одноразовому бутстрапу.
func (c *Client) CreateBucket(ctx context.Context, bucket string) error {
	resp, err := c.do(ctx, http.MethodPut, bucket, "", nil, "")
	if err != nil {
		return err
	}
	defer drain(resp)
	if resp.StatusCode == http.StatusConflict || resp.StatusCode == http.StatusOK {
		return nil
	}
	return classify(resp, http.MethodPut, bucket, "")
}

// PutObject кладёт объект. data целиком в памяти (картинки малы) — payload
// подписывается по sha256 без chunked-signing. contentType проставляется на
// объекте и отдаётся при чтении.
func (c *Client) PutObject(ctx context.Context, bucket, key string, data []byte, contentType string) error {
	resp, err := c.do(ctx, http.MethodPut, bucket, key, data, contentType)
	if err != nil {
		return err
	}
	defer drain(resp)
	return classify(resp, http.MethodPut, bucket, key)
}

// GetObject читает объект целиком. 404 → ErrNotFound. Публичное чтение в проде
// идёт мимо Go (Caddy→бакет); метод нужен тестам и будущим серверным читателям.
func (c *Client) GetObject(ctx context.Context, bucket, key string) (data []byte, contentType string, err error) {
	resp, err := c.do(ctx, http.MethodGet, bucket, key, nil, "")
	if err != nil {
		return nil, "", err
	}
	defer drain(resp)
	if err := classify(resp, http.MethodGet, bucket, key); err != nil {
		return nil, "", err
	}
	data, err = io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", fmt.Errorf("blob: read GET %s/%s: %w", bucket, key, err)
	}
	return data, resp.Header.Get("Content-Type"), nil
}

// DeleteObject удаляет объект. Отсутствующий ключ S3 считает успехом (204).
func (c *Client) DeleteObject(ctx context.Context, bucket, key string) error {
	resp, err := c.do(ctx, http.MethodDelete, bucket, key, nil, "")
	if err != nil {
		return err
	}
	defer drain(resp)
	return classify(resp, http.MethodDelete, bucket, key)
}

// do собирает подписанный запрос и выполняет его. body=nil — пустое тело (его
// sha256 подписывается как для GET/DELETE).
func (c *Client) do(ctx context.Context, method, bucket, key string, body []byte, contentType string) (*http.Response, error) {
	u, err := c.objectURL(bucket, key)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("blob: build request: %w", err)
	}
	req.ContentLength = int64(len(body))
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	c.sign(req, hexSHA256(body), time.Now())

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("blob: %s %s/%s: %w", method, bucket, key, err)
	}
	return resp, nil
}

// objectURL строит адрес объекта в выбранном стиле адресации.
func (c *Client) objectURL(bucket, key string) (*url.URL, error) {
	u, err := url.Parse(c.cfg.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("blob: bad endpoint %q: %w", c.cfg.Endpoint, err)
	}
	if c.cfg.PathStyle {
		u.Path = "/" + bucket
		if key != "" {
			u.Path += "/" + key
		}
	} else {
		u.Host = bucket + "." + u.Host
		u.Path = "/" + key
	}
	return u, nil
}

// classify превращает не-2xx ответ в ошибку (404 → ErrNotFound), читая тело
// ограниченно (S3 отдаёт XML с описанием; секретов там нет).
func classify(resp *http.Response, method, bucket, key string) error {
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	if resp.StatusCode == http.StatusNotFound {
		return ErrNotFound
	}
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	return fmt.Errorf("blob: %s %s/%s: status %d: %s", method, bucket, key, resp.StatusCode, bytes.TrimSpace(msg))
}

// drain дочитывает и закрывает тело, чтобы соединение вернулось в пул.
func drain(resp *http.Response) {
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}
