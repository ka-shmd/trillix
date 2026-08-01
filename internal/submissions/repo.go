package submissions

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/postgres"
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

// NewSubmission — что кладём при приёме ответа. Структурой, а не восемью
// позиционными аргументами: половина из них — uuid, и перепутать их местами
// нельзя было бы заметить ни глазами, ни компилятором.
type NewSubmission struct {
	ID        uuid.UUID
	FormID    uuid.UUID
	VersionID uuid.UUID
	Answers   json.RawMessage
	Meta      json.RawMessage
	// WorkspaceID и Period — адрес счётчика расхода тарифа (фаза 17): инкремент
	// едет тем же утверждением, что вставка.
	WorkspaceID uuid.UUID
	Period      time.Time
	// OverQuota — ответ пришёл сверх квоты плана. Не отказ: строка сохраняется,
	// скрыт ответ только в кабинете владельца.
	OverQuota bool
}

// InsertSubmission пишет ответ и инкрементит расход тарифа одним утверждением.
// Возвращает число вставленных строк: 0 означает конфликт по PK (клиент прислал
// уже принятый id при ретрае) — вызывающий трактует это как идемпотентный успех,
// а не ошибку; расход при таком ретрае тоже не растёт.
func (Repo) InsertSubmission(ctx context.Context, db postgres.DBTX, in NewSubmission) (int64, error) {
	n, err := postgres.New(db).InsertSubmission(ctx, postgres.InsertSubmissionParams{
		ID:            in.ID,
		FormID:        in.FormID,
		FormVersionID: in.VersionID,
		Answers:       in.Answers,
		Meta:          in.Meta,
		OverQuota:     in.OverQuota,
		WorkspaceID:   in.WorkspaceID,
		Period:        pgtype.Date{Time: in.Period, Valid: true},
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

// CountSubmissionsForCabinet — видимые и скрытые тарифом ответы формы одной
// поездкой (0014).
func (Repo) CountSubmissionsForCabinet(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (visible, hidden int64, err error) {
	row, err := postgres.New(db).CountSubmissionsForCabinet(ctx, formID)
	if err != nil {
		return 0, 0, fmt.Errorf("count submissions for cabinet: %w", err)
	}
	return row.Visible, row.Hidden, nil
}

// RevealHidden снимает пометку over_quota со всех ответов воркспейса — переход на
// план, который их вмещает. Возвращает число открытых ответов.
//
// В интерфейсе Store его НЕТ: сервисного потребителя сегодня не существует —
// смена плана делается операцией владельца в БД, а эндпоинт покупки приедет с
// платежами (PROCESS §2: интерфейс вводится вместе с потребителем). Метод живёт
// здесь, а не только в SQL, чтобы обратимость скрытия сторожил тест, а не вера.
func (Repo) RevealHidden(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).RevealHiddenSubmissions(ctx, workspaceID)
	if err != nil {
		return 0, fmt.Errorf("reveal hidden submissions: %w", err)
	}
	return n, nil
}

// CountSubmissions — ВСЕ ответы формы, включая скрытые тарифом. Потребитель —
// жёсткий кап формы; кабинету нужен CountSubmissionsForCabinet.
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
