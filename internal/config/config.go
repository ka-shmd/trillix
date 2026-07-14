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
	// PublicRendererBaseURL — базовый URL публичного рендерера (dev: http://localhost:5174,
	// prod: https://f.example.com). Из него строятся og:url и src SPA-скрипта на
	// HTML-странице формы /r/{slug}; сюда же кабинет даёт ссылку (фаза 4, шаг 7).
	// Различие контуров живёт в этой переменной, а не в ветвлении по окружению.
	PublicRendererBaseURL string
	// OGImageURL — абсолютный URL картинки превью ссылок (og:image). В MVP — общая
	// брендовая заглушка; своя картинка на форму — пост-MVP (нужна загрузка файлов).
	OGImageURL string
	// PublicRendererScriptPath — путь к entry-скрипту рендерера на HTML-странице
	// формы /r/{slug} (Go подставляет его в <script src>). Различие контуров:
	// dev — vite-dev отдаёт исходник `/src/main.tsx`; prod-local/prod — собранный
	// стабильный entry `/renderer.js`. Абсолютный путь от корня (начинается с «/»).
	PublicRendererScriptPath string
	// AppOrigin — origin кабинета (scheme://host[:port]) для строгой проверки
	// заголовка Origin в CSRF-защите мутаций (defense-in-depth поверх double-submit).
	// dev — http://localhost:5173 (vite кабинета); prod-local — https://app.localhost;
	// прод — https://app.<домен>. Без завершающего слеша (Origin его не несёт).
	AppOrigin string
	// PublicRendererStylePath — путь к CSS рендерера на HTML-странице формы /r/{slug}
	// (Go вставляет <link rel="stylesheet">). ОПЦИОНАЛЬНАЯ: в dev пусто — vite-dev
	// инжектит стили через JS, отдельного файла нет; в prod-local/prod — собранный
	// стабильный `/renderer.css`. Если задана — начинается с «/».
	PublicRendererStylePath string
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
	cfg.PublicRendererBaseURL = required("PUBLIC_RENDERER_BASE_URL")
	cfg.OGImageURL = required("OG_IMAGE_URL")
	cfg.PublicRendererScriptPath = required("PUBLIC_RENDERER_SCRIPT_PATH")
	cfg.AppOrigin = strings.TrimRight(required("APP_ORIGIN"), "/")
	// Опциональная (пустая в dev): os.Getenv напрямую, не через required().
	cfg.PublicRendererStylePath = os.Getenv("PUBLIC_RENDERER_STYLE_PATH")

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

	// og:url и src SPA-скрипта — абсолютные ссылки, отдаваемые краулерам/браузеру;
	// относительный base превратил бы их в битые, поэтому проверяем схему при старте.
	if !isHTTPURL(cfg.PublicRendererBaseURL) {
		return Config{}, fmt.Errorf("invalid PUBLIC_RENDERER_BASE_URL %q: want http(s):// URL", cfg.PublicRendererBaseURL)
	}
	if !isHTTPURL(cfg.OGImageURL) {
		return Config{}, fmt.Errorf("invalid OG_IMAGE_URL %q: want http(s):// URL", cfg.OGImageURL)
	}
	// Путь склеивается с publicBaseURL как base+path; относительный путь дал бы
	// битую ссылку на скрипт, поэтому требуем ведущий «/».
	if !strings.HasPrefix(cfg.PublicRendererScriptPath, "/") {
		return Config{}, fmt.Errorf("invalid PUBLIC_RENDERER_SCRIPT_PATH %q: want leading slash", cfg.PublicRendererScriptPath)
	}
	// Origin сравнивается по точному строковому равенству с заголовком Origin,
	// поэтому должен быть валидным http(s)-origin (без пути и слеша — слеш уже срезан).
	if !isHTTPURL(cfg.AppOrigin) {
		return Config{}, fmt.Errorf("invalid APP_ORIGIN %q: want http(s):// origin", cfg.AppOrigin)
	}
	if cfg.PublicRendererStylePath != "" && !strings.HasPrefix(cfg.PublicRendererStylePath, "/") {
		return Config{}, fmt.Errorf("invalid PUBLIC_RENDERER_STYLE_PATH %q: want leading slash", cfg.PublicRendererStylePath)
	}

	return cfg, nil
}

// isHTTPURL — грубая проверка, что значение похоже на абсолютный http(s)-URL.
func isHTTPURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}
