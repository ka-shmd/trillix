package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Access — права в пространстве глазами этого модуля (internal/workspaces).
//
// Спрашивается не «можно ли ЭТОМУ», а «КОМУ можно»: адресатов у повода столько,
// сколько участников с нужным действием, и спрашивать про каждого отдельно
// значило бы превратить число участников в число запросов прямо на пути приёма
// ответа. Заморозка пространства здесь не спрашивается по тому же доводу, что у
// workspaces.IsMember: постановка уведомления — фоновое продолжение публичного
// приёма, а не операция в кабинете; открыть форму замороженный участник всё
// равно не сможет, и отказ он увидит там, где о нём есть что сказать.
type Access interface {
	Recipients(ctx context.Context, workspaceID uuid.UUID, action domain.Action) ([]uuid.UUID, error)
}

// Store — доступ к данным, объявленный потребителем. Реализация — Repo.
type Store interface {
	Insert(ctx context.Context, db postgres.DBTX, in Insertion) error
	ClearUnread(ctx context.Context, db postgres.DBTX, kind string, subjectID uuid.UUID) (int64, error)
	List(ctx context.Context, db postgres.DBTX, userID, cursor uuid.UUID, limit int32) ([]Stored, error)
	CountUnread(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (int64, error)
	MarkRead(ctx context.Context, db postgres.DBTX, userID uuid.UUID, ids []uuid.UUID) (int64, error)
	MarkAllRead(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (int64, error)
	MarkReadBySubject(ctx context.Context, db postgres.DBTX, userID uuid.UUID, kind string, subjectID uuid.UUID) (int64, error)
	Purge(ctx context.Context, db postgres.DBTX, readBefore, unreadBefore time.Time) (int64, error)
}

var _ Store = Repo{}

// Сроки жизни строки. Прочитанное живёт меньше: оно уже сделало свою работу, а
// непрочитанное ещё может пригодиться человеку, который месяц не заходил.
const (
	ReadRetention   = 30 * 24 * time.Hour
	UnreadRetention = 90 * 24 * time.Hour
)

// MaxPageSize — потолок страницы ленты. Шторка показывает десятки строк, а не
// тысячи; отдать всё разом означало бы читать ленту, которую никто не листает.
const MaxPageSize = 50

// Event — повод, случившийся в пространстве. Адресатов у него нет: их называет
// реестр (действие) и считает Access.
type Event struct {
	WorkspaceID uuid.UUID
	Kind        Kind
	// FormID — форма, к которой относится повод; uuid.Nil у поводов пространства.
	// Она же даёт строке каскад: удалённая форма уносит свои уведомления сама.
	FormID uuid.UUID
	// SubjectID — субъект повода: форма, цель доставки или пространство. По нему
	// склеивается повтор (коалесинг) и по нему же бьёт отбой.
	SubjectID uuid.UUID
	Payload   Payload
}

// Item — строка ленты, готовая к показу: текст и ссылку собрал реестр.
type Item struct {
	ID            uuid.UUID
	WorkspaceID   uuid.UUID
	WorkspaceName string
	WorkspaceSlug string
	Kind          Kind
	Text          string
	Link          string
	Count         int32
	FirstAt       time.Time
	LastAt        time.Time
	Read          bool
}

// Page — страница ленты вместе со счётчиком непрочитанных (число на колокольчике
// нужно тому же экрану, что и сама лента).
type Page struct {
	Items  []Item
	Unread int64
	// NextCursor — uuid.Nil означает, что страница последняя.
	NextCursor uuid.UUID
}

// Service — постановка, отбой и чтение уведомлений.
type Service struct {
	db     postgres.DBTX
	repo   Store
	access Access
	now    func() time.Time
}

func NewService(db postgres.DBTX, repo Store, access Access) *Service {
	return &Service{db: db, repo: repo, access: access, now: time.Now}
}

// WithClock подменяет часы сервиса (тесты).
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

// Notify ставит повод всем, кому он адресован.
//
// db — исполнитель вызывающего (пул или его транзакция), как у постановки письма
// в outbox. Продюсеры зовут Notify ПОСЛЕ коммита своего изменения и best-effort:
// уведомление — вторичный эффект, и уронить из-за него принятый ответ нельзя
// (ADR §10). Ошибку возвращаем, логирует её вызывающий — он знает, что за
// событие потерялось.
//
// Отсутствие адресатов — штатный исход, а не ошибка: у повода про тариф в
// командном пространстве адресат один (владелец), а бывают и нулевые.
func (s *Service) Notify(ctx context.Context, db postgres.DBTX, ev Event) error {
	sp, ok := registry[ev.Kind]
	if !ok {
		return fmt.Errorf("notify: неизвестный повод %q", ev.Kind)
	}
	users, err := s.access.Recipients(ctx, ev.WorkspaceID, sp.action)
	if err != nil {
		return fmt.Errorf("notify recipients of %s: %w", ev.WorkspaceID, err)
	}
	if len(users) == 0 {
		return nil
	}
	payload, err := json.Marshal(ev.Payload)
	if err != nil {
		return fmt.Errorf("notify payload (%s): %w", ev.Kind, err)
	}
	// Id на строку генерит приложение (UUIDv7): в запросе gen_random_uuid() дал
	// бы v4, нелокальность которого бьёт по индексам (ADR §10).
	ids := make([]uuid.UUID, len(users))
	for i := range ids {
		ids[i] = domain.NewID()
	}
	return s.repo.Insert(ctx, db, Insertion{
		IDs:         ids,
		Users:       users,
		WorkspaceID: ev.WorkspaceID,
		Kind:        string(ev.Kind),
		FormID:      ev.FormID,
		SubjectID:   ev.SubjectID,
		Payload:     payload,
	})
}

// Clear — отбой: препятствие устранено, и непрочитанные строки о нём гаснут у
// всех адресатов разом. Прочитанные остаются историей: они честно описывают, что
// тогда было.
//
// Зовётся там же, где снимается поломка, и там же, где цель удаляется. Повод, не
// объявленный препятствием, отбоя не имеет вовсе — попытка его погасить это
// ошибка вызывающего, а не тихий no-op: у счётчика («новые ответы») отбой один,
// и это прочтение.
func (s *Service) Clear(ctx context.Context, db postgres.DBTX, kind Kind, subjectID uuid.UUID) error {
	sp, ok := registry[kind]
	if !ok {
		return fmt.Errorf("notify: неизвестный повод %q", kind)
	}
	if !sp.obstacle {
		return fmt.Errorf("notify: у повода %q нет отбоя — он гаснет прочтением", kind)
	}
	if _, err := s.repo.ClearUnread(ctx, db, string(kind), subjectID); err != nil {
		return err
	}
	return nil
}

// Feed — страница ленты пользователя со счётчиком непрочитанных. cursor uuid.Nil
// означает первую страницу.
func (s *Service) Feed(ctx context.Context, userID, cursor uuid.UUID, limit int32) (Page, error) {
	if limit <= 0 || limit > MaxPageSize {
		limit = MaxPageSize
	}
	// limit+1: по «лишней» строке видно, есть ли следующая страница — тот же приём,
	// что у списка форм.
	rows, err := s.repo.List(ctx, s.db, userID, cursor, limit+1)
	if err != nil {
		return Page{}, err
	}
	page := Page{}
	if int32(len(rows)) > limit {
		page.NextCursor = rows[limit-1].ID
		rows = rows[:limit]
	}
	page.Items = make([]Item, 0, len(rows))
	for _, r := range rows {
		item, ok := render(ctx, r)
		if !ok {
			continue
		}
		page.Items = append(page.Items, item)
	}
	if page.Unread, err = s.repo.CountUnread(ctx, s.db, userID); err != nil {
		return Page{}, err
	}
	return page, nil
}

// render собирает строку ленты реестром. Повод, которого реестр не знает (откат
// версии, строка из будущего), лента ПРОПУСКАЕТ: уведомление без текста хуже
// отсутствующего, а падать из-за него незачем — остальные строки человеку нужны.
func render(ctx context.Context, r Stored) (Item, bool) {
	sp, ok := registry[Kind(r.Kind)]
	if !ok {
		httpserver.LoggerFrom(ctx).Warn("notification kind not in registry",
			slog.String("kind", r.Kind), slog.String("notification_id", r.ID.String()))
		return Item{}, false
	}
	var p Payload
	if err := json.Unmarshal(r.Payload, &p); err != nil {
		httpserver.LoggerFrom(ctx).Warn("notification payload not parsed",
			slog.String("kind", r.Kind), slog.String("notification_id", r.ID.String()),
			slog.String("error", err.Error()))
		return Item{}, false
	}
	return Item{
		ID: r.ID, WorkspaceID: r.WorkspaceID,
		WorkspaceName: r.WorkspaceName, WorkspaceSlug: r.WorkspaceSlug,
		Kind:    Kind(r.Kind),
		Text:    sp.text(p, r.Count),
		Link:    sp.link(p, r.WorkspaceSlug),
		Count:   r.Count,
		FirstAt: r.FirstAt, LastAt: r.LastAt,
		Read: !r.ReadAt.IsZero(),
	}, true
}

// MarkRead отмечает прочитанными названные строки. Чужие строки не трогаются
// (отбор по user_id в запросе), поэтому проверять принадлежность отдельно не
// нужно: чужой id просто ничего не найдёт.
func (s *Service) MarkRead(ctx context.Context, userID uuid.UUID, ids []uuid.UUID) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.repo.MarkRead(ctx, s.db, userID, ids)
	return err
}

// MarkAllRead гасит всё непрочитанное пользователя.
func (s *Service) MarkAllRead(ctx context.Context, userID uuid.UUID) error {
	_, err := s.repo.MarkAllRead(ctx, s.db, userID)
	return err
}

// MarkReadBySubject гасит повод о субъекте: человек открыл экран, куда звал повод.
func (s *Service) MarkReadBySubject(ctx context.Context, userID uuid.UUID, kind Kind, subjectID uuid.UUID) error {
	if _, ok := registry[kind]; !ok {
		return fmt.Errorf("notify: неизвестный повод %q", kind)
	}
	_, err := s.repo.MarkReadBySubject(ctx, s.db, userID, string(kind), subjectID)
	return err
}

// Cleanup уносит состарившиеся строки; гоняется periodic-задачей. Возвращает
// число убранных — его пишет в лог вызывающий.
func (s *Service) Cleanup(ctx context.Context) (int64, error) {
	now := s.now()
	return s.repo.Purge(ctx, s.db, now.Add(-ReadRetention), now.Add(-UnreadRetention))
}
