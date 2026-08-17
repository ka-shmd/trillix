package blob

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// AWS Signature Version 4 для S3-совместимого API. Своя реализация вместо SDK:
// нужны подписи Put/Delete/Head и presigned-адреса (presign.go); публичное чтение
// картинок идёт голым URL без подписи. Поверхность мала — зависимость сверх
// замороженного списка не оправдана
// (internal/CLAUDE.md). Корректность подписи проверяется интеграционным тестом
// против настоящего MinIO (blob_integration_test.go): неверная канонизация даёт
// SignatureDoesNotMatch — сильнее золотого вектора.
//
// Ключи объектов ограничены S3-безопасными символами (unreserved + «/»): так
// EscapedPath net/http и uriEncode совпадают байт-в-байт, и подпись сходится с
// тем, что реально ушло в сеть. MediaStore это гарантирует (ключ = uuid/hex.ext).

const (
	algorithm  = "AWS4-HMAC-SHA256"
	service    = "s3"
	terminator = "aws4_request"
	amzDateFmt = "20060102T150405Z"
	dateFmt    = "20060102"
)

// sign проставляет заголовки X-Amz-Date, X-Amz-Content-Sha256 и Authorization по
// sigv4. payloadHash — hex(sha256(тела)); тело в req уже установлено вызывающим.
func (c *Client) sign(req *http.Request, payloadHash string, now time.Time) {
	amzDate := now.UTC().Format(amzDateFmt)
	date := now.UTC().Format(dateFmt)

	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)

	signedHeaders, canonicalHeaders := canonicalHeaders(req)

	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI(req.URL),
		canonicalQuery(req.URL),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := strings.Join([]string{date, c.cfg.Region, service, terminator}, "/")
	stringToSign := strings.Join([]string{
		algorithm,
		amzDate,
		scope,
		hexSHA256([]byte(canonicalRequest)),
	}, "\n")

	key := deriveSigningKey(c.cfg.SecretKey, date, c.cfg.Region, service)
	signature := hex.EncodeToString(hmacSHA256(key, []byte(stringToSign)))

	req.Header.Set("Authorization", fmt.Sprintf(
		"%s Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		algorithm, c.cfg.AccessKey, scope, signedHeaders, signature))
}

// canonicalHeaders собирает подписываемые заголовки (host, content-type при
// наличии, x-amz-*) в канонический вид и список их имён через «;».
func canonicalHeaders(req *http.Request) (signed, canonical string) {
	headers := map[string]string{
		"host":                 req.URL.Host,
		"x-amz-content-sha256": req.Header.Get("X-Amz-Content-Sha256"),
		"x-amz-date":           req.Header.Get("X-Amz-Date"),
	}
	if ct := req.Header.Get("Content-Type"); ct != "" {
		headers["content-type"] = ct
	}
	return canonicalizeHeaders(headers)
}

// canonicalizeHeaders — общий вид набора «имя (нижним регистром) → значение» для
// канонического запроса: значения без крайних пробелов, имена отсортированы.
func canonicalizeHeaders(headers map[string]string) (signed, canonical string) {
	names := make([]string, 0, len(headers))
	for n := range headers {
		names = append(names, n)
	}
	sort.Strings(names)

	var b strings.Builder
	for _, n := range names {
		b.WriteString(n)
		b.WriteByte(':')
		b.WriteString(strings.TrimSpace(headers[n]))
		b.WriteByte('\n')
	}
	return strings.Join(names, ";"), b.String()
}

// canonicalURI — путь запроса, покомпонентно URI-кодированный (слэши-разделители
// сохраняются). Для безопасных ключей совпадает с тем, что шлёт net/http.
func canonicalURI(u *url.URL) string {
	if u.Path == "" {
		return "/"
	}
	return uriEncode(u.Path, false)
}

// canonicalQuery — отсортированная кодированная query-строка. Текущие операции
// query не используют (вернёт ""); реализовано корректно на будущее.
func canonicalQuery(u *url.URL) string {
	return canonicalQueryValues(u.Query())
}

// canonicalQueryValues — та же канонизация от готового набора значений. Её
// результат годится и как RawQuery: кодирование по RFC 3986 (пробел — %20, а не
// «+», как у url.Values.Encode), то есть то, что уходит в сеть, совпадает с тем,
// что подписано, — иначе подпись не сходится на первом же значении с пробелом.
func canonicalQueryValues(vals url.Values) string {
	if len(vals) == 0 {
		return ""
	}
	keys := make([]string, 0, len(vals))
	for k := range vals {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var parts []string
	for _, k := range keys {
		vs := append([]string(nil), vals[k]...)
		sort.Strings(vs)
		for _, v := range vs {
			parts = append(parts, uriEncode(k, true)+"="+uriEncode(v, true))
		}
	}
	return strings.Join(parts, "&")
}

// deriveSigningKey — цепочка HMAC-SHA256 из секрета: kDate→kRegion→kService→kSigning
// (сервис параметризован, чтобы покрыть цепочку хермётичным тестом по вектору AWS).
func deriveSigningKey(secret, date, region, svc string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), []byte(date))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(svc))
	return hmacSHA256(kService, []byte(terminator))
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func hexSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// uriEncode кодирует по правилам AWS: не трогает unreserved (A-Za-z0-9-._~), всё
// прочее — %XX верхним регистром. encodeSlash=false сохраняет «/» (путь), true
// кодирует и его (значения query).
func uriEncode(s string, encodeSlash bool) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '.', c == '_', c == '~':
			b.WriteByte(c)
		case c == '/' && !encodeSlash:
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
