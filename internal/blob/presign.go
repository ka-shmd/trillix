package blob

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Presigned-адреса: подпись sigv4, вынесенная в query, — право совершить ОДИН
// запрос к хранилищу без наших ключей. Первый потребитель — файлы в ответах
// (docs/design/answer-files.md): респондент кладёт байты прямо в бакет, минуя Go,
// а автор скачивает их коротким GET.
//
// Такой адрес — учётные данные: его нельзя логировать и нельзя класть в выгрузку.
// Всё, что ограничивает загрузку, обязано быть ВНУТРИ подписи — то, что проверяет
// только наш HTTP-слой, для владельца адреса не существует.

const (
	unsignedPayload = "UNSIGNED-PAYLOAD"
	// maxPresignExpiry — потолок жизни подписи в S3 (семь суток). Значение выше
	// хранилище отвергнет уже на запросе, поэтому отсекается здесь.
	maxPresignExpiry = 7 * 24 * time.Hour
)

// PutOptions — условия, зашиваемые в подпись загрузки. ContentLength и ContentType
// попадают в SignedHeaders: запрос с другим размером или типом хранилище отклонит
// само. Это и есть механизм, которым держатся лимиты — проверка на нашей стороне
// осталась бы за спиной у того, кто получил адрес.
type PutOptions struct {
	ContentType   string
	ContentLength int64
	Expires       time.Duration
}

// GetOptions — условия выдачи. Оба переопределения обязательны для пользовательских
// файлов: браузер обязан скачать вложение, а не открыть чужой HTML в контексте
// хранилища (docs/design/answer-files.md §5).
type GetOptions struct {
	Expires time.Duration
	// ResponseContentType переопределяет Content-Type ответа (S3 response-content-type).
	ResponseContentType string
	// ResponseDisposition переопределяет Content-Disposition ответа; имя файла
	// кодирует вызывающий (RFC 5987) — здесь значение уже готово.
	ResponseDisposition string
}

// PresignPut выдаёт адрес для загрузки объекта. Клиент обязан прислать ровно тот
// Content-Length и Content-Type, что зашиты в подпись.
func (c *Client) PresignPut(bucket, key string, opt PutOptions, now time.Time) (string, error) {
	if opt.ContentLength <= 0 {
		return "", fmt.Errorf("blob: presign PUT %s/%s: content length must be positive", bucket, key)
	}
	headers := map[string]string{
		"content-length": strconv.FormatInt(opt.ContentLength, 10),
	}
	if opt.ContentType != "" {
		headers["content-type"] = opt.ContentType
	}
	return c.presign("PUT", bucket, key, headers, nil, opt.Expires, now)
}

// PresignGet выдаёт адрес для скачивания объекта.
func (c *Client) PresignGet(bucket, key string, opt GetOptions, now time.Time) (string, error) {
	query := url.Values{}
	if opt.ResponseContentType != "" {
		query.Set("response-content-type", opt.ResponseContentType)
	}
	if opt.ResponseDisposition != "" {
		query.Set("response-content-disposition", opt.ResponseDisposition)
	}
	return c.presign("GET", bucket, key, nil, query, opt.Expires, now)
}

// presign собирает адрес с подписью в query. Тело не подписывается
// (UNSIGNED-PAYLOAD): на момент выдачи адреса байтов ещё нет, и предподписать их
// хеш нельзя — размер держит подписанный content-length.
func (c *Client) presign(
	method, bucket, key string,
	headers map[string]string,
	query url.Values,
	expires time.Duration,
	now time.Time,
) (string, error) {
	if expires <= 0 || expires > maxPresignExpiry {
		return "", fmt.Errorf("blob: presign %s %s/%s: expires %v out of range (0, %v]",
			method, bucket, key, expires, maxPresignExpiry)
	}
	u, err := c.objectURL(bucket, key)
	if err != nil {
		return "", err
	}

	amzDate := now.UTC().Format(amzDateFmt)
	date := now.UTC().Format(dateFmt)
	scope := strings.Join([]string{date, c.cfg.Region, service, terminator}, "/")

	signable := map[string]string{"host": u.Host}
	for n, v := range headers {
		signable[n] = v
	}
	signedHeaders, canonicalHeaders := canonicalizeHeaders(signable)

	if query == nil {
		query = url.Values{}
	}
	query.Set("X-Amz-Algorithm", algorithm)
	query.Set("X-Amz-Credential", c.cfg.AccessKey+"/"+scope)
	query.Set("X-Amz-Date", amzDate)
	query.Set("X-Amz-Expires", strconv.Itoa(int(expires.Seconds())))
	query.Set("X-Amz-SignedHeaders", signedHeaders)
	canonical := canonicalQueryValues(query)

	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI(u),
		canonical,
		canonicalHeaders,
		signedHeaders,
		unsignedPayload,
	}, "\n")

	stringToSign := strings.Join([]string{
		algorithm,
		amzDate,
		scope,
		hexSHA256([]byte(canonicalRequest)),
	}, "\n")

	signingKey := deriveSigningKey(c.cfg.SecretKey, date, c.cfg.Region, service)
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	// Подпись дописывается последней и в канонизацию не входит (правило sigv4);
	// hex безопасен для query, кодировать его нечем.
	u.RawQuery = canonical + "&X-Amz-Signature=" + signature
	return u.String(), nil
}
