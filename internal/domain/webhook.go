package domain

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"
)

// ПОДПИСЬ ЗАПРОСА ВЕБХУКА (фаза 28 `DEV-PLAN`, контракт v1 — design/webhooks.md §7,
// ADR §10). Публичный контракт: получатель сверяет подпись своим кодом, и любая
// правка формата ломает всех, кто уже подключился.
//
// v1 = hex(HMAC-SHA256(секрет, t + "." + тело)), t — время отправки в секундах.
// Ключ HMAC — секрет РОВНО в том виде, в каком его видит автор формы (строкой, с
// префиксом): так проверка на стороне получателя — одна команда
// `openssl dgst -sha256 -hmac "$SECRET"`, без разбора формата секрета.
// Время внутри подписи защищает получателя от повтора перехваченного запроса.

// WebhookSignatureHeader — заголовок, в котором едет подпись.
const WebhookSignatureHeader = "Trillix-Signature"

// SignWebhook — значение заголовка подписи: `t=<unix>,v1=<hex>`.
func SignWebhook(secret string, at time.Time, body []byte) string {
	ts := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	mac.Write([]byte{'.'})
	mac.Write(body)
	return "t=" + ts + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}
