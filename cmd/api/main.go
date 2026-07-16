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

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/blob"
	"github.com/ka-shmd/trierra/internal/config"
	"github.com/ka-shmd/trierra/internal/forms"
	"github.com/ka-shmd/trierra/internal/httpserver"
	"github.com/ka-shmd/trierra/internal/media"
	"github.com/ka-shmd/trierra/internal/periodic"
	"github.com/ka-shmd/trierra/internal/postgres"
	"github.com/ka-shmd/trierra/internal/ratelimit"
	"github.com/ka-shmd/trierra/internal/submissions"
	"github.com/ka-shmd/trierra/internal/workspaces"
)

// Жёсткий лимит на POST /auth/login по IP: запас 5 попыток, пополнение ~1 в 12 с.
const (
	loginRatePerSec = 1.0 / 12.0
	loginBurst      = 5

	// Жёсткий лимит на POST приёма ответа по IP (отдельный от логина): запас 20,
	// пополнение ~1 в 3 с (устойчиво ~20/мин). Терпимо к киоску, где несколько
	// человек отвечают с одного IP, но режет автоматический перебор.
	submitRatePerSec = 1.0 / 3.0
	submitBurst      = 20

	// Периодическая чистка истёкших сессий (ARCHITECTURE §4.4).
	sessionCleanupInterval = time.Hour
	sessionCleanupTimeout  = 30 * time.Second
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	cfg, err := config.Load()
	if err != nil {
		log.Error("load config", slog.String("error", err.Error()))
		os.Exit(1)
	}

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
	default:
		return fmt.Errorf("unknown command %q (known: migrate, seed)", args[0])
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

	authSvc := auth.NewService(pool, postgres.TxRunner{Pool: pool}, auth.Repo{}, auth.DefaultSessionTTL)
	loginLimiter := ratelimit.NewTokenBucket(loginRatePerSec, loginBurst)
	authHandler := auth.NewHandler(authSvc, loginLimiter, cfg.CookieSecure, cfg.AppOrigin)

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

	submitLimiter := ratelimit.NewTokenBucket(submitRatePerSec, submitBurst)
	submissionsSvc := submissions.NewService(pool, formsSvc, submissions.Repo{})
	submissionsPublic := submissions.NewPublicHandler(submissionsSvc, submitLimiter, cfg.FormTokenSecret, submissions.DefaultMinFillTime)
	submissionsHandler := submissions.NewHandler(submissionsSvc, authHandler.RequireAuth, authHandler.RequireCSRF)

	srv := httpserver.New(cfg.HTTPAddr, log,
		authHandler.Routes, workspacesHandler.Routes, formsHandler.Routes, formsPublic.Routes,
		submissionsPublic.Routes, submissionsHandler.Routes, mediaHandler.Routes)

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
