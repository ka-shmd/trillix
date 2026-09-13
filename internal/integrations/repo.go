package integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Connection — подключённый аккаунт, как он лежит у нас.
//
// RefreshSealed — ШИФРОТЕКСТ и остаётся им везде выше repo: расшифровка живёт в
// одном месте (Service.accessToken), и ни один DTO транспорта этого поля не
// содержит. Мина: добавите его в ответ API — отдадите наружу ключ от чужого Диска.
//
// UserID — чьё подключение. С 0037 это ОДИН факт в трёх ролях: ключ владения
// (аккаунтов у человека сколько угодно), запись аудита «чьим согласием ответы
// уезжают наружу» (152-ФЗ) и правило «ушёл человек — ушло подключение»
// (FK ON DELETE CASCADE на users). Пространства аккаунт не знает вовсе.
type Connection struct {
	ID            uuid.UUID
	UserID        uuid.UUID
	Provider      string
	ExternalID    string
	Email         string
	RefreshSealed []byte
	Scopes        string
	ConnectedAt   time.Time
	// AccessLostAt — момент, когда провайдер отказал в обновлении токена
	// (`ErrAccessLost`, 0061). Нулевое время = согласие действует либо мы ещё не
	// знаем: узнать это можно только походом к провайдеру, то есть при доставке.
	AccessLostAt time.Time
}

// NewConnection — что нужно записать при подключении.
type NewConnection struct {
	ID            uuid.UUID
	UserID        uuid.UUID
	Provider      string
	ExternalID    string
	Email         string
	RefreshSealed []byte
	Scopes        string
}

// Repo — доступ к данным интеграций поверх sqlc. Методы принимают исполнителя
// (пул или транзакция) и логики не содержат.
type Repo struct{}

// Upsert подключает аккаунт и отдаёт id ПЕРЕЖИВШЕЙ строки.
//
// Мина: при повторном заходе тем же аккаунтом Google выживает старая строка, и
// её id отличается от c.ID. Вернёте свой — отдадите экрану аккаунт, которого в
// базе нет, и следующий же выбор в селекте упрётся в 404.
func (Repo) Upsert(ctx context.Context, db postgres.DBTX, c NewConnection) (uuid.UUID, error) {
	id, err := postgres.New(db).UpsertIntegrationAccount(ctx, postgres.UpsertIntegrationAccountParams{
		ID:                c.ID,
		UserID:            c.UserID,
		Provider:          c.Provider,
		ExternalAccountID: c.ExternalID,
		ExternalEmail:     c.Email,
		RefreshToken:      c.RefreshSealed,
		Scopes:            c.Scopes,
	})
	if err != nil {
		return uuid.Nil, fmt.Errorf("upsert integration account: %w", err)
	}
	return id, nil
}

// ListByUser — аккаунты человека у провайдера. Пустой список — штатное
// состояние экрана, а не ошибка: до первого подключения он именно такой.
func (Repo) ListByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID, provider string) ([]Connection, error) {
	rows, err := postgres.New(db).ListIntegrationAccountsByUser(ctx, postgres.ListIntegrationAccountsByUserParams{
		UserID:   userID,
		Provider: provider,
	})
	if err != nil {
		return nil, fmt.Errorf("list integration accounts: %w", err)
	}
	out := make([]Connection, 0, len(rows))
	for _, row := range rows {
		out = append(out, Connection{
			ID:            row.ID,
			UserID:        row.UserID,
			Provider:      row.Provider,
			ExternalID:    row.ExternalAccountID,
			Email:         row.ExternalEmail,
			RefreshSealed: row.RefreshToken,
			Scopes:        row.Scopes,
			ConnectedAt:   row.ConnectedAt.Time,
			AccessLostAt:  row.AccessLostAt.Time,
		})
	}
	return out, nil
}

// UpdateToken перезаписывает шифротекст refresh-токена подключения.
func (Repo) UpdateToken(ctx context.Context, db postgres.DBTX, id uuid.UUID, sealed []byte) error {
	err := postgres.New(db).UpdateIntegrationAccountToken(ctx, postgres.UpdateIntegrationAccountTokenParams{
		ID:           id,
		RefreshToken: sealed,
	})
	if err != nil {
		return fmt.Errorf("update integration token: %w", err)
	}
	return nil
}

// Delete удаляет ОДИН аккаунт человека и отдаёт шифротекст токена — на отзыв у
// провайдера. userID в условии обязателен: id приезжает из адреса и правом
// доступа не является (инвариант 1).
func (Repo) Delete(ctx context.Context, db postgres.DBTX, id, userID uuid.UUID) ([]byte, error) {
	sealed, err := postgres.New(db).DeleteIntegrationAccount(ctx, postgres.DeleteIntegrationAccountParams{
		ID:     id,
		UserID: userID,
	})
	if err != nil {
		return nil, err
	}
	return sealed, nil
}

// MarkAccessLost помечает подключение мёртвым: провайдер отказал в обновлении
// токена. Первый момент отказа не перезаписывается (условие в самом SQL).
func (Repo) MarkAccessLost(ctx context.Context, db postgres.DBTX, id uuid.UUID, at time.Time) error {
	err := postgres.New(db).MarkIntegrationAccountAccessLost(ctx, postgres.MarkIntegrationAccountAccessLostParams{
		ID:           id,
		AccessLostAt: pgtype.Timestamptz{Time: at, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("mark integration account access lost: %w", err)
	}
	return nil
}

// ClearAccessLost снимает пометку: по нашему refresh-токену снова выдан access.
func (Repo) ClearAccessLost(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).ClearIntegrationAccountAccessLost(ctx, id); err != nil {
		return fmt.Errorf("clear integration account access lost: %w", err)
	}
	return nil
}

// FormLink — привязка формы к таблице (с полями аккаунта, нужными экрану и
// доставке: за ними иначе пришлось бы ехать вторым запросом).
type FormLink struct {
	ID          uuid.UUID
	FormID      uuid.UUID
	AccountID   uuid.UUID
	WorkspaceID uuid.UUID
	// AccountUserID — чей аккаунт везёт эту связку. По нему сторож доставки
	// проверяет, что человек всё ещё участник пространства формы: аккаунт личный,
	// и уход из команды обязан останавливать поток ответов в его Диск (ADR §10).
	AccountUserID   uuid.UUID
	AccountEmail    string
	Name            string
	SpreadsheetID   string
	SpreadsheetURL  string
	SheetID         int32
	SheetTitle      string
	Columns         []domain.SheetColumn
	Enabled         bool
	Status          string
	LastError       string
	LastDeliveredAt time.Time
	// Queued — сколько ответов ждут доставки в эту связку. Экран показывает
	// «в очереди N» — им же виден идущий перенос накопленных.
	Queued int64

	// Дальше — то, что нужно ДОСТАВЩИКУ и не нужно экрану; у чтений для таба
	// эти поля пусты.
	//
	// FailingSince — с какого момента связка подряд не принимает. Сутки —
	// поломка; момент ПЕРВОГО отказа, а не последнего, иначе отсчёт не наступит
	// никогда.
	FailingSince time.Time
	// ConsecutiveFailures — сколько неудач подряд: по нему считается бэкофф.
	ConsecutiveFailures int32
	NextAttemptAt       time.Time
	// FormName и FormSlug — как форма называется в кабинете и где лежит. Нужны
	// поводу о поломке: человек читает его в ленте, где формы названы так же, как
	// в списке форм.
	FormName string
	FormSlug string
}

// NewFormLink — что нужно записать при привязке.
type NewFormLink struct {
	ID             uuid.UUID
	FormID         uuid.UUID
	AccountID      uuid.UUID
	Name           string
	SpreadsheetID  string
	SpreadsheetURL string
	SheetID        int32
	SheetTitle     string
	Columns        []domain.SheetColumn
	Status         string
}

func (Repo) InsertLink(ctx context.Context, db postgres.DBTX, l NewFormLink) error {
	columns, err := json.Marshal(l.Columns)
	if err != nil {
		return fmt.Errorf("marshal columns: %w", err)
	}
	err = postgres.New(db).InsertFormIntegration(ctx, postgres.InsertFormIntegrationParams{
		ID:             l.ID,
		FormID:         l.FormID,
		AccountID:      l.AccountID,
		Name:           l.Name,
		SpreadsheetID:  l.SpreadsheetID,
		SpreadsheetUrl: l.SpreadsheetURL,
		SheetID:        l.SheetID,
		SheetTitle:     l.SheetTitle,
		Columns:        columns,
		Status:         l.Status,
	})
	if err != nil {
		return fmt.Errorf("insert form integration: %w", err)
	}
	return nil
}

// ListLinks — связки формы. Их сколько угодно: интеграция это правило доставки,
// а не состояние формы.
func (Repo) ListLinks(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]FormLink, error) {
	rows, err := postgres.New(db).ListFormIntegrations(ctx, formID)
	if err != nil {
		return nil, fmt.Errorf("list form integrations: %w", err)
	}
	out := make([]FormLink, 0, len(rows))
	for _, row := range rows {
		link, err := toFormLink(formIntegrationRow{
			ID: row.ID, FormID: row.FormID, AccountID: row.AccountID, WorkspaceID: row.WorkspaceID,
			UserID: row.UserID, ExternalEmail: row.ExternalEmail, Name: row.Name, Enabled: row.Enabled,
			SpreadsheetID: row.SpreadsheetID, SpreadsheetUrl: row.SpreadsheetUrl,
			SheetID: row.SheetID, SheetTitle: row.SheetTitle, Columns: row.Columns, Status: row.Status,
			LastError: row.LastError.String, LastDeliveredAt: row.LastDeliveredAt.Time,
			Queued: row.Queued,
		})
		if err != nil {
			return nil, err
		}
		out = append(out, link)
	}
	return out, nil
}

// DeleteLink удаляет ОДНУ связку формы. Ноль строк — связки нет либо она чужой
// формы; вызывающий разбирает это как 404, не различая случаи (инвариант 5).
func (Repo) DeleteLink(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteFormIntegration(ctx, postgres.DeleteFormIntegrationParams{
		ID:     id,
		FormID: formID,
	})
	if err != nil {
		return 0, fmt.Errorf("delete form integration: %w", err)
	}
	return n, nil
}

// UpdateLinkSettings правит подпись и тумблер связки.
func (Repo) UpdateLinkSettings(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, name string, enabled bool) (int64, error) {
	n, err := postgres.New(db).UpdateFormIntegrationSettings(ctx, postgres.UpdateFormIntegrationSettingsParams{
		ID:      id,
		FormID:  formID,
		Name:    name,
		Enabled: enabled,
	})
	if err != nil {
		return 0, fmt.Errorf("update form integration settings: %w", err)
	}
	return n, nil
}

func (Repo) GetLinkByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (FormLink, error) {
	row, err := postgres.New(db).GetFormIntegrationByID(ctx, id)
	if err != nil {
		return FormLink{}, err
	}
	return toFormLink(formIntegrationRow{
		ID: row.ID, FormID: row.FormID, AccountID: row.AccountID, WorkspaceID: row.WorkspaceID,
		UserID: row.UserID, ExternalEmail: row.ExternalEmail, Name: row.Name, Enabled: row.Enabled, SpreadsheetID: row.SpreadsheetID, SpreadsheetUrl: row.SpreadsheetUrl,
		SheetID: row.SheetID, SheetTitle: row.SheetTitle, Columns: row.Columns, Status: row.Status,
		LastError: row.LastError.String, LastDeliveredAt: row.LastDeliveredAt.Time,
		Queued: row.Queued,
	})
}

func (Repo) GetAccountByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Connection, error) {
	row, err := postgres.New(db).GetIntegrationAccountByID(ctx, id)
	if err != nil {
		return Connection{}, err
	}
	return Connection{
		ID:            row.ID,
		UserID:        row.UserID,
		Provider:      row.Provider,
		ExternalID:    row.ExternalAccountID,
		Email:         row.ExternalEmail,
		RefreshSealed: row.RefreshToken,
		Scopes:        row.Scopes,
		ConnectedAt:   row.ConnectedAt.Time,
		AccessLostAt:  row.AccessLostAt.Time,
	}, nil
}

func (Repo) UpdateLinkColumns(ctx context.Context, db postgres.DBTX, id uuid.UUID, columns []domain.SheetColumn) error {
	raw, err := json.Marshal(columns)
	if err != nil {
		return fmt.Errorf("marshal columns: %w", err)
	}
	if err := postgres.New(db).UpdateFormIntegrationColumns(ctx, postgres.UpdateFormIntegrationColumnsParams{
		ID:      id,
		Columns: raw,
	}); err != nil {
		return fmt.Errorf("update form integration columns: %w", err)
	}
	return nil
}

func (Repo) MarkDelivered(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).MarkFormIntegrationDelivered(ctx, id); err != nil {
		return fmt.Errorf("mark form integration delivered: %w", err)
	}
	return nil
}

// LinkIDsByAccount — связки аккаунта (нужны отбою поводов перед каскадом
// отключения).
func (Repo) LinkIDsByAccount(ctx context.Context, db postgres.DBTX, accountID uuid.UUID) ([]uuid.UUID, error) {
	ids, err := postgres.New(db).LinkIDsByAccount(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("link ids of account %s: %w", accountID, err)
	}
	return ids, nil
}

// ClearError возвращает связку в рабочее состояние: гасит причину и снимает
// broken. Времени доставки не ставит — её не было.
func (Repo) ClearError(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).ClearFormIntegrationError(ctx, id); err != nil {
		return fmt.Errorf("clear form integration error: %w", err)
	}
	return nil
}

func (Repo) MarkBroken(ctx context.Context, db postgres.DBTX, id uuid.UUID, cause string) error {
	err := postgres.New(db).MarkFormIntegrationBroken(ctx, postgres.MarkFormIntegrationBrokenParams{
		ID:        id,
		LastError: pgtype.Text{String: cause, Valid: cause != ""},
	})
	if err != nil {
		return fmt.Errorf("mark form integration broken: %w", err)
	}
	return nil
}

// formIntegrationRow — общий вид строки привязки для двух запросов (по форме и
// по id): sqlc генерирует им разные типы, а собирается FormLink из них одинаково.
type formIntegrationRow struct {
	ID, FormID, AccountID, WorkspaceID uuid.UUID
	UserID                             uuid.UUID
	ExternalEmail, Name                string
	Enabled                            bool
	SpreadsheetID, SpreadsheetUrl      string
	SheetID                            int32
	SheetTitle, Status, LastError      string
	Columns                            []byte
	LastDeliveredAt                    time.Time
	Queued                             int64
}

func toFormLink(row formIntegrationRow) (FormLink, error) {
	var columns []domain.SheetColumn
	if err := json.Unmarshal(row.Columns, &columns); err != nil {
		return FormLink{}, fmt.Errorf("unmarshal columns of form %s: %w", row.FormID, err)
	}
	return FormLink{
		ID:              row.ID,
		FormID:          row.FormID,
		AccountID:       row.AccountID,
		WorkspaceID:     row.WorkspaceID,
		AccountUserID:   row.UserID,
		AccountEmail:    row.ExternalEmail,
		Name:            row.Name,
		SpreadsheetID:   row.SpreadsheetID,
		SpreadsheetURL:  row.SpreadsheetUrl,
		SheetID:         row.SheetID,
		SheetTitle:      row.SheetTitle,
		Columns:         columns,
		Enabled:         row.Enabled,
		Status:          row.Status,
		LastError:       row.LastError,
		LastDeliveredAt: row.LastDeliveredAt,
		Queued:          row.Queued,
	}, nil
}

// MarkFailed усыпляет СВЯЗКУ до next: лежащий лист получает одну попытку за окно
// бэкоффа, сколько бы ответов ни ждало в очереди.
func (Repo) MarkFailed(ctx context.Context, db postgres.DBTX, id uuid.UUID, cause string, failingSince, next time.Time) error {
	err := postgres.New(db).MarkFormIntegrationFailed(ctx, postgres.MarkFormIntegrationFailedParams{
		ID:            id,
		LastError:     pgtype.Text{String: cause, Valid: cause != ""},
		FailingSince:  pgtype.Timestamptz{Time: failingSince, Valid: true},
		NextAttemptAt: pgtype.Timestamptz{Time: next, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("mark form integration failed: %w", err)
	}
	return nil
}

// DueLinks — связки, которым есть что везти и чьё время наступило.
func (Repo) DueLinks(ctx context.Context, db postgres.DBTX, limit int32) ([]FormLink, error) {
	rows, err := postgres.New(db).DueSheetLinks(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("due sheet links: %w", err)
	}
	out := make([]FormLink, 0, len(rows))
	for _, row := range rows {
		link, err := toFormLink(formIntegrationRow{
			ID: row.ID, FormID: row.FormID, AccountID: row.AccountID, WorkspaceID: row.WorkspaceID,
			UserID: row.UserID, ExternalEmail: row.ExternalEmail, Name: row.Name, Enabled: row.Enabled,
			SpreadsheetID: row.SpreadsheetID, SpreadsheetUrl: row.SpreadsheetUrl,
			SheetID: row.SheetID, SheetTitle: row.SheetTitle, Columns: row.Columns, Status: row.Status,
			LastError: row.LastError.String, LastDeliveredAt: row.LastDeliveredAt.Time,
		})
		if err != nil {
			return nil, err
		}
		link.FailingSince = row.FailingSince.Time
		link.ConsecutiveFailures = row.ConsecutiveFailures
		link.NextAttemptAt = row.NextAttemptAt.Time
		link.FormName, link.FormSlug = row.FormName, row.FormSlug
		out = append(out, link)
	}
	return out, nil
}

// QueuedSheetRow — строка очереди: что везти, приехала ли она переносом и когда
// встала. EnqueuedAt — метка версии: по ней доставщик снимает ТУ ЖЕ строку, что
// читал, а не её тёзку, поставленную перезаливом, пока он ходил в Google.
type QueuedSheetRow struct {
	SubmissionID uuid.UUID
	Backfill     bool
	EnqueuedAt   time.Time
}

// PendingSheetSubmissions — что связка везёт следующим, в порядке постановки.
func (Repo) PendingSheetSubmissions(ctx context.Context, db postgres.DBTX, linkID uuid.UUID, limit int32) ([]QueuedSheetRow, error) {
	rows, err := postgres.New(db).PendingSheetSubmissions(ctx, postgres.PendingSheetSubmissionsParams{
		LinkID: linkID,
		Limit:  limit,
	})
	if err != nil {
		return nil, fmt.Errorf("pending sheet submissions: %w", err)
	}
	out := make([]QueuedSheetRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, QueuedSheetRow{
			SubmissionID: row.SubmissionID,
			Backfill:     row.Backfill,
			EnqueuedAt:   row.EnqueuedAt.Time,
		})
	}
	return out, nil
}

// DropSheetQueued снимает с очереди пачку доставленных (или больше не нужных)
// ответов — но только строки не новее прочитанных (before): строку,
// поставленную заново, пока мы ходили в Google, снимать нельзя.
func (Repo) DropSheetQueued(ctx context.Context, db postgres.DBTX, linkID uuid.UUID, ids []uuid.UUID, before time.Time) error {
	if len(ids) == 0 {
		return nil
	}
	err := postgres.New(db).DeleteSheetQueued(ctx, postgres.DeleteSheetQueuedParams{
		LinkID:         linkID,
		SubmissionIds:  ids,
		EnqueuedBefore: pgtype.Timestamptz{Time: before, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("delete sheet queued: %w", err)
	}
	return nil
}

// EnqueueSheet ставит ОДИН ответ в очередь связки — повтор доставки из журнала.
func (Repo) EnqueueSheet(ctx context.Context, db postgres.DBTX, linkID, submissionID uuid.UUID) error {
	err := postgres.New(db).InsertSheetQueued(ctx, postgres.InsertSheetQueuedParams{
		LinkID:       linkID,
		SubmissionID: submissionID,
	})
	if err != nil {
		return fmt.Errorf("insert sheet queued: %w", err)
	}
	return nil
}

// ClearSheetQueue снимает с очереди всё, что ждало: выключение тумблера и перезалив.
func (Repo) ClearSheetQueue(ctx context.Context, db postgres.DBTX, linkID uuid.UUID) error {
	if err := postgres.New(db).ClearSheetQueue(ctx, linkID); err != nil {
		return fmt.Errorf("clear sheet queue: %w", err)
	}
	return nil
}

// EnqueueSheetBackfill ставит в очередь связки ВСЕ накопленные ответы формы.
// Возвращает число строк — оно же «сколько ответов перенесём».
func (Repo) EnqueueSheetBackfill(ctx context.Context, db postgres.DBTX, linkID, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).EnqueueSheetBackfill(ctx, postgres.EnqueueSheetBackfillParams{
		LinkID: linkID,
		FormID: formID,
	})
	if err != nil {
		return 0, fmt.Errorf("enqueue sheet backfill: %w", err)
	}
	return n, nil
}

// ExpiredSheetQueued — ответы, прождавшие дольше срока хранения.
func (Repo) ExpiredSheetQueued(ctx context.Context, db postgres.DBTX, before time.Time, limit int32) ([]SheetQueueRef, error) {
	rows, err := postgres.New(db).ExpiredSheetQueued(ctx, postgres.ExpiredSheetQueuedParams{
		EnqueuedAt: pgtype.Timestamptz{Time: before, Valid: true},
		Limit:      limit,
	})
	if err != nil {
		return nil, fmt.Errorf("expired sheet queued: %w", err)
	}
	out := make([]SheetQueueRef, 0, len(rows))
	for _, row := range rows {
		out = append(out, SheetQueueRef{LinkID: row.LinkID, SubmissionID: row.SubmissionID})
	}
	return out, nil
}

// SheetQueueRef — просроченная строка очереди: её снимают и пишут в журнал.
type SheetQueueRef struct {
	LinkID       uuid.UUID
	SubmissionID uuid.UUID
}

// UpdateLinkTarget переносит связку на другую цель. Новая цель — новая попытка:
// поломка снимается, расписание начинается заново. accountID едет вместе с
// листом, а не отдельным методом: разделить их значит позволить записать связку,
// у которой аккаунт не видит своей же таблицы.
func (Repo) UpdateLinkTarget(ctx context.Context, db postgres.DBTX, id, formID, accountID uuid.UUID, sheet Spreadsheet, columns []domain.SheetColumn) (int64, error) {
	raw, err := json.Marshal(columns)
	if err != nil {
		return 0, fmt.Errorf("marshal columns: %w", err)
	}
	n, err := postgres.New(db).UpdateFormIntegrationTarget(ctx, postgres.UpdateFormIntegrationTargetParams{
		ID:             id,
		FormID:         formID,
		AccountID:      accountID,
		SpreadsheetID:  sheet.ID,
		SpreadsheetUrl: sheet.URL,
		SheetID:        sheet.SheetID,
		SheetTitle:     sheet.Title,
		Columns:        raw,
	})
	if err != nil {
		return 0, fmt.Errorf("update form integration target: %w", err)
	}
	return n, nil
}

// Исходы попытки доставки. Итог связки (status, last_error) отвечает на вопрос
// «работает ли она сейчас», исход — на вопрос «что стало с ЭТИМ ответом».
const (
	OutcomeDelivered = "delivered"
	OutcomeFailed    = "failed"
	OutcomeSkipped   = "skipped"
)

// Вид события журнала: живой ответ или пачка переноса накопленных.
const (
	DeliveryKindSubmission = "submission"
	DeliveryKindBackfill   = "backfill"
)

// Delivery — одна попытка доставки, как она лежит в журнале. Строка на попытку,
// включая ретраи бэкоффа: журнал показывает историю, а не итог.
//
// Detail — НАШ русский текст для экрана, а не ошибка провайдера: её читать
// будет автор формы, а она на английском и про HTTP (полная уходит в лог).
type Delivery struct {
	ID           uuid.UUID
	LinkID       uuid.UUID
	Kind         string
	SubmissionID uuid.UUID // нулевой у пачки переноса: она про диапазон, а не про строку
	Outcome      string
	Detail       string
	RowCount     int32
	CreatedAt    time.Time
	// WebhookID — цель, если попытка была в вебхук (0062). Запись висит ровно на
	// одной цели: либо LinkID, либо WebhookID.
	WebhookID uuid.UUID
	// HTTPStatus — код ответа получателя вебхука; ноль, когда ответа не было
	// вовсе (таймаут, DNS, запрет адреса) или когда цель — таблица.
	HTTPStatus int32
}

// InsertDelivery пишет попытку в журнал.
func (Repo) InsertDelivery(ctx context.Context, db postgres.DBTX, d Delivery) error {
	err := postgres.New(db).InsertIntegrationDelivery(ctx, postgres.InsertIntegrationDeliveryParams{
		ID:           d.ID,
		LinkID:       d.LinkID,
		Kind:         d.Kind,
		SubmissionID: pgtype.UUID{Bytes: d.SubmissionID, Valid: d.SubmissionID != uuid.Nil},
		Outcome:      d.Outcome,
		Detail:       d.Detail,
		RowCount:     d.RowCount,
	})
	if err != nil {
		return fmt.Errorf("insert integration delivery: %w", err)
	}
	return nil
}

// ListDeliveries — страница ленты, новые сверху. Нулевой курсор означает первую
// страницу.
func (Repo) ListDeliveries(ctx context.Context, db postgres.DBTX, linkID, cursor uuid.UUID, limit int32) ([]Delivery, error) {
	rows, err := postgres.New(db).ListIntegrationDeliveries(ctx, postgres.ListIntegrationDeliveriesParams{
		LinkID:   linkID,
		Cursor:   cursor,
		PageSize: limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list integration deliveries: %w", err)
	}
	out := make([]Delivery, 0, len(rows))
	for _, row := range rows {
		out = append(out, toDelivery(row))
	}
	return out, nil
}

// GetDelivery — одна запись журнала. linkID в условии обязателен: id приезжает
// из адреса и правом доступа не является (инвариант 1).
func (Repo) GetDelivery(ctx context.Context, db postgres.DBTX, id, linkID uuid.UUID) (Delivery, error) {
	row, err := postgres.New(db).GetIntegrationDelivery(ctx, postgres.GetIntegrationDeliveryParams{
		ID:     id,
		LinkID: linkID,
	})
	if err != nil {
		return Delivery{}, err
	}
	return toDelivery(row), nil
}

// SubmissionDelivered — доезжал ли этот ответ в лист связки хоть раз.
func (Repo) SubmissionDelivered(ctx context.Context, db postgres.DBTX, linkID, submissionID uuid.UUID) (bool, error) {
	ok, err := postgres.New(db).SubmissionAlreadyDelivered(ctx, postgres.SubmissionAlreadyDeliveredParams{
		LinkID:       linkID,
		SubmissionID: pgtype.UUID{Bytes: submissionID, Valid: submissionID != uuid.Nil},
	})
	if err != nil {
		return false, fmt.Errorf("submission already delivered: %w", err)
	}
	return ok, nil
}

// DeleteOldDeliveries убирает записи старше границы и отдаёт их число — задаче
// уборки есть что написать в лог.
func (Repo) DeleteOldDeliveries(ctx context.Context, db postgres.DBTX, before time.Time) (int64, error) {
	n, err := postgres.New(db).DeleteOldIntegrationDeliveries(ctx, pgtype.Timestamptz{Time: before, Valid: true})
	if err != nil {
		return 0, fmt.Errorf("delete old integration deliveries: %w", err)
	}
	return n, nil
}

func toDelivery(row postgres.IntegrationDelivery) Delivery {
	d := Delivery{
		ID: row.ID,
		// С 0062 колонка допускает NULL (запись вебхука), но ленту связки читают
		// условием по link_id — здесь он непуст всегда.
		LinkID:    uuid.UUID(row.LinkID.Bytes),
		Kind:      row.Kind,
		Outcome:   row.Outcome,
		Detail:    row.Detail,
		RowCount:  row.RowCount,
		CreatedAt: row.CreatedAt.Time,
	}
	if row.SubmissionID.Valid {
		d.SubmissionID = row.SubmissionID.Bytes
	}
	if row.WebhookID.Valid {
		d.WebhookID = row.WebhookID.Bytes
	}
	if row.HttpStatus.Valid {
		d.HTTPStatus = row.HttpStatus.Int32
	}
	return d
}

// InsertWebhook заводит вебхук, если у формы их меньше maxPerForm: потолок
// проверяется тем же утверждением (0 строк — потолок достигнут).
func (Repo) InsertWebhook(ctx context.Context, db postgres.DBTX, w NewWebhook, maxPerForm int32) (bool, error) {
	n, err := postgres.New(db).InsertFormWebhook(ctx, postgres.InsertFormWebhookParams{
		ID:         w.ID,
		FormID:     w.FormID,
		Name:       w.Name,
		Url:        w.URL,
		Secret:     w.SecretSealed,
		Headers:    w.HeadersSealed,
		SetBy:      w.SetBy,
		MaxPerForm: maxPerForm,
	})
	if err != nil {
		return false, fmt.Errorf("insert form webhook: %w", err)
	}
	return n > 0, nil
}

// ListWebhooks — вебхуки формы в порядке заведения.
func (Repo) ListWebhooks(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]Webhook, error) {
	rows, err := postgres.New(db).ListFormWebhooks(ctx, formID)
	if err != nil {
		return nil, fmt.Errorf("list form webhooks: %w", err)
	}
	out := make([]Webhook, 0, len(rows))
	for _, r := range rows {
		out = append(out, toWebhook(postgres.GetFormWebhookRow(r)))
	}
	return out, nil
}

// GetWebhook — вебхук формы; pgx.ErrNoRows, если его нет или он чужой формы.
func (Repo) GetWebhook(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (Webhook, error) {
	row, err := postgres.New(db).GetFormWebhook(ctx, postgres.GetFormWebhookParams{ID: id, FormID: formID})
	if err != nil {
		return Webhook{}, err
	}
	return toWebhook(row), nil
}

// UpdateWebhookSettings — подпись и тумблер.
func (Repo) UpdateWebhookSettings(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, name string, enabled bool) (int64, error) {
	n, err := postgres.New(db).UpdateFormWebhookSettings(ctx, postgres.UpdateFormWebhookSettingsParams{
		ID: id, FormID: formID, Name: name, Enabled: enabled,
	})
	if err != nil {
		return 0, fmt.Errorf("update form webhook settings: %w", err)
	}
	return n, nil
}

// UpdateWebhookURL — новый адрес, новый ответственный и расписание с нуля.
func (Repo) UpdateWebhookURL(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, rawURL string, setBy uuid.UUID) (int64, error) {
	n, err := postgres.New(db).UpdateFormWebhookURL(ctx, postgres.UpdateFormWebhookURLParams{
		ID: id, FormID: formID, Url: rawURL,
		SetBy: pgtype.UUID{Bytes: setBy, Valid: setBy != uuid.Nil},
	})
	if err != nil {
		return 0, fmt.Errorf("update form webhook url: %w", err)
	}
	return n, nil
}

// UpdateWebhookSecret перезаписывает шифротекст секрета подписи.
func (Repo) UpdateWebhookSecret(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, sealed []byte) (int64, error) {
	n, err := postgres.New(db).UpdateFormWebhookSecret(ctx, postgres.UpdateFormWebhookSecretParams{
		ID: id, FormID: formID, Secret: sealed,
	})
	if err != nil {
		return 0, fmt.Errorf("update form webhook secret: %w", err)
	}
	return n, nil
}

// UpdateWebhookHeaders перезаписывает шифротекст своих заголовков; nil — их нет.
func (Repo) UpdateWebhookHeaders(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, sealed []byte) (int64, error) {
	n, err := postgres.New(db).UpdateFormWebhookHeaders(ctx, postgres.UpdateFormWebhookHeadersParams{
		ID: id, FormID: formID, Headers: sealed,
	})
	if err != nil {
		return 0, fmt.Errorf("update form webhook headers: %w", err)
	}
	return n, nil
}

// ClearWebhookSecret выключает подпись: секрета у вебхука больше нет.
func (Repo) ClearWebhookSecret(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).ClearFormWebhookSecret(ctx, postgres.ClearFormWebhookSecretParams{
		ID: id, FormID: formID,
	})
	if err != nil {
		return 0, fmt.Errorf("clear form webhook secret: %w", err)
	}
	return n, nil
}

// DeleteWebhook удаляет вебхук формы и отдаёт число строк.
func (Repo) DeleteWebhook(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteFormWebhook(ctx, postgres.DeleteFormWebhookParams{ID: id, FormID: formID})
	if err != nil {
		return 0, fmt.Errorf("delete form webhook: %w", err)
	}
	return n, nil
}

// ClearWebhookQueue снимает с вебхука все ждущие ответы.
func (Repo) ClearWebhookQueue(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).ClearWebhookQueue(ctx, id); err != nil {
		return fmt.Errorf("clear webhook queue: %w", err)
	}
	return nil
}

func toWebhook(r postgres.GetFormWebhookRow) Webhook {
	w := Webhook{
		ID:              r.ID,
		FormID:          r.FormID,
		Name:            r.Name,
		URL:             r.Url,
		Host:            webhookHost(r.Url),
		SecretSealed:    r.Secret,
		HeadersSealed:   r.Headers,
		Enabled:         r.Enabled,
		Status:          r.Status,
		LastError:       r.LastError.String,
		LastDeliveredAt: r.LastDeliveredAt.Time,
		Queued:          r.Queued,
		CreatedAt:       r.CreatedAt.Time,
	}
	if r.SetBy.Valid {
		w.SetBy = r.SetBy.Bytes
	}
	return w
}

// DueWebhooks — цели, которым есть что везти и чьё время наступило.
func (Repo) DueWebhooks(ctx context.Context, db postgres.DBTX, limit int32) ([]Webhook, error) {
	rows, err := postgres.New(db).DueWebhooks(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("due webhooks: %w", err)
	}
	out := make([]Webhook, 0, len(rows))
	for _, r := range rows {
		w := Webhook{
			ID:                  r.ID,
			FormID:              r.FormID,
			Name:                r.Name,
			URL:                 r.Url,
			Host:                webhookHost(r.Url),
			SecretSealed:        r.Secret,
			HeadersSealed:       r.Headers,
			Enabled:             r.Enabled,
			Status:              r.Status,
			LastError:           r.LastError.String,
			LastDeliveredAt:     r.LastDeliveredAt.Time,
			CreatedAt:           r.CreatedAt.Time,
			WorkspaceID:         r.WorkspaceID,
			FailingSince:        r.FailingSince.Time,
			ConsecutiveFailures: r.ConsecutiveFailures,
			NextAttemptAt:       r.NextAttemptAt.Time,
			FormName:            r.FormName,
			FormSlug:            r.FormSlug,
		}
		if r.SetBy.Valid {
			w.SetBy = r.SetBy.Bytes
		}
		out = append(out, w)
	}
	return out, nil
}

// PendingSubmissions — что цель везёт следующим, в порядке постановки.
func (Repo) PendingWebhookSubmissions(ctx context.Context, db postgres.DBTX, webhookID uuid.UUID, limit int32) ([]uuid.UUID, error) {
	ids, err := postgres.New(db).PendingWebhookSubmissions(ctx, postgres.PendingWebhookSubmissionsParams{
		WebhookID: webhookID,
		Limit:     limit,
	})
	if err != nil {
		return nil, fmt.Errorf("pending webhook submissions: %w", err)
	}
	return ids, nil
}

// Dequeue снимает ответ с очереди цели.
func (Repo) DequeueWebhook(ctx context.Context, db postgres.DBTX, webhookID, submissionID uuid.UUID) error {
	err := postgres.New(db).DeleteWebhookQueued(ctx, postgres.DeleteWebhookQueuedParams{
		WebhookID:    webhookID,
		SubmissionID: submissionID,
	})
	if err != nil {
		return fmt.Errorf("dequeue webhook submission: %w", err)
	}
	return nil
}

// Enqueue ставит ответ в очередь цели (повтор из журнала).
func (Repo) EnqueueWebhook(ctx context.Context, db postgres.DBTX, webhookID, submissionID uuid.UUID) error {
	err := postgres.New(db).InsertWebhookQueued(ctx, postgres.InsertWebhookQueuedParams{
		WebhookID:    webhookID,
		SubmissionID: submissionID,
	})
	if err != nil {
		return fmt.Errorf("enqueue webhook submission: %w", err)
	}
	return nil
}

// ExpiredQueued — ответы, ждущие дольше срока хранения.
func (Repo) ExpiredWebhookQueued(ctx context.Context, db postgres.DBTX, before time.Time, limit int32) ([]QueuedRef, error) {
	rows, err := postgres.New(db).ExpiredWebhookQueued(ctx, postgres.ExpiredWebhookQueuedParams{
		EnqueuedAt: pgtype.Timestamptz{Time: before, Valid: true},
		Limit:      limit,
	})
	if err != nil {
		return nil, fmt.Errorf("expired webhook queue: %w", err)
	}
	out := make([]QueuedRef, 0, len(rows))
	for _, r := range rows {
		out = append(out, QueuedRef{WebhookID: r.WebhookID, SubmissionID: r.SubmissionID})
	}
	return out, nil
}

// MarkWebhookDelivered — успех: неудачи и пауза сброшены.
func (Repo) MarkWebhookDelivered(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).MarkWebhookDelivered(ctx, id); err != nil {
		return fmt.Errorf("mark webhook delivered: %w", err)
	}
	return nil
}

// MarkWebhookFailed усыпляет ЦЕЛЬ до nextAttemptAt. failingSince ставится только
// на первой неудаче подряд (COALESCE в SQL).
func (Repo) MarkWebhookFailed(ctx context.Context, db postgres.DBTX, id uuid.UUID, reason string, failingSince, nextAttemptAt time.Time) error {
	err := postgres.New(db).MarkWebhookFailed(ctx, postgres.MarkWebhookFailedParams{
		ID:            id,
		LastError:     pgtype.Text{String: reason, Valid: reason != ""},
		FailingSince:  pgtype.Timestamptz{Time: failingSince, Valid: true},
		NextAttemptAt: pgtype.Timestamptz{Time: nextAttemptAt, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("mark webhook failed: %w", err)
	}
	return nil
}

// MarkWebhookBroken — доставка невозможна без человека.
func (Repo) MarkWebhookBroken(ctx context.Context, db postgres.DBTX, id uuid.UUID, reason string) error {
	err := postgres.New(db).MarkWebhookBroken(ctx, postgres.MarkWebhookBrokenParams{
		ID:        id,
		LastError: pgtype.Text{String: reason, Valid: reason != ""},
	})
	if err != nil {
		return fmt.Errorf("mark webhook broken: %w", err)
	}
	return nil
}

// ReviveWebhook возвращает цель в работу: расписание с нуля.
func (Repo) ReviveWebhook(ctx context.Context, db postgres.DBTX, id uuid.UUID) error {
	if err := postgres.New(db).ReviveWebhook(ctx, id); err != nil {
		return fmt.Errorf("revive webhook: %w", err)
	}
	return nil
}

// InsertWebhookDelivery пишет попытку в журнал.
func (Repo) InsertWebhookDelivery(ctx context.Context, db postgres.DBTX, d Delivery) error {
	err := postgres.New(db).InsertWebhookDelivery(ctx, postgres.InsertWebhookDeliveryParams{
		ID:           d.ID,
		WebhookID:    pgtype.UUID{Bytes: d.WebhookID, Valid: d.WebhookID != uuid.Nil},
		SubmissionID: pgtype.UUID{Bytes: d.SubmissionID, Valid: d.SubmissionID != uuid.Nil},
		Outcome:      d.Outcome,
		Detail:       d.Detail,
		HttpStatus:   pgtype.Int4{Int32: d.HTTPStatus, Valid: d.HTTPStatus != 0},
	})
	if err != nil {
		return fmt.Errorf("insert webhook delivery: %w", err)
	}
	return nil
}

// ListWebhookDeliveries — страница ленты вебхука, новые сверху.
func (Repo) ListWebhookDeliveries(ctx context.Context, db postgres.DBTX, webhookID, cursor uuid.UUID, limit int32) ([]Delivery, error) {
	rows, err := postgres.New(db).ListWebhookDeliveries(ctx, postgres.ListWebhookDeliveriesParams{
		WebhookID: webhookID,
		Cursor:    cursor,
		PageSize:  limit,
	})
	if err != nil {
		return nil, fmt.Errorf("list webhook deliveries: %w", err)
	}
	out := make([]Delivery, 0, len(rows))
	for _, row := range rows {
		out = append(out, toDelivery(row))
	}
	return out, nil
}

// GetWebhookDelivery — одна запись журнала вебхука.
func (Repo) GetWebhookDelivery(ctx context.Context, db postgres.DBTX, id, webhookID uuid.UUID) (Delivery, error) {
	row, err := postgres.New(db).GetWebhookDelivery(ctx, postgres.GetWebhookDeliveryParams{
		ID:        id,
		WebhookID: webhookID,
	})
	if err != nil {
		return Delivery{}, err
	}
	return toDelivery(row), nil
}

// WebhookSubmissionDelivered — доезжал ли этот ответ в эту цель хоть раз.
func (Repo) WebhookSubmissionDelivered(ctx context.Context, db postgres.DBTX, webhookID, submissionID uuid.UUID) (bool, error) {
	ok, err := postgres.New(db).WebhookSubmissionDelivered(ctx, postgres.WebhookSubmissionDeliveredParams{
		WebhookID:    webhookID,
		SubmissionID: pgtype.UUID{Bytes: submissionID, Valid: submissionID != uuid.Nil},
	})
	if err != nil {
		return false, fmt.Errorf("webhook submission delivered: %w", err)
	}
	return ok, nil
}
