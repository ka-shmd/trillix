package config

import (
	"log/slog"
	"strings"
	"testing"
)

// setValidEnv выставляет полный набор валидных обязательных переменных. Сабтесты
// зовут его, затем переопределяют ровно ту переменную, чьё поведение проверяют, —
// так добавление новой обязательной переменной не требует правки каждого сабтеста.
func setValidEnv(t *testing.T) {
	t.Helper()
	t.Setenv("HTTP_ADDR", "127.0.0.1:8080")
	t.Setenv("LOG_LEVEL", "info")
	t.Setenv("DATABASE_URL", "postgres://u:p@127.0.0.1:5432/db?sslmode=disable")
	t.Setenv("COOKIE_SECURE", "false")
	t.Setenv("FORM_TOKEN_SECRET", "sixteen-bytes-min")
	t.Setenv("PUBLIC_RENDERER_BASE_URL", "http://localhost:5174")
	t.Setenv("OG_IMAGE_URL", "http://localhost:5174/og.png")
	t.Setenv("APP_ORIGIN", "http://localhost:5173")
	t.Setenv("PUBLIC_RENDERER_INDEX_PATH", "/srv/renderer/index.html")
	t.Setenv("S3_ENDPOINT", "http://localhost:9000")
	t.Setenv("S3_REGION", "us-east-1")
	t.Setenv("S3_ACCESS_KEY", "minioadmin")
	t.Setenv("S3_SECRET_KEY", "minioadmin")
	t.Setenv("S3_MEDIA_BUCKET", "app-media")
	t.Setenv("S3_FILES_BUCKET", "app-files")
	t.Setenv("S3_PATH_STYLE", "true")
	t.Setenv("TRUSTED_PROXY", "false")
	t.Setenv("MAIL_TRANSPORT", "log")
	t.Setenv("MAIL_FROM", "Trillix <no-reply@localhost>")
}

func TestLoad(t *testing.T) {
	t.Run("все переменные заданы", func(t *testing.T) {
		setValidEnv(t)

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
		if cfg.PublicRendererIndexPath != "/srv/renderer/index.html" {
			t.Errorf("PublicRendererIndexPath = %q, неожиданное значение", cfg.PublicRendererIndexPath)
		}
		if cfg.AppOrigin != "http://localhost:5173" {
			t.Errorf("AppOrigin = %q, неожиданное значение", cfg.AppOrigin)
		}
		if cfg.S3Endpoint != "http://localhost:9000" || cfg.S3MediaBucket != "app-media" {
			t.Errorf("S3 endpoint/bucket = %q/%q, неожиданное значение", cfg.S3Endpoint, cfg.S3MediaBucket)
		}
		if !cfg.S3PathStyle {
			t.Errorf("S3PathStyle = false, ожидалось true")
		}
		if cfg.TrustedProxy {
			t.Errorf("TrustedProxy = true, ожидалось false")
		}
	})

	t.Run("TRUSTED_PROXY=true парсится", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("TRUSTED_PROXY", "true")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() вернул ошибку: %v", err)
		}
		if !cfg.TrustedProxy {
			t.Errorf("TrustedProxy = false, ожидалось true")
		}
	})

	t.Run("невалидный TRUSTED_PROXY — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("TRUSTED_PROXY", "maybe")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "TRUSTED_PROXY") {
			t.Fatalf("ожидалась ошибка про TRUSTED_PROXY, получено: %v", err)
		}
	})

	t.Run("COOKIE_SECURE=true парсится", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("COOKIE_SECURE", "true")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() вернул ошибку: %v", err)
		}
		if !cfg.CookieSecure {
			t.Errorf("CookieSecure = false, ожидалось true")
		}
	})

	t.Run("невалидный COOKIE_SECURE — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("COOKIE_SECURE", "yes-please")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "COOKIE_SECURE") {
			t.Fatalf("ожидалась ошибка про COOKIE_SECURE, получено: %v", err)
		}
	})

	t.Run("невалидный S3_PATH_STYLE — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("S3_PATH_STYLE", "sure")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "S3_PATH_STYLE") {
			t.Fatalf("ожидалась ошибка про S3_PATH_STYLE, получено: %v", err)
		}
	})

	t.Run("невалидный S3_ENDPOINT — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("S3_ENDPOINT", "localhost:9000") // без схемы

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "S3_ENDPOINT") {
			t.Fatalf("ожидалась ошибка про S3_ENDPOINT, получено: %v", err)
		}
	})

	t.Run("слишком короткий FORM_TOKEN_SECRET — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("FORM_TOKEN_SECRET", "short")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "FORM_TOKEN_SECRET") {
			t.Fatalf("ожидалась ошибка про FORM_TOKEN_SECRET, получено: %v", err)
		}
	})

	t.Run("относительный PUBLIC_RENDERER_BASE_URL — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("PUBLIC_RENDERER_BASE_URL", "/relative")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "PUBLIC_RENDERER_BASE_URL") {
			t.Fatalf("ожидалась ошибка про PUBLIC_RENDERER_BASE_URL, получено: %v", err)
		}
	})

	t.Run("невалидный APP_ORIGIN — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("APP_ORIGIN", "localhost:5173") // без схемы

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "APP_ORIGIN") {
			t.Fatalf("ожидалась ошибка про APP_ORIGIN, получено: %v", err)
		}
	})

	t.Run("LOG_LEVEL парсится в slog.Level", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("LOG_LEVEL", "debug")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load() вернул ошибку: %v", err)
		}
		if cfg.LogLevel != slog.LevelDebug {
			t.Errorf("LogLevel = %v, ожидался Debug", cfg.LogLevel)
		}
	})

	t.Run("невалидный LOG_LEVEL — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("LOG_LEVEL", "verbose")
		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "LOG_LEVEL") {
			t.Fatalf("ожидалась ошибка про LOG_LEVEL, получено: %v", err)
		}
	})

	t.Run("невалидный MAIL_TRANSPORT — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("MAIL_TRANSPORT", "carrier-pigeon") // не из списка

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "MAIL_TRANSPORT") {
			t.Fatalf("ожидалась ошибка про MAIL_TRANSPORT, получено: %v", err)
		}
	})

	t.Run("smtp с полными параметрами — успех (Postbox-подобный)", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("MAIL_TRANSPORT", "smtp")
		t.Setenv("MAIL_SMTP_HOST", "postbox.example.net")
		t.Setenv("MAIL_SMTP_PORT", "587")
		t.Setenv("MAIL_SMTP_TLS", "starttls")
		t.Setenv("MAIL_SMTP_USERNAME", "key-id")
		t.Setenv("MAIL_SMTP_PASSWORD", "smtp-secret")

		cfg, err := Load()
		if err != nil {
			t.Fatalf("ожидался успех, получено: %v", err)
		}
		if cfg.MailSMTPPort != 587 || cfg.MailSMTPTLS != MailSMTPTLSStartTLS {
			t.Fatalf("параметры SMTP не разобраны: %+v", cfg)
		}
	})

	t.Run("smtp без учётки — успех (Mailpit-подобный)", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("MAIL_TRANSPORT", "smtp")
		t.Setenv("MAIL_SMTP_HOST", "mailpit")
		t.Setenv("MAIL_SMTP_PORT", "1025")
		t.Setenv("MAIL_SMTP_TLS", "none")

		if _, err := Load(); err != nil {
			t.Fatalf("ожидался успех без AUTH, получено: %v", err)
		}
	})

	t.Run("smtp без host — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("MAIL_TRANSPORT", "smtp")
		t.Setenv("MAIL_SMTP_PORT", "587")
		t.Setenv("MAIL_SMTP_TLS", "starttls")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "MAIL_SMTP_HOST") {
			t.Fatalf("ожидалась ошибка про MAIL_SMTP_HOST, получено: %v", err)
		}
	})

	t.Run("smtp с нечисловым портом — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("MAIL_TRANSPORT", "smtp")
		t.Setenv("MAIL_SMTP_HOST", "mailpit")
		t.Setenv("MAIL_SMTP_PORT", "not-a-port")
		t.Setenv("MAIL_SMTP_TLS", "none")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "MAIL_SMTP_PORT") {
			t.Fatalf("ожидалась ошибка про MAIL_SMTP_PORT, получено: %v", err)
		}
	})

	t.Run("smtp с неизвестным TLS — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("MAIL_TRANSPORT", "smtp")
		t.Setenv("MAIL_SMTP_HOST", "mailpit")
		t.Setenv("MAIL_SMTP_PORT", "1025")
		t.Setenv("MAIL_SMTP_TLS", "sorta-secure")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "MAIL_SMTP_TLS") {
			t.Fatalf("ожидалась ошибка про MAIL_SMTP_TLS, получено: %v", err)
		}
	})

	t.Run("smtp с учёткой, но TLS=none — ошибка (AUTH требует TLS)", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("MAIL_TRANSPORT", "smtp")
		t.Setenv("MAIL_SMTP_HOST", "postbox.example.net")
		t.Setenv("MAIL_SMTP_PORT", "25")
		t.Setenv("MAIL_SMTP_TLS", "none")
		t.Setenv("MAIL_SMTP_USERNAME", "key-id")
		t.Setenv("MAIL_SMTP_PASSWORD", "smtp-secret")

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "MAIL_SMTP_TLS=none") {
			t.Fatalf("ожидалась ошибка про TLS=none с учёткой, получено: %v", err)
		}
	})

	t.Run("smtp с половиной учётки — ошибка", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("MAIL_TRANSPORT", "smtp")
		t.Setenv("MAIL_SMTP_HOST", "postbox.example.net")
		t.Setenv("MAIL_SMTP_PORT", "587")
		t.Setenv("MAIL_SMTP_TLS", "starttls")
		t.Setenv("MAIL_SMTP_USERNAME", "key-id") // пароль не задан

		_, err := Load()
		if err == nil || !strings.Contains(err.Error(), "MAIL_SMTP_PASSWORD") {
			t.Fatalf("ожидалась ошибка про парную учётку, получено: %v", err)
		}
	})

	t.Run("нет обязательной переменной — ошибка называет её", func(t *testing.T) {
		setValidEnv(t)
		t.Setenv("HTTP_ADDR", "")

		_, err := Load()
		if err == nil {
			t.Fatal("Load() не вернул ошибку при пустом HTTP_ADDR")
		}
		if !strings.Contains(err.Error(), "HTTP_ADDR") {
			t.Errorf("ошибка %q не называет недостающую переменную HTTP_ADDR", err)
		}
	})

	t.Run("несколько недостающих переменных перечислены разом", func(t *testing.T) {
		setValidEnv(t)
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
