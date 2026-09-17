package pgtest

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/auth"
	"github.com/ka-shmd/trillix/internal/legal"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Гейт согласия в интеграционных тестах модулей (docs/design/signup-consent.md §3.8).
// Пермиссивного гейта нет: стек собирается с настоящим, а пользователь теста завершает
// регистрацию тем же вызовом, что и сидер. Забытое подключение даёт 500 на приватных
// ручках, забытое завершение — 403 consent_required.

// Consents сверяет редакции реестра с базой и подключает гейт согласия к authSvc — как
// composition root.
func Consents(t testing.TB, pool *pgxpool.Pool, authSvc *auth.Service) *legal.Service {
	t.Helper()
	svc := legalService(t, pool, authSvc)
	authSvc.WithConsents(svc)
	return svc
}

// CompleteSignup принимает за пользователя с адресом email действующую редакцию
// соглашения (источник seed).
func CompleteSignup(t testing.TB, pool *pgxpool.Pool, email string) {
	t.Helper()
	ctx := context.Background()
	authSvc := auth.NewService(pool, postgres.TxRunner{Pool: pool}, auth.Repo{}, MailService(pool), time.Hour, "")
	user, err := authSvc.UserByEmail(ctx, email)
	if err != nil {
		t.Fatalf("pgtest: пользователь %s: %v", email, err)
	}
	if err := legalService(t, pool, authSvc).AcceptForSeed(ctx, user.ID, user.Email); err != nil {
		t.Fatalf("pgtest: завершение регистрации %s: %v", email, err)
	}
}

func legalService(t testing.TB, pool *pgxpool.Pool, authSvc *auth.Service) *legal.Service {
	t.Helper()
	editions, err := legal.Editions()
	if err != nil {
		t.Fatalf("pgtest: реестр документов: %v", err)
	}
	svc := legal.NewService(pool, postgres.TxRunner{Pool: pool}, legal.Repo{}, authSvc, editions, time.Now)
	if _, err := svc.Sync(context.Background()); err != nil {
		t.Fatalf("pgtest: сверка документов: %v", err)
	}
	return svc
}
