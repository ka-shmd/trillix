package answerfiles

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// File — загрузка в проекции, которой пользуются все читатели модуля.
type File struct {
	ID           uuid.UUID
	WorkspaceID  uuid.UUID
	FormID       uuid.UUID
	SubmissionID uuid.UUID // uuid.Nil у незаявленной
	BlockID      string
	ObjectKey    string
	OriginalName string
	SizeBytes    int64
	ContentType  string
	CreatedAt    time.Time
}

// NewFile — что кладём при выдаче слота. Структурой, а не восемью позиционными
// аргументами: половина из них — uuid, и перепутать их местами нельзя заметить ни
// глазами, ни компилятором.
type NewFile struct {
	ID           uuid.UUID
	WorkspaceID  uuid.UUID
	FormID       uuid.UUID
	BlockID      string
	ObjectKey    string
	OriginalName string
	SizeBytes    int64
	ContentType  string
}

// Repo — доступ к данным submission_files поверх sqlc. Методы принимают
// исполнителя (пул или транзакция); транзакций сам не открывает.
type Repo struct{}

func (Repo) Insert(ctx context.Context, db postgres.DBTX, f NewFile) error {
	err := postgres.New(db).InsertSubmissionFile(ctx, postgres.InsertSubmissionFileParams{
		ID:           f.ID,
		WorkspaceID:  f.WorkspaceID,
		FormID:       f.FormID,
		BlockID:      f.BlockID,
		ObjectKey:    f.ObjectKey,
		OriginalName: f.OriginalName,
		SizeBytes:    f.SizeBytes,
		ContentType:  f.ContentType,
	})
	if err != nil {
		return fmt.Errorf("insert submission file %s: %w", f.ID, err)
	}
	return nil
}

// ForAnswer — загрузка, которую этот ответ вправе назвать: либо ещё не заявленная,
// либо заявленная ИМ ЖЕ (повторная отправка после обрыва сети шлёт тот же
// submission_id). pgx.ErrNoRows пробрасывается: «нет такой» и «заявлена чужим
// ответом» — один случай для вызывающего, и оба означают отказ.
func (Repo) ForAnswer(ctx context.Context, db postgres.DBTX, id, submissionID uuid.UUID) (File, error) {
	row, err := postgres.New(db).GetSubmissionFileForAnswer(ctx, postgres.GetSubmissionFileForAnswerParams{
		ID:           id,
		SubmissionID: pgtype.UUID{Bytes: submissionID, Valid: true},
	})
	if err != nil {
		return File{}, fmt.Errorf("get submission file %s for answer: %w", id, err)
	}
	return File{
		ID:           row.ID,
		WorkspaceID:  row.WorkspaceID,
		FormID:       row.FormID,
		BlockID:      row.BlockID,
		ObjectKey:    row.ObjectKey,
		OriginalName: row.OriginalName,
		SizeBytes:    row.SizeBytes,
		ContentType:  row.ContentType,
		CreatedAt:    row.CreatedAt.Time,
	}, nil
}

// Claim привязывает загрузку к ответу. Форма и блок — часть условия, а не проверка
// после чтения: файл, выданный другому вопросу, заявить нельзя, и решает это база.
// Размер не трогается — он проверен до вставки (см. запрос).
//
// Возвращает false, если строка не подошла (уже заявлена, чужая форма, другой
// блок) — вызывающий обязан отвергнуть ответ, а не молча его принять.
func (Repo) Claim(ctx context.Context, db postgres.DBTX, id, submissionID uuid.UUID, formID uuid.UUID, blockID string) (bool, error) {
	n, err := postgres.New(db).ClaimSubmissionFile(ctx, postgres.ClaimSubmissionFileParams{
		ID:           id,
		SubmissionID: pgtype.UUID{Bytes: submissionID, Valid: true},
		FormID:       formID,
		BlockID:      blockID,
	})
	if err != nil {
		return false, fmt.Errorf("claim submission file %s: %w", id, err)
	}
	return n == 1, nil
}

// OfFormSubmission — файлы ОДНОГО ответа в пределах формы (удаление). Форма в
// условии обязательна: право проверяется по форме из адреса, а id ответа рядом с ним
// ничем с этой формой не связан.
func (Repo) OfFormSubmission(ctx context.Context, db postgres.DBTX, formID, submissionID uuid.UUID) ([]File, error) {
	rows, err := postgres.New(db).ListFormSubmissionFiles(ctx, postgres.ListFormSubmissionFilesParams{
		SubmissionID: pgtype.UUID{Bytes: submissionID, Valid: true},
		FormID:       formID,
	})
	if err != nil {
		return nil, fmt.Errorf("list files of submission %s: %w", submissionID, err)
	}
	out := make([]File, 0, len(rows))
	for _, r := range rows {
		out = append(out, File{ID: r.ID, ObjectKey: r.ObjectKey})
	}
	return out, nil
}

// DeleteOrphans снимает строки СИРОТ: то же, что Delete, но с проверкой
// незаявленности — она страхует окно между листингом сирот и их удалением.
func (Repo) DeleteOrphans(ctx context.Context, db postgres.DBTX, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	if err := postgres.New(db).DeleteOrphanSubmissionFiles(ctx, ids); err != nil {
		return fmt.Errorf("delete orphan submission files: %w", err)
	}
	return nil
}

// BySubmissions — файлы перечисленных ответов (таблица ответов, выгрузка,
// удаление). Пустой список ответов даёт пустой результат, а не все файлы.
func (Repo) BySubmissions(ctx context.Context, db postgres.DBTX, ids []uuid.UUID) ([]File, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := postgres.New(db).ListSubmissionFiles(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("list submission files: %w", err)
	}
	out := make([]File, 0, len(rows))
	for _, r := range rows {
		out = append(out, File{
			ID:           r.ID,
			SubmissionID: uuid.UUID(r.SubmissionID.Bytes),
			BlockID:      r.BlockID,
			ObjectKey:    r.ObjectKey,
			OriginalName: r.OriginalName,
			SizeBytes:    r.SizeBytes,
			ContentType:  r.ContentType,
		})
	}
	return out, nil
}

// Get — заявленный файл по id (скачивание автором). Право доступа проверяет
// сервис по воркспейсу формы: id из URL правом не является (инвариант 1).
func (Repo) Get(ctx context.Context, db postgres.DBTX, id uuid.UUID) (File, error) {
	row, err := postgres.New(db).GetSubmissionFile(ctx, id)
	if err != nil {
		return File{}, fmt.Errorf("get submission file %s: %w", id, err)
	}
	return File{
		ID:           row.ID,
		WorkspaceID:  row.WorkspaceID,
		FormID:       row.FormID,
		SubmissionID: uuid.UUID(row.SubmissionID.Bytes),
		ObjectKey:    row.ObjectKey,
		OriginalName: row.OriginalName,
		ContentType:  row.ContentType,
	}, nil
}

// Orphans — незаявленные загрузки старше срока, порцией. Порция ограничена:
// чистка ходит по расписанию и не должна выгребать таблицу одним запросом.
func (Repo) Orphans(ctx context.Context, db postgres.DBTX, olderThan time.Time, limit int32) ([]File, error) {
	rows, err := postgres.New(db).ListOrphanSubmissionFiles(ctx, postgres.ListOrphanSubmissionFilesParams{
		CreatedAt: pgtype.Timestamptz{Time: olderThan, Valid: true},
		Limit:     limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list orphan submission files: %w", err)
	}
	out := make([]File, 0, len(rows))
	for _, r := range rows {
		out = append(out, File{ID: r.ID, ObjectKey: r.ObjectKey})
	}
	return out, nil
}

// Delete снимает строки по id. Зовётся ПОСЛЕ удаления объектов: строка уносит с
// собой ключ, и объект, переживший её, найти уже нечем.
func (Repo) Delete(ctx context.Context, db postgres.DBTX, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	if err := postgres.New(db).DeleteSubmissionFiles(ctx, ids); err != nil {
		return fmt.Errorf("delete submission files: %w", err)
	}
	return nil
}

// KeysByForm — ключи файлов формы порцией (снос при удалении формы).
func (Repo) KeysByForm(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32) ([]File, error) {
	rows, err := postgres.New(db).ListFormFileKeys(ctx, postgres.ListFormFileKeysParams{FormID: formID, Limit: limit})
	if err != nil {
		return nil, fmt.Errorf("list file keys of form %s: %w", formID, err)
	}
	out := make([]File, 0, len(rows))
	for _, r := range rows {
		out = append(out, File{ID: r.ID, ObjectKey: r.ObjectKey})
	}
	return out, nil
}

// ByForm — все заявленные файлы формы (имя и размер), для выгрузки.
func (Repo) ByForm(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]File, error) {
	rows, err := postgres.New(db).ListFormFiles(ctx, formID)
	if err != nil {
		return nil, fmt.Errorf("list form files %s: %w", formID, err)
	}
	out := make([]File, 0, len(rows))
	for _, r := range rows {
		out = append(out, File{ID: r.ID, OriginalName: r.OriginalName, SizeBytes: r.SizeBytes})
	}
	return out, nil
}
