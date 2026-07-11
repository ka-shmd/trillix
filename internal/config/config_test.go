package config

import (
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	t.Run("все переменные заданы", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "127.0.0.1:8080")
		t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db?sslmode=disable")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() вернул ошибку: %v", err)
		}
		if cfg.HTTPAddr != "127.0.0.1:8080" {
			t.Errorf("HTTPAddr = %q, ожидалось %q", cfg.HTTPAddr, "127.0.0.1:8080")
		}
		if cfg.DatabaseURL != "postgres://u:p@127.0.0.1:5432/db?sslmode=disable" {
			t.Errorf("DatabaseURL = %q, неожиданное значение", cfg.DatabaseURL)
		}
	})

	t.Run("нет обязательной переменной — ошибка называет её", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "")
		t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")

		_, err := Load()
		if err == nil {
			t.Fatal("Load() не вернул ошибку при пустом HTTP_ADDR")
		}
		if !strings.Contains(err.Error(), "HTTP_ADDR") {
			t.Errorf("ошибка %q не называет недостающую переменную HTTP_ADDR", err)
		}
	})

	t.Run("несколько недостающих переменных перечислены разом", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "")
		t.Setenv("DATABASE_URL", "")

		_, err := Load()
		if err == nil {
			t.Fatal("Load() не вернул ошибку при двух пустых переменных")
		}
		if !strings.Contains(err.Error(), "HTTP_ADDR") || !strings.Contains(err.Error(), "DATABASE_URL") {
			t.Errorf("ошибка %q должна называть обе недостающие переменные", err)
		}
	})
}
