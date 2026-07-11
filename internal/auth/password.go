package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Параметры argon2id по рекомендациям OWASP (ARCHITECTURE §4.5): память 64 МиБ,
// 3 итерации. Параллелизм 1 — детерминированно и переносимо между машинами
// (число потоков не влияет на результат хеша при фиксированном значении).
const (
	argonMemoryKiB   = 64 * 1024 // 64 МиБ
	argonIterations  = 3
	argonParallelism = 1
	argonSaltLen     = 16
	argonKeyLen      = 32
)

// ErrInvalidHash — сохранённый хеш имеет неизвестный или повреждённый формат.
var ErrInvalidHash = errors.New("auth: malformed password hash")

// HashPassword хеширует пароль argon2id и возвращает строку в стандартном
// PHC-формате: $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>. Параметры едут
// вместе с хешем, поэтому VerifyPassword не зависит от текущих констант и
// переживает их будущее ужесточение (старые хеши остаются проверяемыми).
func HashPassword(plain string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("auth: read salt: %w", err)
	}
	key := argon2.IDKey([]byte(plain), salt, argonIterations, argonMemoryKiB, argonParallelism, argonKeyLen)
	encoded := fmt.Sprintf(
		"$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	)
	return encoded, nil
}

// VerifyPassword сравнивает пароль с ранее сохранённым хешем в постоянное время.
// Параметры (память, итерации, параллелизм, длина ключа) берутся из самого хеша,
// а не из текущих констант.
func VerifyPassword(encoded, plain string) (bool, error) {
	p, salt, key, err := decodeHash(encoded)
	if err != nil {
		return false, err
	}
	other := argon2.IDKey([]byte(plain), salt, p.iterations, p.memory, p.parallelism, uint32(len(key)))
	return subtle.ConstantTimeCompare(key, other) == 1, nil
}

type argonParams struct {
	memory      uint32
	iterations  uint32
	parallelism uint8
}

// decodeHash разбирает PHC-строку argon2id обратно на параметры, соль и ключ.
func decodeHash(encoded string) (argonParams, []byte, []byte, error) {
	// Ожидаемый вид: ["", "argon2id", "v=19", "m=65536,t=3,p=1", "<salt>", "<hash>"].
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return argonParams{}, nil, nil, ErrInvalidHash
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return argonParams{}, nil, nil, ErrInvalidHash
	}

	var p argonParams
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &p.memory, &p.iterations, &p.parallelism); err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return argonParams{}, nil, nil, ErrInvalidHash
	}
	return p, salt, key, nil
}
