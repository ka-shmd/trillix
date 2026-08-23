package config

import (
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
)

// Config — вся конфигурация процесса. Приложение не знает, в каком контуре
// живёт: различия контуров существуют только как значения этих полей.
type Config struct {
	// HTTPAddr — адрес HTTP-сервера, например "127.0.0.1:8080".
	HTTPAddr string
	// LogLevel — минимальный уровень логирования. Смысловой флаг контура (не имя
	// окружения): dev — debug (в LogMailer тело dev-письма, включая ссылку сброса,
	// пишется ТОЛЬКО на debug — это dev-почтовый ящик); prod и prod-local — info,
	// поэтому тело письма с токеном туда не попадает никогда, даже при ошибочно
	// выбранном транспорте log (тогда письмо просто не уходит — сбой заметен, не тих).
	LogLevel slog.Level
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
	// PublicRendererIndexPath — путь в ФС к собранному index.html рендерера. Go
	// читает его при старте и отдаёт как страницу формы /r/{slug}, подставляя OG-мету
	// на место плейсхолдера; ссылки на ассеты берёт из этого HTML как есть (vite сам
	// проставил хеши). ОПЦИОНАЛЬНАЯ: в dev пусто — собранного HTML нет, /r отдаёт
	// vite-dev, Go его не обслуживает. В prod-local/prod — /srv/renderer/index.html
	// (renderer-статика смонтирована в api read-only, см. deploy/compose.prod.yml).
	PublicRendererIndexPath string
	// AppOrigin — origin кабинета (scheme://host[:port]) для строгой проверки
	// заголовка Origin в CSRF-защите мутаций (defense-in-depth поверх double-submit).
	// dev — http://localhost:5173 (vite кабинета); prod-local — https://app.localhost;
	// прод — https://app.<домен>. Без завершающего слеша (Origin его не несёт).
	AppOrigin string
	// S3* — подключение к объектному хранилищу медиа (docs/design/s3-media.md).
	// Провайдеро-независимо: dev/prod-local — MinIO-контейнер, прод — арендованное
	// S3; различие контуров живёт в этих значениях, а не в коде. Приложение не
	// подключается к хранилищу на старте — недоступный S3 роняет только загрузки,
	// не процесс.
	S3Endpoint  string // scheme://host[:port], без пути
	S3Region    string // регион подписи (MinIO — us-east-1)
	S3AccessKey string
	S3SecretKey string // секрет: не логируется
	// S3MediaBucket — бакет public-read картинок (app-media).
	S3MediaBucket string
	// S3PublicEndpoint — адрес хранилища, каким его видит БРАУЗЕР. Обычно совпадает с
	// S3Endpoint, но не обязан: в контуре, где Go ходит к хранилищу по внутренней
	// сети (prod-local: http://minio:9000), респондент по этому адресу не достучится,
	// а имя хоста входит в подпись — presigned-адрес, выписанный на внутреннее имя,
	// у браузера не работает вовсе.
	//
	// Отдельная переменная, а не «догадаться»: догадка здесь ошибается молча, и
	// увидеть это можно только загрузкой файла из браузера.
	S3PublicEndpoint string
	// S3FilesBucket — бакет файлов ответов (app-files), ПРИВАТНЫЙ. Второй бакет, а
	// не префикс в первом: у картинок форм и файлов респондентов несовместимые
	// политики — те раздаются анонимно, эти не раздаются вовсе и живут только за
	// короткой подписью (docs/design/answer-files.md §8).
	S3FilesBucket string
	// S3PathStyle — path-style адресация (endpoint/bucket/key). MinIO и часть
	// РФ-провайдеров требуют true; AWS virtual-hosted — false.
	S3PathStyle bool
	// TrustedProxy — стоит ли процесс за доверенным обратным прокси (наш Caddy).
	// true → IP клиента для rate-limit'а брать из X-Forwarded-For (иначе за прокси
	// все клиенты видятся одним IP прокси и лимитер держит одно ведро на весь сайт).
	// dev (Go смотрит в сеть напрямую) — false; prod-local/prod (за Caddy) — true.
	// Смысловой флаг, а не имя окружения: различие контуров живёт в этом значении.
	TrustedProxy bool
	// YandexOAuth* — приложение Яндекс ID для входа через провайдера (фаза 11).
	// ОПЦИОНАЛЬНЫЕ и парные: заданы обе — кнопка «Войти через Яндекс» живёт,
	// не заданы — провайдер выключен целиком (эндпоинты отдают 404, фронт кнопку
	// не рисует). Так контур без своего приложения — чужая машина, CI, прогон
	// тестов — поднимается без фиктивных ключей.
	// Секрет: не логируется. В .env.dev лежит пустым — боевое значение живёт
	// только в локальном .env (он в .gitignore) и в серверном .env прода.
	// redirect_uri отдельной переменной нет: он собирается из AppOrigin, и это
	// не экономия, а гарантия — адрес в запросе совпадает с origin кабинета,
	// с которого пришёл человек.
	YandexOAuthClientID     string
	YandexOAuthClientSecret string

	// GoogleOAuth* — приложение Google Cloud для интеграции с Таблицами
	// (фаза 25). Не вход: этим приложением продукт ходит в чужой Диск от имени
	// человека, поэтому у него другой набор scope и другой экран согласия.
	// Пусто — интеграция выключена на контуре, кабинет работает как раньше.
	GoogleOAuthClientID     string
	GoogleOAuthClientSecret string
	// GooglePickerAPIKey — браузерный ключ Google Cloud для окна выбора файла
	// (Google Picker). Отдельный от OAuth-клиента: Picker требует именно API-key,
	// а не секрет приложения. Пусто — кнопка «Выбрать на Google Диске» не
	// показывается, остальная интеграция работает как раньше.
	GooglePickerAPIKey string

	// Mail* — исходящая транзакционная почта (почтовая фаза). Транспорт — смысловой
	// флаг контура (не имя окружения): dev/prod-local пишут письма в лог (провайдер
	// не нужен), прод отдаёт их провайдеру. MailFrom — адрес отправителя в письмах;
	// различие контуров живёт в этих значениях.
	MailTransport string // log | smtp (провайдерский транспорт — слайс E почтовой фазы)
	MailFrom      string // адрес/имя отправителя, напр. "Trillix <no-reply@trillix.ru>"
	// MailSMTP* — параметры SMTP-транспорта (MAIL_TRANSPORT=smtp). Один транспорт на
	// оба боевых контура, различие живёт только в этих значениях: прод шлёт через
	// Yandex Postbox (STARTTLS, аутентификация), prod-local — в локальный Mailpit
	// (без TLS, без аутентификации). Обязательны только при transport=smtp.
	// Username/Password пусты = без SMTP AUTH (Mailpit); заполнены оба = PLAIN
	// (Postbox). Password — секрет: живёт в .env, не логируется (инвариант 7).
	MailSMTPHost     string
	MailSMTPPort     int
	MailSMTPUsername string
	MailSMTPPassword string
	MailSMTPTLS      string // starttls | implicit | none (см. MailSMTPTLS* ниже)
}

// GoogleOAuthEnabled — задано ли приложение Google для интеграций.
func (c Config) GoogleOAuthEnabled() bool {
	return c.GoogleOAuthClientID != "" && c.GoogleOAuthClientSecret != ""
}

// YandexOAuthEnabled — заданы ли обе половины приложения Яндекс ID.
func (c Config) YandexOAuthEnabled() bool {
	return c.YandexOAuthClientID != "" && c.YandexOAuthClientSecret != ""
}

// minFormTokenSecretLen — нижняя граница длины ключа HMAC: слишком короткий ключ
// подделывается перебором. 16 байт — разумный минимум для dev; прод длиннее.
const minFormTokenSecretLen = 16

// MailTransportLog — транспорт почты, «доставляющий» письмо записью в лог (dev:
// провайдер не нужен, письмо читается из debug-лога). MailTransportSMTP — боевой
// транспорт: один SMTP-клиент, которым прод бьёт в Yandex Postbox, а prod-local — в
// Mailpit; различие контуров — в значениях MailSMTP*, а не в отдельных транспортах.
const (
	MailTransportLog  = "log"
	MailTransportSMTP = "smtp"
)

// Режимы TLS для SMTP-транспорта. starttls — открытое соединение с апгрейдом до TLS
// (Postbox, порт 587); implicit — TLS с первого байта (порт 465); none — без
// шифрования (локальный Mailpit, где трафик не покидает машину).
const (
	MailSMTPTLSStartTLS = "starttls"
	MailSMTPTLSImplicit = "implicit"
	MailSMTPTLSNone     = "none"
)

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
	logLevelRaw := required("LOG_LEVEL")
	cookieSecureRaw := required("COOKIE_SECURE")
	formTokenSecret := required("FORM_TOKEN_SECRET")
	cfg.PublicRendererBaseURL = required("PUBLIC_RENDERER_BASE_URL")
	cfg.OGImageURL = required("OG_IMAGE_URL")
	cfg.AppOrigin = strings.TrimRight(required("APP_ORIGIN"), "/")
	cfg.S3Endpoint = required("S3_ENDPOINT")
	cfg.S3Region = required("S3_REGION")
	cfg.S3AccessKey = required("S3_ACCESS_KEY")
	cfg.S3SecretKey = required("S3_SECRET_KEY")
	cfg.S3MediaBucket = required("S3_MEDIA_BUCKET")
	cfg.S3FilesBucket = required("S3_FILES_BUCKET")
	cfg.S3PublicEndpoint = required("S3_PUBLIC_ENDPOINT")
	pathStyleRaw := required("S3_PATH_STYLE")
	trustedProxyRaw := required("TRUSTED_PROXY")
	cfg.MailTransport = required("MAIL_TRANSPORT")
	cfg.MailFrom = required("MAIL_FROM")
	// SMTP-параметры опциональны на этом шаге: обязательны они только при
	// MAIL_TRANSPORT=smtp — это проверяется ниже, после общего блока missing.
	cfg.MailSMTPHost = os.Getenv("MAIL_SMTP_HOST")
	mailSMTPPortRaw := os.Getenv("MAIL_SMTP_PORT")
	cfg.MailSMTPUsername = os.Getenv("MAIL_SMTP_USERNAME")
	cfg.MailSMTPPassword = os.Getenv("MAIL_SMTP_PASSWORD")
	cfg.MailSMTPTLS = os.Getenv("MAIL_SMTP_TLS")
	// Опциональная (пустая в dev — /r отдаёт vite-dev): os.Getenv, не required().
	cfg.PublicRendererIndexPath = os.Getenv("PUBLIC_RENDERER_INDEX_PATH")
	// Опциональные (нет приложения Яндекс ID — провайдер просто выключен).
	cfg.YandexOAuthClientID = os.Getenv("YANDEX_OAUTH_CLIENT_ID")
	cfg.YandexOAuthClientSecret = os.Getenv("YANDEX_OAUTH_CLIENT_SECRET")
	// Опциональные (нет проекта в Google Cloud — интеграция просто выключена).
	cfg.GoogleOAuthClientID = os.Getenv("GOOGLE_OAUTH_CLIENT_ID")
	cfg.GoogleOAuthClientSecret = os.Getenv("GOOGLE_OAUTH_CLIENT_SECRET")
	cfg.GooglePickerAPIKey = os.Getenv("GOOGLE_PICKER_API_KEY")

	if len(missing) > 0 {
		return Config{}, fmt.Errorf("missing required env: %s", strings.Join(missing, ", "))
	}

	cookieSecure, err := strconv.ParseBool(cookieSecureRaw)
	if err != nil {
		return Config{}, fmt.Errorf("invalid COOKIE_SECURE %q: want true or false", cookieSecureRaw)
	}
	cfg.CookieSecure = cookieSecure

	pathStyle, err := strconv.ParseBool(pathStyleRaw)
	if err != nil {
		return Config{}, fmt.Errorf("invalid S3_PATH_STYLE %q: want true or false", pathStyleRaw)
	}
	cfg.S3PathStyle = pathStyle

	trustedProxy, err := strconv.ParseBool(trustedProxyRaw)
	if err != nil {
		return Config{}, fmt.Errorf("invalid TRUSTED_PROXY %q: want true or false", trustedProxyRaw)
	}
	cfg.TrustedProxy = trustedProxy

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
	// Origin сравнивается по точному строковому равенству с заголовком Origin,
	// поэтому должен быть валидным http(s)-origin (без пути и слеша — слеш уже срезан).
	if !isHTTPURL(cfg.AppOrigin) {
		return Config{}, fmt.Errorf("invalid APP_ORIGIN %q: want http(s):// origin", cfg.AppOrigin)
	}
	// Endpoint S3 — абсолютный http(s)-URL (клиент строит из него адрес объекта).
	if !isHTTPURL(cfg.S3Endpoint) {
		return Config{}, fmt.Errorf("invalid S3_ENDPOINT %q: want http(s):// URL", cfg.S3Endpoint)
	}
	// PublicRendererIndexPath (опциональный) — путь в ФС; читаемость/наличие
	// плейсхолдера проверяет forms.NewPublicHandler при старте (fail-fast там же).

	// Половина приложения Яндекс ID — почти наверняка опечатка или недозаполненный
	// .env, а не намерение. Молча выключить провайдера здесь хуже, чем упасть:
	// кнопка входа просто исчезла бы с экрана без единой строки в логе.
	if (cfg.YandexOAuthClientID == "") != (cfg.YandexOAuthClientSecret == "") {
		return Config{}, fmt.Errorf("YANDEX_OAUTH_CLIENT_ID and YANDEX_OAUTH_CLIENT_SECRET: set both or neither")
	}

	// Половина приложения Google — тот же довод: молча выключенная интеграция
	// не оставляет в логе ни строки, а человек видит «не настроено» и идёт
	// искать причину в консоли Google, где всё в порядке.
	if (cfg.GoogleOAuthClientID == "") != (cfg.GoogleOAuthClientSecret == "") {
		return Config{}, fmt.Errorf("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET: set both or neither")
	}

	// Транспорт почты валидируется по явному списку: неизвестное значение — почти
	// наверняка опечатка. У smtp дополнительно проверяются его параметры, чтобы
	// кривой .env падал при старте, а не при первой отправке письма.
	switch cfg.MailTransport {
	case MailTransportLog:
		// dev: письмо в лог, SMTP-параметры не нужны — не проверяем.
	case MailTransportSMTP:
		if cfg.MailSMTPHost == "" {
			return Config{}, fmt.Errorf("MAIL_SMTP_HOST required when MAIL_TRANSPORT=smtp")
		}
		port, err := strconv.Atoi(mailSMTPPortRaw)
		if err != nil || port < 1 || port > 65535 {
			return Config{}, fmt.Errorf("invalid MAIL_SMTP_PORT %q: want 1..65535", mailSMTPPortRaw)
		}
		cfg.MailSMTPPort = port
		switch cfg.MailSMTPTLS {
		case MailSMTPTLSStartTLS, MailSMTPTLSImplicit, MailSMTPTLSNone:
		default:
			return Config{}, fmt.Errorf("invalid MAIL_SMTP_TLS %q: want %q, %q or %q",
				cfg.MailSMTPTLS, MailSMTPTLSStartTLS, MailSMTPTLSImplicit, MailSMTPTLSNone)
		}
		// Половина учётки — почти наверняка опечатка. Пусты оба = без AUTH (Mailpit),
		// заданы оба = PLAIN (Postbox); ровно одно — ошибка (как у Яндекс ID выше).
		if (cfg.MailSMTPUsername == "") != (cfg.MailSMTPPassword == "") {
			return Config{}, fmt.Errorf("MAIL_SMTP_USERNAME and MAIL_SMTP_PASSWORD: set both or neither")
		}
		// PLAIN-аутентификация по открытому каналу невозможна: net/smtp её отвергает
		// к удалённому хосту, и письма молча не уходили бы (вечный ретрай). Ловим
		// связку на старте, а не при первой отправке — учётка требует TLS.
		if cfg.MailSMTPUsername != "" && cfg.MailSMTPTLS == MailSMTPTLSNone {
			return Config{}, fmt.Errorf("MAIL_SMTP_TLS=none несовместим с учёткой: SMTP AUTH требует TLS (starttls|implicit)")
		}
	default:
		return Config{}, fmt.Errorf("invalid MAIL_TRANSPORT %q: want %q or %q",
			cfg.MailTransport, MailTransportLog, MailTransportSMTP)
	}

	level, err := parseLogLevel(logLevelRaw)
	if err != nil {
		return Config{}, err
	}
	cfg.LogLevel = level

	return cfg, nil
}

// isHTTPURL — грубая проверка, что значение похоже на абсолютный http(s)-URL.
func isHTTPURL(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// parseLogLevel переводит имя уровня в slog.Level (валидация по явному списку).
func parseLogLevel(s string) (slog.Level, error) {
	switch s {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("invalid LOG_LEVEL %q: want debug|info|warn|error", s)
	}
}
