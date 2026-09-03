package booking

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ТОКЕН ОТМЕНЫ — доказательство того, что предъявитель получил письмо об ЭТОЙ записи,
// и ничего больше. Ни сессии, ни пароля у респондента нет: письмо и есть его право.
//
// Формат тот же, что у токена разблокировки формы (internal/forms/unlock.go):
// "<bookingID>.<unixMillis истечения>.<base64url(hmac)>". Подпись покрывает id брони и
// срок, поэтому подменить id в готовом токене нельзя — иначе ссылка из одного письма
// отменяла бы чужие записи.
//
// Секрет производный от FORM_TOKEN_SECRET с отдельной меткой назначения: тот же приём
// и тот же довод, что у разблокировки и у токена печати — своей переменной окружения
// у отмены нет, а подписывать её токены общим ключом нельзя (утечка одного применения
// била бы по обоим). ⚠ РОТАЦИЯ СЕКРЕТА ГАСИТ ВСЕ ВЫДАННЫЕ ССЫЛКИ ОТМЕНЫ — это идёт в
// раннбук ротации рядом с теми же следствиями для пароля формы и подключений
// интеграций. Менять метку нельзя по той же причине.
const cancelLabel = "trillix/booking-cancel/v1"

// CancelTTL — сколько живёт ссылка отмены.
//
// Девяносто дней, а не сутки, как у разблокировки: письмо о записи человек открывает
// не сразу и хранит до самой встречи, а горизонт записи — до года. Срок здесь
// ограничивает не удобство, а окно, в котором утёкшая строка что-то значит; отменять
// состоявшуюся встречу задним числом всё равно бессмысленно.
const CancelTTL = 90 * 24 * time.Hour

// DeriveCancelSecret выводит секрет отмены из секрета токена формы.
func DeriveCancelSecret(formTokenSecret []byte) []byte {
	if len(formTokenSecret) == 0 {
		return nil
	}
	h := hmac.New(sha256.New, formTokenSecret)
	h.Write([]byte(cancelLabel))
	return h.Sum(nil)
}

// IssueCancelToken выпускает ссылку отмены на бронь, действительную до expiry.
func IssueCancelToken(secret []byte, bookingID uuid.UUID, expiry time.Time) string {
	payload := bookingID.String() + "." + strconv.FormatInt(expiry.UnixMilli(), 10)
	return payload + "." + base64.RawURLEncoding.EncodeToString(signCancel(secret, payload))
}

// ParseCancelToken — чья это ссылка и годна ли она сейчас. Ошибку наружу не
// различаем: снаружи и «подделка», и «протухла» — одно и то же «ссылка не действует».
func ParseCancelToken(secret []byte, tok string, now time.Time) (uuid.UUID, bool) {
	if len(secret) == 0 {
		return uuid.Nil, false
	}
	// Три части ровно: SplitN оставил бы лишние точки внутри подписи.
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return uuid.Nil, false
	}
	payload := parts[0] + "." + parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return uuid.Nil, false
	}
	// Подпись сверяется ПЕРВОЙ: до неё строка не наша, и разбирать в ней нечего.
	if subtle.ConstantTimeCompare(sig, signCancel(secret, payload)) != 1 {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(parts[0])
	if err != nil {
		return uuid.Nil, false
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return uuid.Nil, false
	}
	if !now.Before(time.UnixMilli(expiry)) {
		return uuid.Nil, false
	}
	return id, true
}

func signCancel(secret []byte, payload string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(payload))
	return h.Sum(nil)
}
