package visits

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trierra/internal/domain"
	"github.com/ka-shmd/trierra/internal/postgres"
)

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

// CountByLastBlock — раскладка визитов по самой дальней точке (сырьё воронки).
// Пустой BlockID — визиты, не тронувшие ни одного вопроса (last_block_id IS NULL).
func (Repo) CountByLastBlock(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]domain.LastBlockCount, error) {
	rows, err := postgres.New(db).CountVisitsByLastBlock(ctx, formID)
	if err != nil {
		return nil, fmt.Errorf("count visits by last block: %w", err)
	}
	out := make([]domain.LastBlockCount, len(rows))
	for i, r := range rows {
		out[i] = domain.LastBlockCount{
			BlockID:   r.LastBlockID.String, // невалидный (NULL) даёт "" — верх воронки
			Submitted: r.Submitted,
			Visits:    int(r.Visits),
		}
	}
	return out, nil
}
