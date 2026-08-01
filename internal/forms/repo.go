package forms

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Form — представление формы внутри модуля (без утечки sqlc-типов в service и
// handler). DraftSchema заполняется только Get'ом (списку схема не нужна и не
// тянется); в списке и после создания она nil.
//
// PublishedVersionID/PublishedVersion — id и номер текущей опубликованной версии
// (оба nil, пока форму не публиковали). Номер версии читающие запросы (Get/List)
// достают LEFT JOIN'ом; мутации его не выбирают — там сервис проставляет его сам
// (см. queries.sql), поэтому у результатов мутаций PublishedVersion может быть nil.
//
// HasUnpublishedChanges — черновик отличается от опубликованной версии (бейдж в
// шапке билдера). Считают только Get/List (сравнение draft_schema с fv.schema);
// у результатов мутаций всегда false — для create/publish/unpublish это верно, а
// rename фронт всё равно тут же перечитывает.
type Form struct {
	ID          uuid.UUID
	WorkspaceID uuid.UUID
	// Name — внутреннее имя формы для дашборда (nil = не задано → кабинет показывает
	// Title). Публичного заголовка (Title, его видит респондент) не касается.
	Name                  *string
	Title                 string
	Slug                  string
	Status                string
	DraftSchema           json.RawMessage
	PublishedVersionID    *uuid.UUID
	PublishedVersion      *int32
	HasUnpublishedChanges bool
	// SubmissionCount — число ответов формы (счётчик на карточке дашборда и в шапке
	// таблицы ответов). Считают только читающие запросы (Get/List); у результатов
	// мутаций 0 (как и PublishedVersion) — фронт берёт актуальное из Get/списка.
	SubmissionCount int64
	// Просмотры формы и сколько из них закончились ответом (фаза 8.5 шаг 6). Как и
	// SubmissionCount, заполняют только читающие запросы. Конверсия = Submitted/Visit
	// и считается на фронте; хранить третье производное число незачем.
	//
	// VisitSubmittedCount может расходиться с SubmissionCount: ответ, пришедший без
	// визита (бикон не дошёл, страница из кэша прежней версии рендерера), попадает во
	// второй и не попадает в первый. Поэтому «M ответов» на карточке — это
	// SubmissionCount (то же число, что в таблице ответов), а процент — по визитам.
	VisitCount          int64
	VisitSubmittedCount int64
	// Настройки закрытия формы (живые колонки, фаза 8.5 шаг 4; nil/пусто = не задано).
	// Заполняют только Get/GetBySlug — страница настроек кабинета их читает; у
	// результатов остальных запросов (список, мутации) nil, как и PublishedVersion.
	CloseAt       *time.Time
	ResponseLimit *int32
	ClosedMessage *string
	// NotifyOnSubmission — слать ли владельцу письмо о новом ответе (слайс D; живая
	// колонка, новые формы — true). Заполняют только Get/GetBySlug (страница настроек);
	// у результатов мутаций false, как и прочие read-only поля выше.
	NotifyOnSubmission bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// ListRow — строка списка вместе с ключом сортировки, по которому её выдала БД
// (фаза 8.5 шаг 8). Ключ не часть домена: его смысл зависит от запрошенного
// порядка (наносекунды правки/создания либо число ответов). В курсор идёт именно
// значение из БД — пересчитывать его в Go значило бы завести вторую копию правила
// из queries.sql, которая разошлась бы с первой молча.
type ListRow struct {
	Form
	SortKey int64
}

// PublicForm — публичная проекция опубликованной формы для рендерера: title и схема
// опубликованной версии. VersionID (id этой версии) иммутабелен и служит ETag'ом.
// FormID — id самой формы: рендереру не отдаётся, но нужен приёму ответа (модуль
// submissions привязывает submission к form_id и form_version_id).
type PublicForm struct {
	FormID uuid.UUID
	// WorkspaceID — владелец формы. Нужен приёму ответа: квота тарифа считается
	// по воркспейсу (фаза 17). Рендереру не отдаётся.
	WorkspaceID uuid.UUID
	Title       string
	Version     int32
	Schema      json.RawMessage
	VersionID   uuid.UUID
	// Статус и живые настройки закрытия (фаза 8.5 шаг 4): вызывающий вычисляет
	// FormClosed(Status, CloseAt, ResponseLimit, SubmissionCount, now) и решает —
	// отдать форму или показать «приём закрыт». SubmissionCount заполнен только при
	// заданном ResponseLimit (иначе 0 — ветка лимита не считается). ClosedMessage
	// nil/пусто → рендерер покажет дефолт.
	Status          string
	CloseAt         *time.Time
	ResponseLimit   *int32
	ClosedMessage   *string
	SubmissionCount int64
	// NotifyOnSubmission — гейт письма владельцу о новом ответе (слайс D): приём
	// ответа читает его отсюда (уже загруженной формы), чтобы не делать лишний запрос
	// на выключенных уведомлениях. Рендереру не отдаётся (не свойство формы для
	// респондента).
	NotifyOnSubmission bool
}

// Version — опубликованный снапшот схемы формы: номер версии и её JSONB-схема.
// Нужен CSV-экспорту (объединение колонок по версиям, подписи опций из версии
// ответа). Схема иммутабельна и уже канонизирована при публикации.
type Version struct {
	Number int32
	Schema json.RawMessage
}

// ptrUUID переводит nullable uuid из sqlc (pgtype.UUID) в *uuid.UUID: NULL → nil.
func ptrUUID(v pgtype.UUID) *uuid.UUID {
	if !v.Valid {
		return nil
	}
	id := uuid.UUID(v.Bytes)
	return &id
}

// ptrInt32 переводит nullable int из sqlc (pgtype.Int4) в *int32: NULL → nil.
func ptrInt32(v pgtype.Int4) *int32 {
	if !v.Valid {
		return nil
	}
	n := v.Int32
	return &n
}

// ptrStr переводит nullable text из sqlc (pgtype.Text) в *string: NULL → nil.
func ptrStr(v pgtype.Text) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

// pgText переводит *string в pgtype.Text для параметров запроса: nil → NULL.
func pgText(s *string) pgtype.Text {
	if s == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *s, Valid: true}
}

// ptrTime переводит nullable timestamptz из sqlc в *time.Time: NULL → nil.
func ptrTime(v pgtype.Timestamptz) *time.Time {
	if !v.Valid {
		return nil
	}
	t := v.Time
	return &t
}

// pgTime переводит *time.Time в pgtype.Timestamptz для параметров: nil → NULL.
func pgTime(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: *t, Valid: true}
}

// pgInt4 переводит *int32 в pgtype.Int4 для параметров: nil → NULL.
func pgInt4(n *int32) pgtype.Int4 {
	if n == nil {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: *n, Valid: true}
}

// FormName — пара (имя, заголовок) формы воркспейса для нумерации копий (ListFormNames).
type FormName struct {
	Name  *string
	Title string
}

// Repo — доступ к данным forms поверх sqlc-запросов. Методы принимают исполнителя
// (postgres.DBTX: пул или транзакция); транзакций сам не открывает.
type Repo struct{}

// GetPersonalWorkspace возвращает id личного воркспейса пользователя.
func (Repo) GetPersonalWorkspace(ctx context.Context, db postgres.DBTX, userID uuid.UUID) (uuid.UUID, error) {
	wsID, err := postgres.New(db).GetPersonalWorkspace(ctx, userID)
	if err != nil {
		return uuid.Nil, fmt.Errorf("get personal workspace: %w", err)
	}
	return wsID, nil
}

// IsWorkspaceMember сообщает, состоит ли пользователь в воркспейсе (анти-IDOR).
func (Repo) IsWorkspaceMember(ctx context.Context, db postgres.DBTX, workspaceID, userID uuid.UUID) (bool, error) {
	ok, err := postgres.New(db).IsWorkspaceMember(ctx, postgres.IsWorkspaceMemberParams{
		WorkspaceID: workspaceID,
		UserID:      userID,
	})
	if err != nil {
		return false, fmt.Errorf("is workspace member: %w", err)
	}
	return ok, nil
}

func (Repo) CreateForm(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, title, slug string) (Form, error) {
	row, err := postgres.New(db).CreateForm(ctx, postgres.CreateFormParams{
		ID:          id,
		WorkspaceID: workspaceID,
		Title:       title,
		Slug:        slug,
	})
	if err != nil {
		return Form{}, fmt.Errorf("create form: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Name:               ptrStr(row.Name),
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// CreateFormWithSchema создаёт форму с заданным именем и черновиком схемы
// (дубликация): name = «(копия N)», title — публичный заголовок оригинала. Статус —
// дефолтный draft, поэтому PublishedVersion(ID) в ответе пусты.
func (Repo) CreateFormWithSchema(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, title, slug string, name *string, schema json.RawMessage) (Form, error) {
	row, err := postgres.New(db).CreateFormWithSchema(ctx, postgres.CreateFormWithSchemaParams{
		ID:          id,
		WorkspaceID: workspaceID,
		Title:       title,
		Slug:        slug,
		Name:        pgText(name),
		DraftSchema: schema,
	})
	if err != nil {
		return Form{}, fmt.Errorf("create form with schema: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Name:               ptrStr(row.Name),
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// GetForm возвращает форму по id вместе с draft_schema и номером опубликованной
// версии. pgx.ErrNoRows пробрасывается (обёрнутым) — service трактует его как
// domain.ErrNotFound.
func (Repo) GetForm(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Form, error) {
	row, err := postgres.New(db).GetForm(ctx, id)
	if err != nil {
		return Form{}, fmt.Errorf("get form: %w", err)
	}
	return Form{
		ID:                    row.ID,
		WorkspaceID:           row.WorkspaceID,
		Name:                  ptrStr(row.Name),
		Title:                 row.Title,
		Slug:                  row.Slug,
		Status:                row.Status,
		DraftSchema:           json.RawMessage(row.DraftSchema),
		PublishedVersionID:    ptrUUID(row.PublishedVersionID),
		PublishedVersion:      ptrInt32(row.PublishedVersion),
		HasUnpublishedChanges: row.HasUnpublishedChanges,
		SubmissionCount:       row.SubmissionCount,
		VisitCount:            row.VisitCount,
		VisitSubmittedCount:   row.VisitSubmittedCount,
		CloseAt:               ptrTime(row.CloseAt),
		ResponseLimit:         ptrInt32(row.ResponseLimit),
		ClosedMessage:         ptrStr(row.ClosedMessage),
		NotifyOnSubmission:    row.NotifyOnSubmission,
		CreatedAt:             row.CreatedAt.Time,
		UpdatedAt:             row.UpdatedAt.Time,
	}, nil
}

// GetFormBySlug возвращает форму по slug (тот же набор полей, что GetForm).
// Приватный резолв формы для кабинета: URL редактора/ответов/шаринга адресуют
// форму slug'ом, а не UUID. pgx.ErrNoRows пробрасывается (обёрнутым) — service
// трактует его как domain.ErrNotFound.
func (Repo) GetFormBySlug(ctx context.Context, db postgres.DBTX, slug string) (Form, error) {
	row, err := postgres.New(db).GetFormBySlug(ctx, slug)
	if err != nil {
		return Form{}, fmt.Errorf("get form by slug: %w", err)
	}
	return Form{
		ID:                    row.ID,
		WorkspaceID:           row.WorkspaceID,
		Name:                  ptrStr(row.Name),
		Title:                 row.Title,
		Slug:                  row.Slug,
		Status:                row.Status,
		DraftSchema:           json.RawMessage(row.DraftSchema),
		PublishedVersionID:    ptrUUID(row.PublishedVersionID),
		PublishedVersion:      ptrInt32(row.PublishedVersion),
		HasUnpublishedChanges: row.HasUnpublishedChanges,
		SubmissionCount:       row.SubmissionCount,
		VisitCount:            row.VisitCount,
		VisitSubmittedCount:   row.VisitSubmittedCount,
		CloseAt:               ptrTime(row.CloseAt),
		ResponseLimit:         ptrInt32(row.ResponseLimit),
		ClosedMessage:         ptrStr(row.ClosedMessage),
		NotifyOnSubmission:    row.NotifyOnSubmission,
		CreatedAt:             row.CreatedAt.Time,
		UpdatedAt:             row.UpdatedAt.Time,
	}, nil
}

// ListFormsPage — страница списка форм воркспейса: поиск, сортировка и курсор
// одним запросом (фаза 8.5 шаг 8). Пустой search — без фильтра; nil-курсор —
// первая страница. Экранирование спецсимволов LIKE — на вызывающем (service).
func (Repo) ListFormsPage(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, sort string, search string, after *Cursor, limit int32) ([]ListRow, error) {
	params := postgres.ListFormsPageParams{
		WorkspaceID: workspaceID,
		Sort:        sort,
		PageLimit:   limit,
	}
	if search != "" {
		params.Search = pgtype.Text{String: search, Valid: true}
	}
	if after != nil {
		params.CursorKey = pgtype.Int8{Int64: after.SortKey, Valid: true}
		params.CursorID = pgtype.UUID{Bytes: after.ID, Valid: true}
	}

	rows, err := postgres.New(db).ListFormsPage(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("list forms page: %w", err)
	}
	out := make([]ListRow, len(rows))
	for i, r := range rows {
		out[i] = ListRow{
			Form: Form{
				ID:                    r.ID,
				WorkspaceID:           r.WorkspaceID,
				Name:                  ptrStr(r.Name),
				Title:                 r.Title,
				Slug:                  r.Slug,
				Status:                r.Status,
				PublishedVersionID:    ptrUUID(r.PublishedVersionID),
				PublishedVersion:      ptrInt32(r.PublishedVersion),
				HasUnpublishedChanges: r.HasUnpublishedChanges,
				SubmissionCount:       r.SubmissionCount,
				VisitCount:            r.VisitCount,
				VisitSubmittedCount:   r.VisitSubmittedCount,
				CreatedAt:             r.CreatedAt.Time,
				UpdatedAt:             r.UpdatedAt.Time,
			},
			SortKey: r.SortKey,
		}
	}
	return out, nil
}

// UpdateFormName меняет внутреннее имя формы (дашборд) в пределах воркспейса.
// pgx.ErrNoRows (чужая/нет формы) пробрасывается обёрнутым — service вернёт 404.
func (Repo) UpdateFormName(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, name *string) (Form, error) {
	row, err := postgres.New(db).UpdateFormName(ctx, postgres.UpdateFormNameParams{
		ID:          id,
		WorkspaceID: workspaceID,
		Name:        pgText(name),
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form name: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Name:               ptrStr(row.Name),
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// UpdateFormCloseSettings заменяет настройки закрытия формы (дата/лимит/текст) в
// пределах воркспейса. Пустое сообщение нормализуем в NULL (пусто = дефолт
// рендерера). pgx.ErrNoRows (чужая/нет формы) пробрасывается — service вернёт 404.
func (Repo) UpdateFormCloseSettings(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, s domain.CloseSettings) (Form, error) {
	msg := strings.TrimSpace(s.ClosedMessage)
	var msgPtr *string
	if msg != "" {
		msgPtr = &msg
	}
	row, err := postgres.New(db).UpdateFormCloseSettings(ctx, postgres.UpdateFormCloseSettingsParams{
		ID:            id,
		WorkspaceID:   workspaceID,
		CloseAt:       pgTime(s.CloseAt),
		ResponseLimit: pgInt4(s.ResponseLimit),
		ClosedMessage: pgText(msgPtr),
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form close settings: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Name:               ptrStr(row.Name),
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// UpdateFormNotifyOnSubmission переключает тумблер уведомлений в пределах воркспейса
// (слайс D). pgx.ErrNoRows (чужая/нет формы) пробрасывается — service вернёт 404.
func (Repo) UpdateFormNotifyOnSubmission(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error) {
	row, err := postgres.New(db).UpdateFormNotifyOnSubmission(ctx, postgres.UpdateFormNotifyOnSubmissionParams{
		ID:                 id,
		WorkspaceID:        workspaceID,
		NotifyOnSubmission: enabled,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form notify_on_submission: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Name:               ptrStr(row.Name),
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// Owner — адресат уведомления о новом ответе: email владельца формы и её
// отображаемое имя (name ?? title) для темы/тела письма.
type Owner struct {
	Email string
	Title string
}

// GetSubmissionOwner отдаёт владельца формы и её имя для письма-уведомления (слайс
// D). Не проверяет членство: это адресат уведомления, а не доступ пользователя;
// форма уже резолвнута приёмом ответа. pgx.ErrNoRows пробрасывается обёрнутым.
func (Repo) GetSubmissionOwner(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (Owner, error) {
	row, err := postgres.New(db).GetSubmissionOwner(ctx, formID)
	if err != nil {
		return Owner{}, fmt.Errorf("get submission owner: %w", err)
	}
	return Owner{Email: row.Email, Title: row.Title}, nil
}

// ListFormNames возвращает пары (имя, заголовок) всех форм воркспейса — сервису для
// нумерации копий (подбор следующего «(копия N)» без коллизий).
func (Repo) ListFormNames(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID) ([]FormName, error) {
	rows, err := postgres.New(db).ListFormNames(ctx, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list form names: %w", err)
	}
	out := make([]FormName, len(rows))
	for i, r := range rows {
		out[i] = FormName{Name: ptrStr(r.Name), Title: r.Title}
	}
	return out, nil
}

// UpdateFormDraftSchema сохраняет черновик схемы с оптимистичной блокировкой:
// UPDATE проходит, только если updated_at совпадает с expectedUpdatedAt. Расхождение
// (или удалённая параллельно форма) → 0 строк → pgx.ErrNoRows, которую service
// трактует как конфликт (доступ он проверяет заранее отдельным чтением).
// mirrorTitle — заголовок-зеркало (фаза 15): nil означает «документ о заголовке не
// высказался», и колонка остаётся как была.
func (Repo) UpdateFormDraftSchema(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, schema json.RawMessage, mirrorTitle *string, expectedUpdatedAt time.Time) (Form, error) {
	title := pgtype.Text{}
	if mirrorTitle != nil {
		title = pgtype.Text{String: *mirrorTitle, Valid: true}
	}
	row, err := postgres.New(db).UpdateFormDraftSchema(ctx, postgres.UpdateFormDraftSchemaParams{
		ID:                id,
		WorkspaceID:       workspaceID,
		DraftSchema:       schema,
		Title:             title,
		ExpectedUpdatedAt: pgtype.Timestamptz{Time: expectedUpdatedAt, Valid: true},
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form draft schema: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Name:               ptrStr(row.Name),
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		DraftSchema:        json.RawMessage(row.DraftSchema),
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// DeleteForm удаляет форму в пределах воркспейса; возвращает число удалённых строк.
func (Repo) DeleteForm(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteForm(ctx, postgres.DeleteFormParams{ID: id, WorkspaceID: workspaceID})
	if err != nil {
		return 0, fmt.Errorf("delete form: %w", err)
	}
	return n, nil
}

// GetPublicFormBySlug возвращает публичную форму по slug вместе со статусом и
// настройками закрытия (закрытую тоже — вызывающий решает, что показать). Только
// черновик/нет формы дают pgx.ErrNoRows (INNER JOIN по версии) → service вернёт 404.
func (Repo) GetPublicFormBySlug(ctx context.Context, db postgres.DBTX, slug string) (PublicForm, error) {
	row, err := postgres.New(db).GetPublicFormBySlug(ctx, slug)
	if err != nil {
		return PublicForm{}, fmt.Errorf("get public form by slug: %w", err)
	}
	// published_version_id — ключ INNER JOIN, всегда валиден на вернувшейся строке.
	return PublicForm{
		FormID:             row.FormID,
		WorkspaceID:        row.WorkspaceID,
		Title:              row.Title,
		Version:            row.Version,
		Schema:             json.RawMessage(row.Schema),
		VersionID:          uuid.UUID(row.PublishedVersionID.Bytes),
		Status:             row.Status,
		CloseAt:            ptrTime(row.CloseAt),
		ResponseLimit:      ptrInt32(row.ResponseLimit),
		ClosedMessage:      ptrStr(row.ClosedMessage),
		SubmissionCount:    row.SubmissionCount,
		NotifyOnSubmission: row.NotifyOnSubmission,
	}, nil
}

// ListFormVersions возвращает все опубликованные версии формы (снапшоты) по
// возрастанию номера — для CSV-экспорта.
func (Repo) ListFormVersions(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]Version, error) {
	rows, err := postgres.New(db).ListFormVersions(ctx, formID)
	if err != nil {
		return nil, fmt.Errorf("list form versions: %w", err)
	}
	out := make([]Version, len(rows))
	for i, r := range rows {
		out[i] = Version{Number: r.Version, Schema: json.RawMessage(r.Schema)}
	}
	return out, nil
}

// NextFormVersion возвращает номер следующей версии формы (1 для первой публикации).
func (Repo) NextFormVersion(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int32, error) {
	n, err := postgres.New(db).NextFormVersion(ctx, formID)
	if err != nil {
		return 0, fmt.Errorf("next form version: %w", err)
	}
	return n, nil
}

// InsertFormVersion пишет иммутабельный снапшот схемы; возвращает id новой строки
// form_versions (им service проставляет published_version_id в той же транзакции).
func (Repo) InsertFormVersion(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, version int32, schema json.RawMessage) (uuid.UUID, error) {
	row, err := postgres.New(db).InsertFormVersion(ctx, postgres.InsertFormVersionParams{
		ID:      id,
		FormID:  formID,
		Version: version,
		Schema:  schema,
	})
	if err != nil {
		return uuid.Nil, fmt.Errorf("insert form version: %w", err)
	}
	return row.ID, nil
}

// SetFormPublished переводит форму в published и привязывает опубликованную версию.
// В пределах воркспейса; pgx.ErrNoRows (чужая/нет формы) пробрасывается обёрнутым.
func (Repo) SetFormPublished(ctx context.Context, db postgres.DBTX, id, workspaceID, versionID uuid.UUID) (Form, error) {
	row, err := postgres.New(db).SetFormPublished(ctx, postgres.SetFormPublishedParams{
		ID:                 id,
		WorkspaceID:        workspaceID,
		PublishedVersionID: pgtype.UUID{Bytes: versionID, Valid: true},
	})
	if err != nil {
		return Form{}, fmt.Errorf("set form published: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Name:               ptrStr(row.Name),
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}

// SetFormClosed переводит форму в closed (published_version_id не трогает).
// В пределах воркспейса; pgx.ErrNoRows (чужая/нет формы) пробрасывается обёрнутым.
func (Repo) SetFormClosed(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (Form, error) {
	row, err := postgres.New(db).SetFormClosed(ctx, postgres.SetFormClosedParams{
		ID:          id,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		return Form{}, fmt.Errorf("set form closed: %w", err)
	}
	return Form{
		ID:                 row.ID,
		WorkspaceID:        row.WorkspaceID,
		Name:               ptrStr(row.Name),
		Title:              row.Title,
		Slug:               row.Slug,
		Status:             row.Status,
		PublishedVersionID: ptrUUID(row.PublishedVersionID),
		CreatedAt:          row.CreatedAt.Time,
		UpdatedAt:          row.UpdatedAt.Time,
	}, nil
}
