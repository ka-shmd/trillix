package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"math/big"
	"strings"
)

// Примитивы второго фактора: код входа, токен известного устройства и метка
// устройства для экрана настроек (0056). Сценарии — service_2fa.go, замысел —
// docs/design/two-factor-email.md.

const (
	// loginCodeDigits — длина кода в письме. Шесть цифр — привычная человеку
	// форма; стойкость здесь держат не они, а десять минут жизни, счётчик
	// попыток и два ведра лимитера.
	loginCodeDigits = 6
	// deviceTokenBytes — 256 бит, как у сессии: токен опознаёт браузер и живёт
	// полгода, поэтому угадывать его должно быть не легче, чем сессию.
	deviceTokenBytes = 32
)

// newLoginCode выдаёт шестизначный код. Через crypto/rand и big.Int, а не
// «rand.Read по цифре»: диапазон 10^6 не кратен 256, и наивная выборка байта по
// модулю сделала бы младшие цифры чаще старших.
func newLoginCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", fmt.Errorf("auth: read login code: %w", err)
	}
	return fmt.Sprintf("%0*d", loginCodeDigits, n.Int64()), nil
}

// hashLoginCode — HMAC-SHA256 кода ключом окружения.
//
// Мина: именно HMAC, а не SHA-256. Шестизначный код — это 10^6 вариантов, и
// обычный хеш по дампу базы перебирается мгновенно; ключа HMAC в дампе нет.
// Метка назначения в сообщении — тот же приём, что у подписанных пропусков
// входа: ключ общий (FORM_TOKEN_SECRET), и без метки значение из одного
// контекста принималось бы в другом.
func hashLoginCode(key []byte, code string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("trillix-login-code-v1:" + normalizeLoginCode(code)))
	return mac.Sum(nil)
}

// normalizeLoginCode приводит введённое к тому виду, в котором код считался:
// пробелы человек ставит сам, копируя из письма.
func normalizeLoginCode(code string) string {
	return strings.ReplaceAll(strings.TrimSpace(code), " ", "")
}

// newDeviceToken — токен браузера; в БД лежит только его SHA-256 (hashToken).
func newDeviceToken() (string, error) {
	b := make([]byte, deviceTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("auth: read device token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// deviceLabel — «Chrome на Windows» для списка устройств в настройках. Задача
// метки одна: человек должен узнать свой компьютер среди чужих, поэтому версий
// в ней нет, а неизвестное честно называется неизвестным.
//
// Порядок проверок несущий: Яндекс.Браузер, Edge и Opera представляются
// Chrome'ом, а Chrome — ещё и Safari, поэтому частное ищется раньше общего.
func deviceLabel(userAgent string) string {
	browser := "Неизвестный браузер"
	switch {
	case strings.Contains(userAgent, "YaBrowser"):
		browser = "Яндекс.Браузер"
	case strings.Contains(userAgent, "Edg/"):
		browser = "Edge"
	case strings.Contains(userAgent, "OPR/"), strings.Contains(userAgent, "Opera"):
		browser = "Opera"
	case strings.Contains(userAgent, "Firefox"):
		browser = "Firefox"
	case strings.Contains(userAgent, "Chrome"):
		browser = "Chrome"
	case strings.Contains(userAgent, "Safari"):
		browser = "Safari"
	}

	os := ""
	switch {
	case strings.Contains(userAgent, "Android"):
		os = "Android"
	case strings.Contains(userAgent, "iPhone"), strings.Contains(userAgent, "iPad"):
		os = "iOS"
	case strings.Contains(userAgent, "Windows"):
		os = "Windows"
	case strings.Contains(userAgent, "Mac OS X"), strings.Contains(userAgent, "Macintosh"):
		os = "macOS"
	case strings.Contains(userAgent, "Linux"):
		os = "Linux"
	}

	if os == "" {
		return browser
	}
	return browser + " на " + os
}
