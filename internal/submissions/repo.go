package submissions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/domain"
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
	// FormTitle — название формы на момент чтения. Нужно телу вебхука; у путей,
	// которым оно не нужно, остаётся пустым не по случайности, а потому что его
	// заполняет только запрос доставки.
	FormTitle string
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
func (Repo) ListSubmissions(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32, period domain.Period) ([]Submission, error) {
	from, to := postgres.PeriodBounds(period)
	rows, err := postgres.New(db).ListSubmissionsFirstPage(ctx, postgres.ListSubmissionsFirstPageParams{
		FormID: formID,
		Limit:  limit,
		FromTs: from,
		ToTs:   to,
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

// SubmissionByID — один ответ формы. form_id в условии обязателен: id приезжает из
// адреса и правом доступа не является (тот же довод, что у удаления).
func (Repo) SubmissionByID(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (Submission, error) {
	row, err := postgres.New(db).GetSubmissionForForm(ctx, postgres.GetSubmissionForFormParams{
		ID:     id,
		FormID: formID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Submission{}, domain.ErrNotFound
		}
		return Submission{}, fmt.Errorf("get submission %s: %w", id, err)
	}
	return Submission{
		ID:          row.ID,
		FormVersion: row.FormVersion,
		Answers:     json.RawMessage(row.Answers),
		CreatedAt:   row.CreatedAt.Time,
	}, nil
}

// ListSubmissionsAfter — следующая страница одноколоночным курсором (id).
func (Repo) ListSubmissionsAfter(ctx context.Context, db postgres.DBTX, formID, cursorID uuid.UUID, limit int32, period domain.Period) ([]Submission, error) {
	from, to := postgres.PeriodBounds(period)
	rows, err := postgres.New(db).ListSubmissionsAfter(ctx, postgres.ListSubmissionsAfterParams{
		FormID:   formID,
		CursorID: cursorID,
		Limit:    limit,
		FromTs:   from,
		ToTs:     to,
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

// GetForDelivery — один ответ формы для фоновой доставки во внешнюю таблицу.
// pgx.ErrNoRows означает «доставлять нечего»: ответ удалён автором либо скрыт
// тарифом (over_quota). Оба случая штатны и разбираются вызывающим.
func (Repo) GetForDelivery(ctx context.Context, db postgres.DBTX, formID, id uuid.UUID) (Submission, error) {
	row, err := postgres.New(db).GetSubmissionForDelivery(ctx, postgres.GetSubmissionForDeliveryParams{
		ID:     id,
		FormID: formID,
	})
	if err != nil {
		return Submission{}, err
	}
	return Submission{
		ID:          row.ID,
		FormVersion: row.FormVersion,
		Answers:     json.RawMessage(row.Answers),
		CreatedAt:   row.CreatedAt.Time,
		FormTitle:   row.FormTitle,
	}, nil
}

// PrintRow — ответ вместе со снапшотом схемы своей версии: то, из чего рисуется
// печатная страница. Схема здесь СЫРАЯ (json.RawMessage), а не разобранная в
// domain.FormSchema: рисует форму фронт по тому же контракту, что и рендерер
// публичной страницы, и промежуточный разбор в Go только добавил бы место, где
// печать может разойтись с формой.
type PrintRow struct {
	Submission
	Schema json.RawMessage
}

// GetForPrint — один ответ формы вместе со схемой его версии (печать PDF).
// pgx.ErrNoRows означает «печатать нечего»: ответа нет, он чужой формы или скрыт
// тарифом. Вызывающий превращает это в 404 — существование чужого ответа наружу
// не подтверждается.
func (Repo) GetForPrint(ctx context.Context, db postgres.DBTX, formID, id uuid.UUID) (PrintRow, error) {
	row, err := postgres.New(db).GetSubmissionForPrint(ctx, postgres.GetSubmissionForPrintParams{
		ID:     id,
		FormID: formID,
	})
	if err != nil {
		return PrintRow{}, err
	}
	return PrintRow{
		Submission: Submission{
			ID:          row.ID,
			FormVersion: row.FormVersion,
			Answers:     json.RawMessage(row.Answers),
			CreatedAt:   row.CreatedAt.Time,
		},
		Schema: json.RawMessage(row.FormSchema),
	}, nil
}

// ListForDelivery — названные ответы формы для доставки во внешнюю таблицу.
// Порядок задаёт очередь связки, а не эта выборка: вернувшиеся строки
// раскладывает по своему списку доставщик.
func (Repo) ListForDelivery(ctx context.Context, db postgres.DBTX, formID uuid.UUID, ids []uuid.UUID) ([]Submission, error) {
	rows, err := postgres.New(db).ListSubmissionsForDelivery(ctx, postgres.ListSubmissionsForDeliveryParams{
		FormID: formID,
		Ids:    ids,
	})
	if err != nil {
		return nil, fmt.Errorf("list submissions for delivery: %w", err)
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

// CountInPeriod — сколько ВИДИМЫХ ответов пришло за окно наблюдения (карточка
// «Ответы» над вкладками Insights). Сверхлимитные не считаются — так же, как их
// не показывает таблица ответов.
func (Repo) CountInPeriod(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) (int64, error) {
	from, to := postgres.PeriodBounds(period)
	n, err := postgres.New(db).CountSubmissionsInPeriod(ctx, postgres.CountSubmissionsInPeriodParams{
		FormID: formID,
		FromTs: from,
		ToTs:   to,
	})
	if err != nil {
		return 0, fmt.Errorf("count submissions in period: %w", err)
	}
	return n, nil
}

// Partial — черновик ответа в проекции кабинета: id визита, набранное, докуда
// дошёл человек и время последней правки.
type Partial struct {
	VisitID     uuid.UUID
	FormVersion int32
	Answers     json.RawMessage
	LastBlockID string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// UpsertPartial сохраняет черновик визита. Повторное автосохранение перезаписывает
// содержимое той же строки — черновик это состояние, а не событие.
func (Repo) UpsertPartial(ctx context.Context, db postgres.DBTX, visitID, formID, versionID uuid.UUID, answers json.RawMessage, lastBlockID *string) error {
	block := pgtype.Text{}
	if lastBlockID != nil {
		block = pgtype.Text{String: *lastBlockID, Valid: true}
	}
	err := postgres.New(db).UpsertPartialSubmission(ctx, postgres.UpsertPartialSubmissionParams{
		VisitID:       visitID,
		FormID:        formID,
		FormVersionID: versionID,
		Answers:       answers,
		LastBlockID:   block,
	})
	if err != nil {
		return fmt.Errorf("upsert partial submission: %w", err)
	}
	return nil
}

// DeletePartialByVisit убирает черновик, ставший ответом. 0 строк — штатный исход.
func (Repo) DeletePartialByVisit(ctx context.Context, db postgres.DBTX, visitID, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeletePartialByVisit(ctx, postgres.DeletePartialByVisitParams{
		VisitID: visitID,
		FormID:  formID,
	})
	if err != nil {
		return 0, fmt.Errorf("delete partial by visit: %w", err)
	}
	return n, nil
}

// ListPartials — страница черновиков формы, новыми сверху. after nil = первая.
func (Repo) ListPartials(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32, after *TimeCursor) ([]Partial, error) {
	var (
		rows []postgres.ListPartialsFirstPageRow
		err  error
	)
	if after == nil {
		rows, err = postgres.New(db).ListPartialsFirstPage(ctx, postgres.ListPartialsFirstPageParams{
			FormID: formID,
			Limit:  limit,
		})
	} else {
		var next []postgres.ListPartialsAfterRow
		next, err = postgres.New(db).ListPartialsAfter(ctx, postgres.ListPartialsAfterParams{
			FormID:   formID,
			CursorAt: pgtype.Timestamptz{Time: after.At, Valid: true},
			CursorID: after.ID,
			Limit:    limit,
		})
		rows = make([]postgres.ListPartialsFirstPageRow, len(next))
		for i, r := range next {
			rows[i] = postgres.ListPartialsFirstPageRow(r)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("list partials: %w", err)
	}
	out := make([]Partial, len(rows))
	for i, r := range rows {
		out[i] = Partial{
			VisitID:     r.VisitID,
			FormVersion: r.FormVersion,
			Answers:     json.RawMessage(r.Answers),
			LastBlockID: r.LastBlockID.String,
			CreatedAt:   r.CreatedAt.Time,
			UpdatedAt:   r.UpdatedAt.Time,
		}
	}
	return out, nil
}

// FeedRow — строка объединённой ленты «Все ответы»: отправленный ответ или
// незавершённый, различает их Kind. At — время, по которому лента отсортирована:
// у ответа отправка, у черновика последняя правка (queries.sql объясняет, почему
// не created_at у обоих).
type FeedRow struct {
	Kind        string
	ID          uuid.UUID
	At          time.Time
	CreatedAt   time.Time
	LastBlockID string
	Answers     json.RawMessage
	FormVersion int32
}

// ListFeed — страница объединённой ленты, новыми сверху. after nil = первая.
func (Repo) ListFeed(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32, after *TimeCursor) ([]FeedRow, error) {
	var (
		rows []postgres.ListFeedFirstPageRow
		err  error
	)
	if after == nil {
		rows, err = postgres.New(db).ListFeedFirstPage(ctx, postgres.ListFeedFirstPageParams{
			FormID:   formID,
			RowLimit: limit,
		})
	} else {
		var next []postgres.ListFeedAfterRow
		next, err = postgres.New(db).ListFeedAfter(ctx, postgres.ListFeedAfterParams{
			FormID:   formID,
			CursorAt: pgtype.Timestamptz{Time: after.At, Valid: true},
			CursorID: after.ID,
			RowLimit: limit,
		})
		rows = make([]postgres.ListFeedFirstPageRow, len(next))
		for i, r := range next {
			rows[i] = postgres.ListFeedFirstPageRow(r)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("list feed: %w", err)
	}
	out := make([]FeedRow, len(rows))
	for i, r := range rows {
		out[i] = FeedRow{
			Kind:        r.Kind,
			ID:          r.RowID,
			At:          r.At.Time,
			CreatedAt:   r.StartedAt.Time,
			LastBlockID: r.LastBlockID.String,
			Answers:     json.RawMessage(r.Answers),
			FormVersion: r.FormVersion,
		}
	}
	return out, nil
}

// CountPartials — сколько черновиков у формы. Показывается и под замком тарифа.
func (Repo) CountPartials(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).CountPartials(ctx, formID)
	if err != nil {
		return 0, fmt.Errorf("count partials: %w", err)
	}
	return n, nil
}

// DeletePartial — удаление одного черновика владельцем.
func (Repo) DeletePartial(ctx context.Context, db postgres.DBTX, visitID, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeletePartialSubmission(ctx, postgres.DeletePartialSubmissionParams{
		VisitID: visitID,
		FormID:  formID,
	})
	if err != nil {
		return 0, fmt.Errorf("delete partial: %w", err)
	}
	return n, nil
}

// DeleteOldPartials — чистка по возрасту (периодическая задача).
func (Repo) DeleteOldPartials(ctx context.Context, db postgres.DBTX, before time.Time) (int64, error) {
	n, err := postgres.New(db).DeleteOldPartials(ctx, pgtype.Timestamptz{Time: before, Valid: true})
	if err != nil {
		return 0, fmt.Errorf("delete old partials: %w", err)
	}
	return n, nil
}

// TimeCursor — составной курсор «время + id последней показанной строки». Нужен
// там, где монотонного id (как у иммутабельных ответов) мало: черновик МЕНЯЕТСЯ,
// пока человек печатает, а объединённая лента склеивает два множества с разными
// id вовсе. Общий на листинг черновиков и на ленту «Все ответы» — курсор у них
// одинаков и по смыслу, и по кодировке.
type TimeCursor struct {
	At time.Time
	ID uuid.UUID
}
