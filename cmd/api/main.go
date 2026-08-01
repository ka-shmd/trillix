// Command api — composition root. Без аргументов запускает HTTP-сервер;
// подкоманда `migrate up|down` прогоняет миграции тем же бинарником.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/config"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/media"
	"github.com/ka-shmd/trillix/internal/oauth"
	"github.com/ka-shmd/trillix/internal/periodic"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/ratelimit"
	"github.com/ka-shmd/trillix/internal/submissions"
	"github.com/ka-shmd/trillix/internal/visits"
	"github.com/ka-shmd/trillix/internal/workspaces"
)

// Жёсткий лимит на POST /auth/login по IP: запас 5 попыток, пополнение ~1 в 12 с.
const (
	loginRatePerSec = 1.0 / 12.0
	loginBurst      = 5

	// Жёсткий лимит на POST /auth/register по IP (отдельное ведро, жёстче логина):
	// argon2id — 64 МиБ памяти на вызов, а регистрация — редкое разовое действие.
	// Запас 3, пополнение ~1 в 30 с — терпимо к паре ретраев, режет ресурсный флуд.
	registerRatePerSec = 1.0 / 30.0
	registerBurst      = 3

	// Жёсткий лимит на POST приёма ответа по IP (отдельный от логина): запас 20,
	// пополнение ~1 в 3 с (устойчиво ~20/мин). Терпимо к киоску, где несколько
	// человек отвечают с одного IP, но режет автоматический перебор.
	submitRatePerSec = 1.0 / 3.0
	submitBurst      = 20

	// Жёсткий лимит на POST визита по IP (своё ведро, ARCHITECTURE §4.6). Щедрее
	// приёма ответа: один человек за визит шлёт минимум два бикона, а
	// visibilitychange добавляет по одному на каждое переключение вкладки — ведро
	// уровня submit резало бы обычное поведение. Накрутку просмотров это не
	// исключает (ручка публичная на запись), а ограничивает: ущерб — неверное число
	// на своём же дашборде, не данные.
	visitRatePerSec = 1.0
	visitBurst      = 60

	// Колбэк входа через провайдера: ходит во внешний сервис, поэтому долбить
	// его чужими кодами не должно быть дешевле, чем логиниться. Чуть щедрее
	// логина: человек может честно промахнуться (отклонил согласие, вернулся,
	// попробовал снова), а цена ошибки здесь — не подбор пароля.
	oauthRatePerSec = 1.0 / 6.0
	oauthBurst      = 10

	// Сброс пароля (слайс B). Три ведра. forgot по IP: действие редкое (как
	// регистрация) — запас 5, ~1 в 30 с. forgot по email: чтобы нельзя было
	// завалить чужой ящик письмами с разных IP — запас 3, медленное пополнение
	// ~1 в 5 мин. reset по IP: перебор токенов + argon2 на каждый вызов, ведро
	// уровня логина — запас 5, ~1 в 12 с.
	forgotIPRatePerSec    = 1.0 / 30.0
	forgotIPBurst         = 5
	forgotEmailRatePerSec = 1.0 / 300.0
	forgotEmailBurst      = 3
	resetRatePerSec       = 1.0 / 12.0
	resetBurst            = 5

	// Подтверждение email (слайс C). verify по IP: перебор токенов — ведро уровня
	// сброса, запас 5, ~1 в 12 с. resend по пользователю: кнопка «отправить ещё
	// раз» — редкое действие, запас 3, медленное пополнение ~1 в 5 мин (не даём
	// слать письма пачками на свой же ящик).
	verifyRatePerSec = 1.0 / 12.0
	verifyBurst      = 5
	resendRatePerSec = 1.0 / 300.0
	resendBurst      = 3

	// Периодическая чистка истёкших сессий (ARCHITECTURE §4.4).
	sessionCleanupInterval = time.Hour
	sessionCleanupTimeout  = 30 * time.Second

	// Чистка истёкших токенов сброса пароля (живут 30 мин; часового прогона хватает).
	resetTokenCleanupTimeout = 30 * time.Second

	// Чистка истёкших токенов подтверждения email (живут 24 ч; тот же прогон).
	verificationTokenCleanupTimeout = 30 * time.Second

	// Диспетчер outbox (почтовая фаза): раз в интервал отправляет пачку готовых
	// писем. Интервал — компромисс «сброс пароля не должен ощутимо ждать» против
	// «не долбить провайдера вхолостую»; пачка ограничивает работу одного прогона.
	outboxDispatchInterval = 15 * time.Second
	outboxDispatchTimeout  = 30 * time.Second
	outboxBatch            = 50
	// Бэкофф ретраев доставки: первая неудача — 1 мин, дальше удвоение до потолка 1 ч.
	outboxBackoffBase = time.Minute
	outboxBackoffMax  = time.Hour

	// Периодический сбор простаивающих вёдер лимитеров (TD-5): ключ — реальный IP
	// (после TD-1), поэтому карта иначе растёт неограниченно. Вёдра пополняются до
	// burst за ~минуту простоя, так что 10 минут держат карту около активного набора.
	ratelimitGCInterval = 10 * time.Minute
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		// До загрузки конфига уровень неизвестен — ошибку старта пишем временным
		// логгером на stderr (её видно всегда).
		slog.New(slog.NewJSONHandler(os.Stderr, nil)).Error("load config", slog.String("error", err.Error()))
		os.Exit(1)
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))

	if len(os.Args) > 1 {
		if err := runCommand(os.Args[1:], cfg, log); err != nil {
			log.Error("command failed", slog.String("command", os.Args[1]), slog.String("error", err.Error()))
			os.Exit(1)
		}
		return
	}

	if err := runServer(cfg, log); err != nil {
		log.Error("server failed", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

func runCommand(args []string, cfg config.Config, log *slog.Logger) error {
	switch args[0] {
	case "migrate":
		return runMigrate(args[1:], cfg, log)
	case "seed":
		return runSeed(cfg, log)
	case "seed-user":
		return runSeedUser(args[1:], cfg, log)
	default:
		return fmt.Errorf("unknown command %q (known: migrate, seed, seed-user)", args[0])
	}
}

func runMigrate(args []string, cfg config.Config, log *slog.Logger) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: api migrate up|down")
	}
	switch args[0] {
	case "up":
		if err := postgres.MigrateUp(cfg.DatabaseURL); err != nil {
			return err
		}
		log.Info("migrations applied")
		return nil
	case "down":
		if err := postgres.MigrateDown(cfg.DatabaseURL); err != nil {
			return err
		}
		log.Info("migration reverted", slog.Int("steps", 1))
		return nil
	default:
		return fmt.Errorf("unknown migrate direction %q (up|down)", args[0])
	}
}

func runServer(cfg config.Config, log *slog.Logger) error {
	pool, err := postgres.NewPool(context.Background(), cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	// Исходящая почта (почтовая фаза): транспорт выбирается по смысловому флагу
	// MAIL_TRANSPORT, а не по имени окружения. log — письмо «доставляется» записью в
	// лог (dev); smtp — один SMTP-клиент на прод (Postbox) и prod-local (Mailpit),
	// различие лишь в MAIL_SMTP*. Строится раньше authSvc: сброс пароля кладёт письмо
	// через этот сервис.
	var mailer mail.Mailer
	switch cfg.MailTransport {
	case config.MailTransportLog:
		mailer = mail.LogMailer{Log: log, From: cfg.MailFrom}
	case config.MailTransportSMTP:
		mailer = mail.SMTPMailer{
			Host:     cfg.MailSMTPHost,
			Port:     cfg.MailSMTPPort,
			Username: cfg.MailSMTPUsername,
			Password: cfg.MailSMTPPassword,
			TLS:      smtpTLSMode(cfg.MailSMTPTLS),
			From:     cfg.MailFrom,
			Log:      log,
		}
	default:
		// config.Load уже отвалидировал список — сюда не дойдём; страховка на будущее.
		return fmt.Errorf("unsupported MAIL_TRANSPORT %q", cfg.MailTransport)
	}
	mailSvc := mail.NewService(pool, mail.Repo{}, mailer, log, outboxBatch,
		mail.Backoff{Base: outboxBackoffBase, Max: outboxBackoffMax})

	authSvc := auth.NewService(pool, postgres.TxRunner{Pool: pool}, auth.Repo{}, mailSvc, auth.DefaultSessionTTL, cfg.AppOrigin)
	loginLimiter := ratelimit.NewTokenBucket(loginRatePerSec, loginBurst)
	registerLimiter := ratelimit.NewTokenBucket(registerRatePerSec, registerBurst)
	authHandler := auth.NewHandler(authSvc, loginLimiter, registerLimiter, cfg.CookieSecure, cfg.AppOrigin, cfg.TrustedProxy)

	// Сброс пароля (слайс B): три ведра — forgot по IP и по email, reset по IP.
	forgotIPLimiter := ratelimit.NewTokenBucket(forgotIPRatePerSec, forgotIPBurst)
	forgotEmailLimiter := ratelimit.NewTokenBucket(forgotEmailRatePerSec, forgotEmailBurst)
	resetLimiter := ratelimit.NewTokenBucket(resetRatePerSec, resetBurst)
	authHandler = authHandler.WithPasswordReset(forgotIPLimiter, forgotEmailLimiter, resetLimiter)
	verifyLimiter := ratelimit.NewTokenBucket(verifyRatePerSec, verifyBurst)
	resendLimiter := ratelimit.NewTokenBucket(resendRatePerSec, resendBurst)
	authHandler = authHandler.WithEmailVerification(verifyLimiter, resendLimiter)

	// Вход через провайдеров (фаза 11). Нет ключей в окружении — реестр пуст,
	// эндпоинты отдают 404, кабинет работает как раньше.
	oauthProviders := map[string]oauth.Provider{}
	oauthLimiter := ratelimit.NewTokenBucket(oauthRatePerSec, oauthBurst)
	if cfg.YandexOAuthEnabled() {
		oauthProviders["yandex"] = oauth.NewYandex(
			cfg.YandexOAuthClientID,
			cfg.YandexOAuthClientSecret,
			cfg.AppOrigin+"/api/v1/auth/oauth/yandex/callback",
		)
	}
	authHandler = authHandler.WithOAuth(authSvc, oauthProviders, oauthLimiter, cfg.FormTokenSecret)
	log.Info("oauth providers configured", slog.Int("count", len(oauthProviders)))

	workspacesSvc := workspaces.NewService(pool, workspaces.Repo{})
	workspacesHandler := workspaces.NewHandler(workspacesSvc, authHandler.RequireAuth)

	formsSvc := forms.NewService(pool, postgres.TxRunner{Pool: pool}, forms.Repo{})
	formsHandler := forms.NewHandler(formsSvc, authHandler.RequireAuth, authHandler.RequireCSRF)
	formsPublic, err := forms.NewPublicHandler(formsSvc, cfg.FormTokenSecret, cfg.PublicRendererBaseURL, cfg.OGImageURL, cfg.PublicRendererIndexPath)
	if err != nil {
		return fmt.Errorf("init public forms handler: %w", err)
	}

	blobClient := blob.New(blob.Config{
		Endpoint:  cfg.S3Endpoint,
		Region:    cfg.S3Region,
		AccessKey: cfg.S3AccessKey,
		SecretKey: cfg.S3SecretKey,
		PathStyle: cfg.S3PathStyle,
	})
	mediaSvc := media.NewService(formsSvc, blobClient, cfg.S3MediaBucket)
	mediaHandler := media.NewHandler(mediaSvc, authHandler.RequireAuth, authHandler.RequireCSRF)

	visitLimiter := ratelimit.NewTokenBucket(visitRatePerSec, visitBurst)
	visitsSvc := visits.NewService(pool, formsSvc, visits.Repo{})
	visitsPublic := visits.NewPublicHandler(visitsSvc, visitLimiter, cfg.FormTokenSecret, cfg.TrustedProxy)
	visitsHandler := visits.NewHandler(visitsSvc, authHandler.RequireAuth)

	// Единая точка лимитов тарифа (фаза 17): её спрашивают приём ответа и чтение
	// аналитики. Собирается до потребителей, живёт на том же пуле.
	entitlementsSvc := entitlements.NewService(pool, entitlements.Repo{}, time.Now)

	submitLimiter := ratelimit.NewTokenBucket(submitRatePerSec, submitBurst)
	submissionsSvc := submissions.NewService(pool, postgres.TxRunner{Pool: pool}, formsSvc, visitsSvc, mailSvc, entitlementsSvc, submissions.Repo{}, cfg.AppOrigin)
	submissionsPublic := submissions.NewPublicHandler(submissionsSvc, submitLimiter, cfg.FormTokenSecret, submissions.DefaultMinFillTime, cfg.TrustedProxy)
	submissionsHandler := submissions.NewHandler(submissionsSvc, authHandler.RequireAuth, authHandler.RequireCSRF)

	srv := httpserver.New(cfg.HTTPAddr, log, pool,
		authHandler.Routes, authHandler.OAuthRoutes, workspacesHandler.Routes, formsHandler.Routes, formsPublic.Routes,
		submissionsPublic.Routes, submissionsHandler.Routes, mediaHandler.Routes,
		visitsPublic.Routes, visitsHandler.Routes)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Фоновые периодические задачи живут, пока не отменён ctx (SIGINT/SIGTERM).
	tasks := periodic.NewRunner(log)
	tasks.Start(ctx, periodic.Task{
		Name:     "session-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, sessionCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredSessions(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired sessions purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "reset-token-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, resetTokenCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredPasswordResetTokens(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired password reset tokens purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "verification-token-cleanup",
		Interval: sessionCleanupInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, verificationTokenCleanupTimeout)
			defer cancel()
			n, err := authSvc.PurgeExpiredEmailVerificationTokens(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("expired email verification tokens purged", slog.Int64("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "outbox-dispatch",
		Interval: outboxDispatchInterval,
		Run: func(ctx context.Context) error {
			ctx, cancel := context.WithTimeout(ctx, outboxDispatchTimeout)
			defer cancel()
			n, err := mailSvc.Dispatch(ctx)
			if err != nil {
				return err
			}
			if n > 0 {
				log.Info("outbox messages delivered", slog.Int("count", n))
			}
			return nil
		},
	})
	tasks.Start(ctx, periodic.Task{
		Name:     "ratelimit-gc",
		Interval: ratelimitGCInterval,
		Run: func(context.Context) error {
			removed := loginLimiter.GC() + registerLimiter.GC() + submitLimiter.GC() + oauthLimiter.GC() +
				forgotIPLimiter.GC() + forgotEmailLimiter.GC() + resetLimiter.GC() +
				verifyLimiter.GC() + resendLimiter.GC()
			if removed > 0 {
				log.Debug("rate-limit buckets evicted", slog.Int("count", removed))
			}
			return nil
		},
	})

	serveErr := make(chan error, 1)
	go func() {
		log.Info("http server listening", slog.String("addr", cfg.HTTPAddr))
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		return fmt.Errorf("listen: %w", err)
	case <-ctx.Done():
	}

	// Graceful shutdown: дождаться активных запросов с потолком 15 секунд.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	// ctx уже отменён (stop по сигналу); дождаться остановки фоновых задач до
	// закрытия пула (defer), иначе чистка может выстрелить в закрытый пул.
	tasks.Wait()
	log.Info("http server stopped")
	return nil
}

// smtpTLSMode переводит валидированный конфиг MAIL_SMTP_TLS в режим транспорта.
// config уже отверг чужие значения при старте, поэтому default недостижим —
// оставлен страховкой (пусть безопасный: без шифрования наружу не пойдём молча).
func smtpTLSMode(v string) mail.TLSMode {
	switch v {
	case config.MailSMTPTLSStartTLS:
		return mail.TLSStartTLS
	case config.MailSMTPTLSImplicit:
		return mail.TLSImplicit
	default:
		return mail.TLSNone
	}
}
