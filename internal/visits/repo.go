package visits

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trierra/internal/postgres"
)

// Counts — просмотры формы и сколько из них закончились ответом. Конверсию считает
// потребитель (кабинет): хранить третье производное число незачем.
type Counts struct {
	Total     int64
	Submitted int64
}

// Repo — доступ к данным form_visits поверх sqlc. Методы принимают исполнителя
// (postgres.DBTX: пул или транзакция); транзакций сам не открывает.
type Repo struct{}

// UpsertVisit пишет визит или двигает его вперёд (см. queries.sql: обновляются
// ровно last_block_id и seq, и только при большем seq той же формы). Отсутствие
// эффекта — штатный исход (бикон приехал не по порядку), а не ошибка: отличать их
// вызывающему незачем, поэтому число строк наружу не отдаётся.
func (Repo) UpsertVisit(ctx context.Context, db postgres.DBTX, id, formID, versionID uuid.UUID, lastBlockID *string, seq int16, meta json.RawMessage) error {
	block := pgtype.Text{}
	if lastBlockID != nil {
		block = pgtype.Text{String: *lastBlockID, Valid: true}
	}
	err := postgres.New(db).UpsertFormVisit(ctx, postgres.UpsertFormVisitParams{
		ID:            id,
		FormID:        formID,
		FormVersionID: versionID,
		LastBlockID:   block,
		Seq:           seq,
		Meta:          meta,
	})
	if err != nil {
		return fmt.Errorf("upsert form visit: %w", err)
	}
	return nil
}

// MarkSubmitted отмечает визит как закончившийся ответом. Возвращает число
// затронутых строк: 0 означает «визита нет» (бикон потерялся, id подделан) — для
// вызывающего это не ошибка, ответ уже принят.
func (Repo) MarkSubmitted(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).MarkVisitSubmitted(ctx, postgres.MarkVisitSubmittedParams{ID: id, FormID: formID})
	if err != nil {
		return 0, fmt.Errorf("mark visit submitted: %w", err)
	}
	return n, nil
}

// CountVisits — просмотры и конверсия формы (счётчики кабинета).
func (Repo) CountVisits(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (Counts, error) {
	row, err := postgres.New(db).CountFormVisits(ctx, formID)
	if err != nil {
		return Counts{}, fmt.Errorf("count form visits: %w", err)
	}
	return Counts{Total: row.Total, Submitted: row.Submitted}, nil
}
