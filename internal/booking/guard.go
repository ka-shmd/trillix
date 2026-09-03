package booking

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// СТОП-КРАН УДАЛЕНИЯ (фаза 27, решение владельца 2026-09-03, ADR §10).
//
// Живая будущая запись запрещает удалять ответ и форму. Оба исхода без него плохи
// одинаково: снести бронь вместе с ответом значит молча убрать из расписания встречу,
// не предупредив клиента (его адрес лежал в том же удалённом ответе), а оставить —
// показывать автору занятое время, о котором больше ничего не известно.
//
// ПРОШЛЫЕ ЗАПИСИ НЕ ДЕРЖАТ НИЧЕГО: они уже состоялись, и обычная уборка старых
// ответов — в том числе удаление по требованию человека (152-ФЗ) — со стоп-краном
// почти не встречается.
//
// Считаются только ПОДТВЕРЖДЁННЫЕ: холд ещё не договорённость (ни ответа, ни письма
// записавшемуся), и отдавать ему право запрета на четверть часа не за что.

// GuardStore — доступ к данным стоп-крана.
type GuardStore interface {
	CountFutureBookingsOfForm(ctx context.Context, db postgres.DBTX, formID uuid.UUID, from time.Time) (int64, error)
	CountFutureBookingsOfSubmission(ctx context.Context, db postgres.DBTX, submissionID uuid.UUID, from time.Time) (int64, error)
	FormScheduleZone(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (string, error)
}

var _ GuardStore = Repo{}

// Guard отвечает на один вопрос: сколько живых будущих записей держит эта сущность.
// Текст отказа пишет тот, кто спрашивает: у формы и у ответа он разный.
type Guard struct {
	db   postgres.DBTX
	repo GuardStore
	now  func() time.Time
}

func NewGuard(db postgres.DBTX, repo GuardStore) *Guard {
	return &Guard{db: db, repo: repo, now: time.Now}
}

// WithClock подменяет часы (тесты).
func (g *Guard) WithClock(now func() time.Time) *Guard {
	g.now = now
	return g
}

// FutureOfForm — живые будущие записи формы.
func (g *Guard) FutureOfForm(ctx context.Context, formID uuid.UUID) (int64, error) {
	return g.repo.CountFutureBookingsOfForm(ctx, g.db, formID, g.now())
}

// FutureOfSubmission — живые будущие записи одного ответа.
func (g *Guard) FutureOfSubmission(ctx context.Context, submissionID uuid.UUID) (int64, error) {
	return g.repo.CountFutureBookingsOfSubmission(ctx, g.db, submissionID, g.now())
}

// ZoneOfForm — пояс расписания формы для выгрузок. Пусто, если записи у формы нет:
// колонки времени в такой выгрузке не встретится вовсе.
//
// Живёт здесь, у стража, а не отдельным сервисом: у обоих один вопрос — «что модуль
// записи знает про эту форму», и второй объект ради одной строки не окупается.
func (g *Guard) ZoneOfForm(ctx context.Context, formID uuid.UUID) string {
	zone, err := g.repo.FormScheduleZone(ctx, g.db, formID)
	if err != nil {
		// Нет расписания — не ошибка, а самый частый случай.
		return ""
	}
	return zone
}
