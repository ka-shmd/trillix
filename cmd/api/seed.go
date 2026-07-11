package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/ka-shmd/trierra/internal/auth"
	"github.com/ka-shmd/trierra/internal/config"
	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/forms"
	"github.com/ka-shmd/trierra/internal/postgres"
)

// Демо-пользователь и объём сидирования. Учётка чисто dev-фикстура (пароль —
// известная константа в Makefile-подсказке, не секрет). 60 форм > одной страницы
// (DefaultPageLimit=50) — ровно чтобы проверять курсорную пагинацию глазами.
const (
	seedEmail    = "demo@trierra.local"
	seedPassword = "demo-password"
	seedFormsN   = 60
)

// runSeed наполняет БД демо-данными (пользователь + формы). Идемпотентен: если у
// демо-пользователя уже есть формы, ничего не добавляет (повторный запуск не
// плодит дубли).
func runSeed(cfg config.Config, log *slog.Logger) error {
	ctx := context.Background()
	pool, err := postgres.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()

	authSvc := auth.NewService(pool, postgres.TxRunner{Pool: pool}, auth.Repo{}, auth.DefaultSessionTTL)
	formsSvc := forms.NewService(pool, forms.Repo{})

	// Создать демо-пользователя или найти уже существующего.
	user, _, err := authSvc.Register(ctx, seedEmail, seedPassword)
	switch {
	case err == nil:
		log.Info("seed: demo user created", slog.String("email", seedEmail))
	case errors.Is(err, domain.ErrEmailTaken):
		if user, err = authSvc.UserByEmail(ctx, seedEmail); err != nil {
			return fmt.Errorf("lookup existing seed user: %w", err)
		}
		log.Info("seed: demo user already exists", slog.String("email", seedEmail))
	default:
		return fmt.Errorf("register seed user: %w", err)
	}

	// Идемпотентность: если формы уже есть — не досыпаем.
	page, err := formsSvc.List(ctx, user.ID, nil, forms.MaxPageLimit)
	if err != nil {
		return fmt.Errorf("check existing forms: %w", err)
	}
	if len(page.Forms) > 0 {
		log.Info("seed: forms already present, skipping",
			slog.Int("existing", len(page.Forms)))
		return nil
	}

	for i := 1; i <= seedFormsN; i++ {
		title := fmt.Sprintf("Демо-форма №%02d", i)
		if _, err := formsSvc.Create(ctx, user.ID, title); err != nil {
			return fmt.Errorf("create seed form %d: %w", i, err)
		}
	}
	log.Info("seed: forms created", slog.Int("count", seedFormsN))
	return nil
}
