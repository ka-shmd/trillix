package submissions

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ТОКЕН ПЕЧАТИ — право открыть печатную страницу ОДНОГО ответа, и ничего больше.
//
// Он существует потому, что страницу открывает не человек, а headless-браузер
// принтера: cookie сессии у него нет и быть не должно (браузер, ходящий с чужой
// сессией, — это дыра, а не удобство). Право читать ответ проверяется ДО выдачи
// токена, обычным путём (членство в воркспейсе через forms.Get); токен только
// переносит уже принятое решение через сетевую границу.
//
// Формат: "<formID>.<submissionID>.<unixMillis истечения>.<base64url(hmac)>".
// Подпись покрывает всё, что перед ней, поэтому подменить id ответа в готовом
// токене нельзя — а без подписи он давал бы доступ к любому ответу любой формы.
//
// Срок жизни короткий (printTokenTTL): токен живёт ровно столько, сколько идёт
// печать. Долгоживущий давал бы ссылку на чужой ответ, которая работает без
// логина, — то есть ровно то, чего нет ни у одной другой ручки кабинета.

// printTokenTTL — сколько токен печати остаётся действителен. Две минуты: печать
// одного документа занимает секунды, а запас нужен только на очередь у семафора.
const printTokenTTL = 2 * time.Minute

// printTokenLabel — метка назначения при выводе секрета печати из секрета токена
// формы. Тот же приём и тот же довод, что у ключа посетителя (visits/visitorkey.go):
// своей переменной окружения у печати нет, а подписывать её токены тем же ключом,
// что и токены публичной формы, нельзя — утечка одного применения била бы по обоим.
// Менять метку нельзя: выданные токены станут недействительны (на две минуты).
const printTokenLabel = "trillix/print-token/v1"

// ErrPrintToken — токен не разбирается, подпись не сходится или срок вышел. Причина
// наружу не различается: наружу это в любом случае 404.
var ErrPrintToken = errors.New("invalid print token")

// derivePrintSecret выводит секрет печати из секрета токена формы.
func derivePrintSecret(formTokenSecret []byte) []byte {
	if len(formTokenSecret) == 0 {
		return nil
	}
	h := hmac.New(sha256.New, formTokenSecret)
	h.Write([]byte(printTokenLabel))
	return h.Sum(nil)
}

// issuePrintToken выпускает токен на пару «форма, ответ», действительный до expiry.
func issuePrintToken(secret []byte, formID, submissionID uuid.UUID, expiry time.Time) string {
	payload := formID.String() + "." + submissionID.String() + "." +
		strconv.FormatInt(expiry.UnixMilli(), 10)
	return payload + "." + base64.RawURLEncoding.EncodeToString(signPrint(secret, payload))
}

// parsePrintToken проверяет подпись и срок токена и возвращает пару, на которую он
// выдан. Любой сбой — ErrPrintToken.
func parsePrintToken(secret []byte, tok string, now time.Time) (formID, submissionID uuid.UUID, err error) {
	// Подпись отрезается с конца: всё, что перед последней точкой, и есть подписанные
	// данные — разбирать их до проверки подписи незачем и опасно.
	cut := strings.LastIndexByte(tok, '.')
	if cut < 0 {
		return uuid.Nil, uuid.Nil, ErrPrintToken
	}
	payload := tok[:cut]
	sig, err := base64.RawURLEncoding.DecodeString(tok[cut+1:])
	if err != nil {
		return uuid.Nil, uuid.Nil, ErrPrintToken
	}
	// Постоянное по времени сравнение — против timing-атак на подпись.
	if !hmac.Equal(sig, signPrint(secret, payload)) {
		return uuid.Nil, uuid.Nil, ErrPrintToken
	}

	parts := strings.Split(payload, ".")
	if len(parts) != 3 {
		return uuid.Nil, uuid.Nil, ErrPrintToken
	}
	formID, err = uuid.Parse(parts[0])
	if err != nil {
		return uuid.Nil, uuid.Nil, ErrPrintToken
	}
	submissionID, err = uuid.Parse(parts[1])
	if err != nil {
		return uuid.Nil, uuid.Nil, ErrPrintToken
	}
	ms, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil {
		return uuid.Nil, uuid.Nil, ErrPrintToken
	}
	if !now.Before(time.UnixMilli(ms)) {
		return uuid.Nil, uuid.Nil, ErrPrintToken
	}
	return formID, submissionID, nil
}

func signPrint(secret []byte, payload string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(payload))
	return h.Sum(nil)
}
