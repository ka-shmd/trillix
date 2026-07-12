package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config — вся конфигурация процесса. Приложение не знает, в каком контуре
// живёт: различия контуров существуют только как значения этих полей.
type Config struct {
	// HTTPAddr — адрес HTTP-сервера, например "127.0.0.1:8080".
	HTTPAddr string
	// DatabaseURL — DSN подключения к Postgres.
	DatabaseURL string
	// CookieSecure — ставить ли флаг Secure на cookie сессии. В dev по http —
	// false, в prod-local/prod по https — true. Первый пример «различие
	// контуров живёт в env», а не в ветвлении по имени окружения.
	CookieSecure bool
	// FormTokenSecret — ключ HMAC-подписи токена времени выдачи публичной формы
	// (антиспам: минимальное время заполнения, фазы 4–5). Секрет: не логируется,
	// в прод-контурах генерируется заново. В dev — локальное одноразовое значение.
	FormTokenSecret []byte
}

// minFormTokenSecretLen — нижняя граница длины ключа HMAC: слишком короткий ключ
// подделывается перебором. 16 байт — разумный минимум для dev; прод длиннее.
const minFormTokenSecretLen = 16

// Load читает конфигурацию из env и валидирует её. Отсутствие обязательной
// переменной — ошибка старта процесса, а не первого запроса; в сообщении
// перечисляются все недостающие переменные сразу.
func Load() (Config, error) {
	var missing []string
	required := func(name string) string {
		v := os.Getenv(name)
		if v == "" {
			missing = append(missing, name)
		}
		return v
	}

	cfg := Config{
		HTTPAddr:    required("HTTP_ADDR"),
		DatabaseURL: required("DATABASE_URL"),
	}
	cookieSecureRaw := required("COOKIE_SECURE")
	formTokenSecret := required("FORM_TOKEN_SECRET")

	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required env: %s", strings.Join(missing, ", "))
	}

	cookieSecure, err := strconv.ParseBool(cookieSecureRaw)
	if err != nil {
		return Config{}, fmt.Errorf("invalid COOKIE_SECURE %q: want true or false", cookieSecureRaw)
	}
	cfg.CookieSecure = cookieSecure

	if len(formTokenSecret) < minFormTokenSecretLen {
		return Config{}, fmt.Errorf("FORM_TOKEN_SECRET too short: want >= %d bytes", minFormTokenSecretLen)
	}
	cfg.FormTokenSecret = []byte(formTokenSecret)

	return cfg, nil
}
