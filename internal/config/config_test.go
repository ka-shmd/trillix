package config

import (
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	t.Run("все переменные заданы", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "127.0.0.1:8080")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() вернул ошибку: %v", err)
		}
		if cfg.HTTPAddr != "127.0.0.1:8080" {
			t.Errorf("HTTPAddr = %q, ожидалось %q", cfg.HTTPAddr, "127.0.0.1:8080")
		}
	})

	t.Run("нет обязательной переменной — ошибка называет её", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "")

		_, err := Load()
		if err == nil {
			t.Fatal("Load() не вернул ошибку при пустом HTTP_ADDR")
		}
		if !strings.Contains(err.Error(), "HTTP_ADDR") {
			t.Errorf("ошибка %q не называет недостающую переменную HTTP_ADDR", err)
		}
	})
}
