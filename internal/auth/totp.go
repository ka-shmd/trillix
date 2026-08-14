package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// Второй фактор — TOTP (RFC 6238) на stdlib: HMAC-SHA1 над номером временного
// шага плюс усечение до шести цифр. Своего кода около шестидесяти строк, новых
// зависимостей ноль (`crypto/hmac`, `crypto/sha1`, `encoding/base32`,
// `crypto/hkdf` — всё stdlib, Go 1.24+).
//
// SHA-1 здесь не выбор из двух зол, а требование совместимости: приложения-
// аутентификаторы читают QR и ссылки `otpauth://` в SHA-1 по умолчанию, и
// «более стойкий» алгоритм означал бы код, который не примет ни одно из них.
// Стойкость схемы держится не на хеше, а на секрете и на коротком окне.
//
// Замысел и отвергнутые альтернативы (в том числе почему не коды на email) —
// docs/design/account-settings.md §6.

const (
	// totpStep — окно кода. 30 секунд — то, что по умолчанию ждёт любое
	// приложение-аутентификатор; менять нельзя, не сломав совместимость.
	totpStep = 30 * time.Second
	// totpDigits — длина кода. Шесть — тоже дефолт аутентификаторов.
	totpDigits = 6
	// totpSecretBytes — длина секрета. 20 байт = 160 бит, рекомендация RFC 4226
	// для HMAC-SHA1 (ровно длина выхода хеша).
	totpSecretBytes = 20
	// totpSkew — на сколько шагов в каждую сторону допускаем расхождение часов.
	// Один шаг: полминуты в обе стороны терпит расползание часов телефона, но
	// не растягивает жизнь кода настолько, чтобы это меняло цену перебора.
	totpSkew = 1

	// recoveryCodeCount — сколько резервных кодов выдаётся за раз.
	recoveryCodeCount = 10
	// recoveryCodeBytes — энтропия одного кода (80 бит): перебирать бессмысленно,
	// а переписать с экрана всё ещё можно.
	recoveryCodeBytes = 10

	// totpIssuer — имя в приложении-аутентификаторе.
	totpIssuer = "Trillix"
)

// base32NoPad — кодировка секрета для человека и для otpauth-ссылки. Без
// padding: '=' в конце ломает часть аутентификаторов при ручном вводе.
var base32NoPad = base32.StdEncoding.WithPadding(base32.NoPadding)

// newTOTPSecret выдаёт свежий секрет (сырые байты).
func newTOTPSecret() ([]byte, error) {
	b := make([]byte, totpSecretBytes)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("totp: random secret: %w", err)
	}
	return b, nil
}

// encodeSecret — секрет в виде, который человек вводит руками (base32 группами
// по четыре символа читается и переписывается заметно надёжнее сплошной строки).
func encodeSecret(secret []byte) string {
	raw := base32NoPad.EncodeToString(secret)
	var b strings.Builder
	for i, r := range raw {
		if i > 0 && i%4 == 0 {
			b.WriteByte(' ')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// otpauthURL — ссылка для аутентификатора. QR мы не рисуем (кодировщик Рида —
// Соломона это ~500 строк или новая зависимость, решение владельца 2026-08-13),
// но на телефоне эта ссылка открывает приложение сама.
func otpauthURL(email string, secret []byte) string {
	label := url.PathEscape(totpIssuer + ":" + email)
	q := url.Values{
		"secret":    {base32NoPad.EncodeToString(secret)},
		"issuer":    {totpIssuer},
		"algorithm": {"SHA1"},
		"digits":    {fmt.Sprint(totpDigits)},
		"period":    {fmt.Sprint(int(totpStep.Seconds()))},
	}
	return "otpauth://totp/" + label + "?" + q.Encode()
}

// totpCode считает код для конкретного шага (RFC 6238 + усечение RFC 4226).
func totpCode(secret []byte, step int64) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))

	mac := hmac.New(sha1.New, secret)
	mac.Write(counter[:])
	sum := mac.Sum(nil)

	// Динамическое усечение: младшие четыре бита последнего байта указывают,
	// откуда брать четыре байта результата.
	offset := sum[len(sum)-1] & 0x0f
	value := binary.BigEndian.Uint32(sum[offset:offset+4]) & 0x7fffffff

	mod := uint32(1)
	for range totpDigits {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", totpDigits, value%mod)
}

// verifyTOTP проверяет код на текущем шаге и соседних (±totpSkew) и возвращает
// НОМЕР ШАГА, на котором код сошёлся.
//
// Номер нужен вызывающему, чтобы запомнить его и отвергнуть повторное
// предъявление того же кода: без этого перехваченный код работает все свои
// полминуты, и «второй фактор» не мешает тому, кто читает трафик или смотрит
// через плечо.
func verifyTOTP(secret []byte, code string, now time.Time) (int64, bool) {
	code = strings.TrimSpace(code)
	if len(code) != totpDigits {
		return 0, false
	}
	current := now.Unix() / int64(totpStep.Seconds())
	for step := current - totpSkew; step <= current+totpSkew; step++ {
		// Сравнение постоянного времени: код короткий, и утечка «сколько первых
		// цифр совпало» через время сравнения сокращала бы перебор.
		if subtle.ConstantTimeCompare([]byte(totpCode(secret, step)), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// newRecoveryCodes выдаёт коды в человекочитаемом виде и их SHA-256 для БД.
//
// SHA-256, а не argon2id: коды генерируем мы, энтропии в них 80 бит, перебирать
// нечего — а десять argon2-проверок на попытку входа (каждая 64 МиБ) были бы
// подарком тому, кто ищет, чем занять память сервера. Та же логика, по которой
// в sessions лежит SHA-256 токена.
func newRecoveryCodes() (plain []string, hashes [][]byte, err error) {
	plain = make([]string, 0, recoveryCodeCount)
	hashes = make([][]byte, 0, recoveryCodeCount)
	for range recoveryCodeCount {
		b := make([]byte, recoveryCodeBytes)
		if _, err := rand.Read(b); err != nil {
			return nil, nil, fmt.Errorf("totp: random recovery code: %w", err)
		}
		code := base32NoPad.EncodeToString(b)
		plain = append(plain, code)
		hashes = append(hashes, hashRecoveryCode(code))
	}
	return plain, hashes, nil
}

// hashRecoveryCode приводит введённый код к тому виду, в котором он лежит в БД.
// Регистр и пробелы человеку прощаем: код переписывают с экрана руками.
func hashRecoveryCode(code string) []byte {
	normalized := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(code), " ", ""))
	sum := sha256.Sum256([]byte(normalized))
	return sum[:]
}

// sealSecret шифрует секрет для хранения: AES-256-GCM, ключ — HKDF от общего
// секрета приложения с отдельной меткой назначения.
//
// Отдельной env-переменной под этот ключ сознательно нет: ещё один секрет в
// `.env` трёх контуров, в CI и в раннбуке стоит дороже, чем даёт, а разделение
// назначений обеспечивает метка HKDF. **Плата названа вслух:** ротация
// FORM_TOKEN_SECRET обнулит все включённые вторые факторы — это должно попасть
// в раннбук ротации.
func sealSecret(key, secret []byte) ([]byte, error) {
	gcm, err := secretGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("totp: random nonce: %w", err)
	}
	// Nonce едет впереди шифротекста: он не секрет, но обязан быть уникальным.
	return gcm.Seal(nonce, nonce, secret, nil), nil
}

func openSecret(key, sealed []byte) ([]byte, error) {
	gcm, err := secretGCM(key)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, fmt.Errorf("totp: sealed secret too short")
	}
	nonce, ct := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	secret, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, fmt.Errorf("totp: open secret: %w", err)
	}
	return secret, nil
}

func secretGCM(key []byte) (cipher.AEAD, error) {
	derived, err := hkdf.Key(sha256.New, key, nil, "trillix-totp-secret-v1", 32)
	if err != nil {
		return nil, fmt.Errorf("totp: derive key: %w", err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		return nil, fmt.Errorf("totp: cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("totp: gcm: %w", err)
	}
	return gcm, nil
}
