package config

import (
	"strings"
	"testing"
)

func TestLoad(t *testing.T) {
	t.Run("все переменные заданы", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "127.0.0.1:8080")
		t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db?sslmode=disable")
		t.Setenv("COOKIE_SECURE", "false")
		t.Setenv("FORM_TOKEN_SECRET", "sixteen-bytes-min")
		t.Setenv("PUBLIC_RENDERER_BASE_URL", "http://localhost:5174")
		t.Setenv("OG_IMAGE_URL", "http://localhost:5174/og.png")

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
		if cfg.CookieSecure {
			t.Errorf("CookieSecure = true, ожидалось false")
		}
		if string(cfg.FormTokenSecret) != "sixteen-bytes-min" {
			t.Errorf("FormTokenSecret = %q, неожиданное значение", cfg.FormTokenSecret)
		}
	})

	t.Run("COOKIE_SECURE=true парсится", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "127.0.0.1:8080")
		t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")
		t.Setenv("COOKIE_SECURE", "true")
		t.Setenv("FORM_TOKEN_SECRET", "sixteen-bytes-min")
		t.Setenv("PUBLIC_RENDERER_BASE_URL", "http://localhost:5174")
		t.Setenv("OG_IMAGE_URL", "http://localhost:5174/og.png")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() вернул ошибку: %v", err)
		}
		if !cfg.CookieSecure {
			t.Errorf("CookieSecure = false, ожидалось true")
		}
	})

	t.Run("невалидный COOKIE_SECURE — ошибка", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "127.0.0.1:8080")
		t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")
		t.Setenv("COOKIE_SECURE", "yes-please")
		t.Setenv("FORM_TOKEN_SECRET", "sixteen-bytes-min")
		t.Setenv("PUBLIC_RENDERER_BASE_URL", "http://localhost:5174")
		t.Setenv("OG_IMAGE_URL", "http://localhost:5174/og.png")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "COOKIE_SECURE") {
			t.Fatalf("ожидалась ошибка про COOKIE_SECURE, получено: %v", err)
		}
	})

	t.Run("слишком короткий FORM_TOKEN_SECRET — ошибка", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "127.0.0.1:8080")
		t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")
		t.Setenv("COOKIE_SECURE", "false")
		t.Setenv("FORM_TOKEN_SECRET", "short")
		t.Setenv("PUBLIC_RENDERER_BASE_URL", "http://localhost:5174")
		t.Setenv("OG_IMAGE_URL", "http://localhost:5174/og.png")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "FORM_TOKEN_SECRET") {
			t.Fatalf("ожидалась ошибка про FORM_TOKEN_SECRET, получено: %v", err)
		}
	})

	t.Run("относительный PUBLIC_RENDERER_BASE_URL — ошибка", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "127.0.0.1:8080")
		t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")
		t.Setenv("COOKIE_SECURE", "false")
		t.Setenv("FORM_TOKEN_SECRET", "sixteen-bytes-min")
		t.Setenv("PUBLIC_RENDERER_BASE_URL", "/relative")
		t.Setenv("OG_IMAGE_URL", "http://localhost:5174/og.png")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "PUBLIC_RENDERER_BASE_URL") {
			t.Fatalf("ожидалась ошибка про PUBLIC_RENDERER_BASE_URL, получено: %v", err)
		}
	})

	t.Run("нет обязательной переменной — ошибка называет её", func(t *testing.T) {
		t.Setenv("HTTP_ADDR", "")
		t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db")
		t.Setenv("COOKIE_SECURE", "false")

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
