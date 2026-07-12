package submissions

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/postgres"
)

// Repo — доступ к данным submissions поверх sqlc. Методы принимают исполнителя
// (postgres.DBTX: пул или транзакция); транзакций сам не открывает.
type Repo struct{}

// InsertSubmission пишет ответ. Возвращает число вставленных строк: 0 означает
// конфликт по PK (клиент прислал уже принятый id при ретрае) — вызывающий трактует
// это как идемпотентный успех, а не ошибку.
func (Repo) InsertSubmission(ctx context.Context, db postgres.DBTX, id, formID, versionID uuid.UUID, answers, meta json.RawMessage) (int64, error) {
	n, err := postgres.New(db).InsertSubmission(ctx, postgres.InsertSubmissionParams{
		ID:            id,
		FormID:        formID,
		FormVersionID: versionID,
		Answers:       answers,
		Meta:          meta,
	})
	if err != nil {
		return 0, fmt.Errorf("insert submission: %w", err)
	}
	return n, nil
}
