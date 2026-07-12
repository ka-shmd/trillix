// Package token выдаёт и проверяет подписанные токены времени: публичная форма при
// отдаче кладёт в тело токен со временем выдачи (HMAC-SHA256 над этим временем),
// а приём ответа (фаза 5) отвергает токены, поданные слишком быстро (бот) или с
// битой подписью. Секрет ключа — из config (FORM_TOKEN_SECRET), не логируется.
//
// Формат: "<unixMillis>.<base64url(hmac)>". Время открытое (проверяется свежесть),
// подпись защищает от подделки времени. ~40 строк своего кода — новой зависимости
// не требуется (internal/CLAUDE.md: HMAC есть в stdlib).
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

// ErrInvalid — токен не разбирается, подпись не сходится или время вне диапазона.
// Единая ошибка (не различаем причины) — детали наружу не нужны.
var ErrInvalid = errors.New("invalid form token")

// Issue выпускает токен со временем issuedAt, подписанный secret.
func Issue(secret []byte, issuedAt time.Time) string {
	ms := strconv.FormatInt(issuedAt.UnixMilli(), 10)
	sig := sign(secret, ms)
	return ms + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// IssuedAt проверяет подпись токена и возвращает зашитое время выдачи. Битый формат
// или неверная подпись → ErrInvalid. Свежесть (минимальный/максимальный возраст)
// проверяет вызывающий — здесь только подлинность и разбор времени.
func IssuedAt(secret []byte, tok string) (time.Time, error) {
	ms, sigB64, ok := strings.Cut(tok, ".")
	if !ok {
		return time.Time{}, ErrInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return time.Time{}, ErrInvalid
	}
	// Постоянное по времени сравнение — против timing-атак на подпись.
	if !hmac.Equal(sig, sign(secret, ms)) {
		return time.Time{}, ErrInvalid
	}
	unixMs, err := strconv.ParseInt(ms, 10, 64)
	if err != nil {
		return time.Time{}, ErrInvalid
	}
	return time.UnixMilli(unixMs).UTC(), nil
}

func sign(secret []byte, msg string) []byte {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(msg))
	return mac.Sum(nil)
}
