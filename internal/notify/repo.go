package notify

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/postgres"
)

// Insertion — постановка одного повода сразу всем адресатам: массив id строк и
// массив получателей идут парами. IDs и Users обязаны быть одной длины (их
// собирает Service.Notify).
type Insertion struct {
	IDs         []uuid.UUID
	Users       []uuid.UUID
	WorkspaceID uuid.UUID
	Kind        string
	// FormID — uuid.Nil у поводов пространства (квота): в колонке тогда NULL.
	FormID    uuid.UUID
	SubjectID uuid.UUID
	Payload   []byte
}

// Stored — строка ленты как она лежит в БД, до рендера текста и ссылки.
type Stored struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	WorkspaceName string
	WorkspaceSlug string
	Kind          string
	SubjectID     uuid.UUID
	Payload       []byte
	Count         int32
	FirstAt       time.Time
	LastAt        time.Time
	// ReadAt — нулевое время означает «непрочитано».
	ReadAt time.Time
}

// Repo — доступ к данным уведомлений поверх sqlc. Методы принимают исполнителя
// (postgres.DBTX): постановка идёт на исполнителе вызывающего, чтение — на пуле.
type Repo struct{}

// Insert ставит повод адресатам; повтор непрочитанного склеивается (ON CONFLICT
// в запросе).
func (Repo) Insert(ctx context.Context, db postgres.DBTX, in Insertion) error {
	err := postgres.New(db).InsertNotifications(ctx, postgres.InsertNotificationsParams{
		Ids:         in.IDs,
		Users:       in.Users,
		WorkspaceID: in.WorkspaceID,
		Kind:        in.Kind,
		FormID:      pgtype.UUID{Bytes: in.FormID, Valid: in.FormID != uuid.Nil},
		SubjectID:   in.SubjectID,
		Payload:     in.Payload,
	})
	if err != nil {
		return fmt.Errorf("insert notifications (%s): %w", in.Kind, err)
	}
	return nil
}

// ClearUnread гасит непрочитанные строки повода о субъекте (отбой).
func (Repo) ClearUnread(ctx context.Context, db postgres.DBTX, kind string, subjectID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).ClearUnreadNotifications(ctx, postgres.ClearUnreadNotificationsParams{
		Kind:      kind,
		SubjectID: subjectID,
	})
	if err != nil {
		return 0, fmt.Errorf("clear unread notifications (%s): %w", kind, err)
	}
	return n, nil
}

// List — страница ленты пользователя: до limit строк, новые сверху; cursor
// uuid.Nil означает первую страницу.
func (Repo) List(ctx context.Context, db postgres.DBTX, userID, cursor uuid.UUID, limit int32) ([]Stored, error) {
	rows, err := postgres.New(db).ListNotifications(ctx, postgres.ListNotificationsParams{
		UserID: userID,
		Cursor: pgtype.UUID{Bytes: cursor, Valid: cursor != uuid.Nil},
		Lim:    limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list notifications of %s: %w", userID, err)
	}
	out := make([]Stored, len(rows))
	for i, r := range rows {
		out[i] = Stored{
			ID: r.ID, WorkspaceID: r.WorkspaceID,
			WorkspaceName: r.WorkspaceName, WorkspaceSlug: r.WorkspaceSlug,
			Kind: r.Kind, SubjectID: r.SubjectID, Payload: r.Payload, Count: r.Count,
			FirstAt: r.FirstAt.Time, LastAt: r.LastAt.Time, ReadAt: r.ReadAt.Time,
		}
	}
	return out, nil
}

// CountUnread — число непрочитанных у пользователя (число на колокольчике).
func (Repo) CountUnread(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).CountUnreadNotifications(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("count unread notifications of %s: %w", userID, err)
	}
	return n, nil
}

// MarkRead отмечает прочитанными названные строки пользователя.
func (Repo) MarkRead(ctx context.Context, db postgres.DBTX, userID uuid.UUID, ids []uuid.UUID) (int64, error) {
	n, err := postgres.New(db).MarkNotificationsRead(ctx, postgres.MarkNotificationsReadParams{
		UserID: userID,
		Ids:    ids,
	})
	if err != nil {
		return 0, fmt.Errorf("mark notifications read of %s: %w", userID, err)
	}
	return n, nil
}

// MarkAllRead отмечает прочитанными все непрочитанные строки пользователя.
func (Repo) MarkAllRead(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).MarkAllNotificationsRead(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("mark all notifications read of %s: %w", userID, err)
	}
	return n, nil
}

// Delete убирает одну строку ленты. Чужая строка не находится — отбор идёт по
// владельцу.
func (Repo) Delete(ctx context.Context, db postgres.DBTX, userID, id uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteNotification(ctx, postgres.DeleteNotificationParams{
		ID:     id,
		UserID: userID,
	})
	if err != nil {
		return 0, fmt.Errorf("delete notification %s: %w", id, err)
	}
	return n, nil
}

// DeleteAll убирает всю ленту человека, включая непрочитанное.
func (Repo) DeleteAll(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteAllNotifications(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("delete all notifications of %s: %w", userID, err)
	}
	return n, nil
}

// Purge уносит прочитанные старше readBefore и непрочитанные старше unreadBefore.
func (Repo) Purge(ctx context.Context, db postgres.DBTX, readBefore, unreadBefore time.Time) (int64, error) {
	n, err := postgres.New(db).PurgeNotifications(ctx, postgres.PurgeNotificationsParams{
		ReadBefore:   pgtype.Timestamptz{Time: readBefore, Valid: true},
		UnreadBefore: pgtype.Timestamptz{Time: unreadBefore, Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("purge notifications: %w", err)
	}
	return n, nil
}
