package forms

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

// ТОКЕН РАЗБЛОКИРОВКИ — доказательство того, что этот браузер уже назвал пароль
// ЭТОЙ формы, и ничего больше.
//
// Формат: "<formID>.<unixMillis истечения>.<base64url(hmac)>". Подпись покрывает всё,
// что перед ней, поэтому подменить id формы в готовом токене нельзя — иначе один
// пароль открывал бы все формы сервиса.
//
// Секрет производный от секрета токена формы, с отдельной меткой назначения: тот же
// приём и тот же довод, что у токена печати (internal/submissions/printtoken.go) —
// своей переменной окружения у разблокировки нет, а подписывать её токены тем же
// ключом, что и токены времени публичной формы, нельзя: утечка одного применения
// била бы по обоим. Менять метку нельзя — выданные токены станут недействительны.
const unlockLabel = "trillix/form-unlock/v1"

// unlockTTL — сколько живёт разблокировка. Сутки: рендерер держит токен в
// sessionStorage, то есть до закрытия вкладки (решение владельца, спека §2.4), а срок
// ограничивает не удобство, а окно, в котором утёкшая строка что-то значит.
const unlockTTL = 24 * time.Hour

// deriveUnlockSecret выводит секрет разблокировки из секрета токена формы.
func deriveUnlockSecret(formTokenSecret []byte) []byte {
	if len(formTokenSecret) == 0 {
		return nil
	}
	h := hmac.New(sha256.New, formTokenSecret)
	h.Write([]byte(unlockLabel))
	return h.Sum(nil)
}

// issueUnlockToken выпускает токен на форму, действительный до expiry.
func issueUnlockToken(secret []byte, formID uuid.UUID, expiry time.Time) string {
	payload := formID.String() + "." + strconv.FormatInt(expiry.UnixMilli(), 10)
	return payload + "." + base64.RawURLEncoding.EncodeToString(signUnlock(secret, payload))
}

// validUnlockToken — годен ли токен для этой формы прямо сейчас. Причина отказа
// наружу не различается: снаружи это в любом случае «введите пароль».
func validUnlockToken(secret []byte, tok string, formID uuid.UUID, now time.Time) bool {
	if len(secret) == 0 {
		return false
	}
	// Три части ровно: SplitN оставил бы лишние точки внутри подписи.
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return false
	}
	payload := parts[0] + "." + parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	if !hmac.Equal(sig, signUnlock(secret, payload)) {
		return false
	}
	// Сверяем id формы ПОСЛЕ подписи: до неё сравнивать нечего — строка не наша.
	if subtle.ConstantTimeCompare([]byte(parts[0]), []byte(formID.String())) != 1 {
		return false
	}
	expiry, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil {
		return false
	}
	return now.Before(time.UnixMilli(expiry))
}

func signUnlock(secret []byte, payload string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(payload))
	return h.Sum(nil)
}
