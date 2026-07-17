package submissions

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trierra/internal/postgres"
)

// Submission — ответ в проекции листинга кабинета: id, номер версии формы, по
// которой он отправлен, содержимое ответов и время. meta (user_agent/referer) в
// листинг не выносим — оно для антиспама, а не для автора формы.
type Submission struct {
	ID          uuid.UUID
	FormVersion int32
	Answers     json.RawMessage
	CreatedAt   time.Time
}

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

// ListSubmissions — первая страница ответов формы (новые сверху).
func (Repo) ListSubmissions(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32) ([]Submission, error) {
	rows, err := postgres.New(db).ListSubmissionsFirstPage(ctx, postgres.ListSubmissionsFirstPageParams{
		FormID: formID,
		Limit:  limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list submissions: %w", err)
	}
	out := make([]Submission, len(rows))
	for i, r := range rows {
		out[i] = Submission{
			ID:          r.ID,
			FormVersion: r.FormVersion,
			Answers:     json.RawMessage(r.Answers),
			CreatedAt:   r.CreatedAt.Time,
		}
	}
	return out, nil
}

// ListSubmissionsAfter — следующая страница одноколоночным курсором (id).
func (Repo) ListSubmissionsAfter(ctx context.Context, db postgres.DBTX, formID, cursorID uuid.UUID, limit int32) ([]Submission, error) {
	rows, err := postgres.New(db).ListSubmissionsAfter(ctx, postgres.ListSubmissionsAfterParams{
		FormID:   formID,
		CursorID: cursorID,
		Limit:    limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list submissions after cursor: %w", err)
	}
	out := make([]Submission, len(rows))
	for i, r := range rows {
		out[i] = Submission{
			ID:          r.ID,
			FormVersion: r.FormVersion,
			Answers:     json.RawMessage(r.Answers),
			CreatedAt:   r.CreatedAt.Time,
		}
	}
	return out, nil
}

// DeleteSubmission удаляет один ответ в пределах формы; возвращает число удалённых
// строк (0 → ответа нет или он принадлежит другой форме).
func (Repo) DeleteSubmission(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteSubmission(ctx, postgres.DeleteSubmissionParams{ID: id, FormID: formID})
	if err != nil {
		return 0, fmt.Errorf("delete submission: %w", err)
	}
	return n, nil
}

// CountSubmissions — общее число ответов формы (счётчик кабинета).
func (Repo) CountSubmissions(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).CountSubmissions(ctx, formID)
	if err != nil {
		return 0, fmt.Errorf("count submissions: %w", err)
	}
	return n, nil
}

// LockFormForSubmit берёт транзакционный advisory-lock по форме (жёсткий кап лимита,
// шаг 4): сериализует конкурентные приёмы одной формы, поэтому счёт точен. Должен
// вызываться внутри транзакции (db — pgx.Tx); блокировка снимается на commit/rollback.
func (Repo) LockFormForSubmit(ctx context.Context, db postgres.DBTX, formID uuid.UUID) error {
	if err := postgres.New(db).LockFormForSubmit(ctx, formID.String()); err != nil {
		return fmt.Errorf("lock form for submit: %w", err)
	}
	return nil
}
