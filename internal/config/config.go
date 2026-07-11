package config

import (
	"fmt"
	"os"
	"strings"
)

// Config — вся конфигурация процесса. Приложение не знает, в каком контуре
// живёт: различия контуров существуют только как значения этих полей.
type Config struct {
	// HTTPAddr — адрес HTTP-сервера, например "127.0.0.1:8080".
	HTTPAddr string
	// DatabaseURL — DSN подключения к Postgres.
	DatabaseURL string
}

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

	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required env: %s", strings.Join(missing, ", "))
	}
	return cfg, nil
}
