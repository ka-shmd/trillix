package answerfiles

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/blob"
	"github.com/ka-shmd/trillix/internal/domain"
)

// OrphanTTL — сколько живёт незаявленная загрузка. Ровно потолок возраста токена
// формы (token.MaxAge): дольше её ответ прийти уже не может, значит объект в бакете
// не станет ничем, кроме счёта за хранение.
const OrphanTTL = 24 * time.Hour

// orphanBatch — сколько сирот сносится за один проход. Ограничение не про
// производительность, а про предсказуемость: задача ходит по расписанию, и проход,
// выгребающий таблицу целиком, однажды совпал бы с пиком нагрузки.
const orphanBatch = 200

// Download — что нужно, чтобы отдать файл автору: короткий адрес и имя.
type Download struct {
	URL  string
	Name string
}

// DownloadURL выдаёт автору короткий адрес скачивания. Право проверяется по
// ВОРКСПЕЙСУ ФОРМЫ, к которой приложен файл (инвариант 1): id из URL правом доступа
// не является, и чужой файл обязан отвечать 404, а не 403 — существование чужих
// ответов не раскрывается.
//
// Отдаётся редиректом на подпись, а не потоком через нас: байты не ходят через
// процесс ни в одну сторону. Файл при этом всегда СКАЧИВАЕТСЯ (Content-Disposition
// и тип переопределены подписью) — открыть чужой HTML в origin хранилища нельзя.
func (s *Service) DownloadURL(ctx context.Context, userID, fileID uuid.UUID) (Download, error) {
	f, err := s.repo.Get(ctx, s.db, fileID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Download{}, domain.ErrNotFound
		}
		return Download{}, err
	}
	// Членство спрашивается у forms — та же дверь, что у остальных чтений формы.
	if _, err := s.forms.Get(ctx, userID, f.FormID); err != nil {
		return Download{}, err
	}
	url, err := s.bucket.DownloadURL(f.ObjectKey, f.OriginalName)
	if err != nil {
		return Download{}, err
	}
	return Download{URL: url, Name: f.OriginalName}, nil
}

// RemoveBySubmission сносит объекты ответа и их строки. Зовётся ДО удаления самого
// ответа: каскад унёс бы строки вместе с ключами, и объекты остались бы в бакете
// навсегда.
func (s *Service) RemoveBySubmission(ctx context.Context, submissionID uuid.UUID) error {
	files, err := s.repo.BySubmissions(ctx, s.db, []uuid.UUID{submissionID})
	if err != nil {
		return err
	}
	return s.remove(ctx, files)
}

// InfoBySubmissions — имена и размеры файлов перечисленных ответов (id → файл).
// Одним запросом на всю страницу таблицы: по одному на ответ дало бы тридцать
// поездок за тридцатью строками.
func (s *Service) InfoBySubmissions(ctx context.Context, submissionIDs []uuid.UUID) (map[string]domain.AnswerFile, error) {
	files, err := s.repo.BySubmissions(ctx, s.db, submissionIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[string]domain.AnswerFile, len(files))
	for _, f := range files {
		out[f.ID.String()] = domain.AnswerFile{Name: f.OriginalName, Size: f.SizeBytes}
	}
	return out, nil
}

// InfoByForm — имена и размеры ВСЕХ файлов формы (id → файл), для выгрузки.
// Одним запросом: построчный дал бы поездку на каждый ответ, а объём результата
// ограничен квотой хранилища пространства.
func (s *Service) InfoByForm(ctx context.Context, formID uuid.UUID) (map[string]domain.AnswerFile, error) {
	files, err := s.repo.ByForm(ctx, s.db, formID)
	if err != nil {
		return nil, err
	}
	out := make(map[string]domain.AnswerFile, len(files))
	for _, f := range files {
		out[f.ID.String()] = domain.AnswerFile{Name: f.OriginalName, Size: f.SizeBytes}
	}
	return out, nil
}

// CleanupOrphans сносит незаявленные загрузки старше TTL: слот выдали, ответ не
// пришёл. Возвращает число снесённых — его пишет в лог фоновая задача.
func (s *Service) CleanupOrphans(ctx context.Context, now time.Time) (int, error) {
	files, err := s.repo.Orphans(ctx, s.db, now.Add(-OrphanTTL), orphanBatch)
	if err != nil {
		return 0, err
	}
	if err := s.remove(ctx, files); err != nil {
		return 0, err
	}
	return len(files), nil
}

// remove — общий порядок уборки: сначала объекты, потом строки. Отсутствие объекта
// в бакете ошибкой не считается (его мог снести прошлый, оборвавшийся проход) —
// иначе одна такая строка блокировала бы чистку вечно.
func (s *Service) remove(ctx context.Context, files []File) error {
	if len(files) == 0 {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(files))
	for _, f := range files {
		if err := s.bucket.Remove(ctx, f.ObjectKey); err != nil && !errors.Is(err, blob.ErrNotFound) {
			return fmt.Errorf("remove object %s: %w", f.ObjectKey, err)
		}
		ids = append(ids, f.ID)
	}
	return s.repo.Delete(ctx, s.db, ids)
}
