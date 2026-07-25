//go:build integration

// Интеграционный тест команд сидирования против настоящего Postgres в контейнере.
//
// Предмет — проводка `seedAuthService`, а не наполнение данными: с фазы 12
// `auth.Service.Register` кладёт письмо-подтверждение в outbox, и сидер, собранный с
// nil вместо почтовой зависимости, падал в SIGSEGV. Дефект прятался за
// идемпотентностью: на непустой базе `Register` возвращает ErrEmailTaken раньше места
// падения, поэтому ломался только сид по ЧИСТОЙ базе — то есть ровно тот случай,
// ради которого сидер и существует.
package main

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/pgtest"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) {
	ctx := context.Background()
	pool, stop, err := pgtest.Start(ctx)
	if err != nil {
		panic(err)
	}
	testPool = pool
	code := m.Run()
	stop()
	os.Exit(code)
}

// Регистрация сидером на ЧИСТОЙ базе доходит до конца: письмо подтверждения уходит в
// заглушку, а не в nil. Мутация «вернуть nil вместо seedOutbox{}» валит тест паникой.
func TestSeedAuthService_RegistersOnEmptyDatabase(t *testing.T) {
	ctx := context.Background()
	svc := seedAuthService(testPool)

	user, token, err := svc.Register(ctx, "seed-fresh@example.com", "supersecret123")
	if err != nil {
		t.Fatalf("регистрация на чистой базе: %v", err)
	}
	if user.ID == uuid.Nil || token == "" {
		t.Fatalf("регистрация вернула пустые id/токен: %v / %q", user.ID, token)
	}

	// Повтор — та самая ветка, на которую опирается идемпотентность обеих команд
	// (`seed` и `seed-user`): существующий адрес не ошибка выполнения.
	if _, _, err := svc.Register(ctx, "seed-fresh@example.com", "supersecret123"); !errors.Is(err, domain.ErrEmailTaken) {
		t.Fatalf("повторная регистрация: ошибка = %v, ожидалась ErrEmailTaken", err)
	}
}
