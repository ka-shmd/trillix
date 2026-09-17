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
	// LastSubmissionAt — когда пришёл последний ответ (колонка «Последний ответ» в
	// списке форм); nil = ответов не было. Считают только читающие запросы
	// (Get/GetBySlug/List), у результатов мутаций nil — как и у счётчиков рядом.
	// Фильтр over_quota тот же, что у SubmissionCount: дата обязана называть ответ,
	// который виден в таблице ответов.
	LastSubmissionAt *time.Time
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
	// ClosedTitle — заголовок экрана «приём закрыт» (0043); nil = заголовком
	// остаётся название формы.
	ClosedTitle *string
	// CollectPartial — собирать ли незавершённые ответы (спека §10.0): тумблер
	// формы, живая колонка. Кабинету нужен, чтобы нарисовать состояние тумблера.
	CollectPartial bool
	// Branding — показывать ли бейдж «Сделано в Trillix» (ADR §10, миграция 0038):
	// намерение автора, живая колонка. Кабинету нужен для состояния тумблера.
	//
	// ⚠ МИНА: заполняют только Get/GetBySlug, как и настройки закрытия. У результатов
	// мутаций и у строк списка здесь false — а false у ЭТОГО поля значит «бейдж
	// снят», то есть молчаливая ложь, а не безобидный ноль. Читать его можно только
	// из ответа Get/GetBySlug; кабинет так и делает (в карточке формы поля нет
	// вовсе — formSchema его не объявляет, и Zod его срежет).
	Branding bool
	// Progress — показывать ли шкалу прогресса, индикатор шагов многостраничной
	// формы (миграция 0040): намерение автора, живая колонка. Та же мина, что у
	// Branding: заполняют только Get/GetBySlug, а false здесь значит «шкала снята».
	Progress bool
	// NotifyOnSubmission — слать ли владельцу письмо о новом ответе (слайс D; живая
	// колонка, новые формы — true). Заполняют только Get/GetBySlug (страница настроек);
	// у результатов мутаций false, как и прочие read-only поля выше.
	NotifyOnSubmission bool
	// Behavior — раздел «Поведение» (0044, третий тумблер — 0055): автопереход на
	// следующую страницу, хранение ответов в браузере респондента дольше сессии и
	// ход назад по пройденным страницам. Живые колонки; та же мина, что у Branding, —
	// заполняют только Get/GetBySlug.
	AutoJump    bool
	SaveLocally bool
	AllowBack   bool
	// NotifyEmail — настройка письма о новом ответе (nil = не настраивали → письмо
	// уходит дефолтным шаблоном). Живая колонка (0042); заполняют только
	// Get/GetBySlug — та же мина, что у Branding.
	NotifyEmail *domain.NotifyEmail
	// NotifyRespondent и RespondentEmail — тумблер и бланк письма респонденту
	// (0046, docs/design/respondent-email.md). Живые колонки, зеркало пары выше;
	// заполняют только Get/GetBySlug — та же мина, что у Branding.
	NotifyRespondent bool
	RespondentEmail  *domain.RespondentEmail
	// PasswordSealed — шифротекст пароля формы (nil = пароля нет; 0047). Живая
	// колонка; заполняют только Get/GetBySlug — та же мина, что у Branding.
	// Расшифровывает его service (Password ниже), repo байты не трогает.
	PasswordSealed []byte
	// WorkspaceSlug — короткий ключ пространства формы. Кабинет адресует им
	// пространство, и попапу блока «Запись» он нужен, чтобы увести автора в
	// расписания ЕГО пространства (TD-69). Заполняют только Get/GetBySlug.
	WorkspaceSlug string
	// ScheduleID — расписание записи на время (0050); nil = у формы нет записи.
	// Живая колонка, как настройки закрытия: заполняют только Get/GetBySlug.
	ScheduleID *uuid.UUID
	// Password — расшифрованный пароль формы (nil = пароля нет). Заполняет ТОЛЬКО
	// service.Get/GetBySlug, то есть путь автора: он свой пароль видит и копирует
	// (design/form-password.md §2.1).
	//
	// ⚠ МИНА: здесь лежит секрет открытым текстом. В логи форма целиком не пишется
	// нигде, и не должна начать (internal/CLAUDE.md: пароли в логи не попадают).
	Password *string
	// LinkPreview — своя карточка ссылки (nil = не настраивали → дефолты публичной
	// страницы). Живая колонка, как настройки закрытия; заполняют только
	// Get/GetBySlug — её читает окно кастомизации на экране «Поделиться».
	LinkPreview *domain.LinkPreview
	CreatedAt   time.Time
	UpdatedAt   time.Time
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
// PublicFormRef — публичная форма БЕЗ её документа: всё, чем решаются четыре
// отказа публичного пути (формы нет → 404, пароль, приём закрыт, форму переиздали),
// и ничего, что выводится из схемы. Заголовка здесь нет намеренно: он живёт в
// документе версии (Service.PublicForm), и «заголовок из колонки» был бы вторым,
// расходящимся ответом на тот же вопрос.
//
// Отдельно от документа — потому что схема это JSONB в TOAST, а публичных входов,
// которым она не нужна, больше, чем тех, кому нужна: бикон визита, выдача
// свободного времени, холд (TD-77). Их запрос — GetPublicFormRefBySlug.
type PublicFormRef struct {
	FormID uuid.UUID
	// WorkspaceID — владелец формы. Нужен приёму ответа: квота тарифа считается
	// по воркспейсу (фаза 17). Рендереру не отдаётся.
	WorkspaceID uuid.UUID
	// CabinetName — как форма называется В КАБИНЕТЕ (name ?? title). Рендереру не
	// отдаётся; потребитель один — уведомление о новых ответах, где форма обязана
	// называться тем же словом, что в списке форм.
	CabinetName string
	Version     int32
	VersionID   uuid.UUID
	// Статус и живые настройки закрытия (фаза 8.5 шаг 4): вызывающий вычисляет
	// FormClosed(Status, CloseAt, ResponseLimit, SubmissionCount, now) и решает —
	// отдать форму или показать «приём закрыт». SubmissionCount заполнен только при
	// заданном ResponseLimit (иначе 0 — ветка лимита не считается). ClosedMessage
	// nil/пусто → рендерер покажет дефолт.
	Status        string
	CloseAt       *time.Time
	ResponseLimit *int32
	ClosedMessage *string
	// ClosedTitle — заголовок экрана «приём закрыт» (0043); nil = название формы.
	ClosedTitle     *string
	SubmissionCount int64
	// NotifyOnSubmission — гейт письма владельцу о новом ответе (слайс D): приём
	// ответа читает его отсюда (уже загруженной формы), чтобы не делать лишний запрос
	// на выключенных уведомлениях. Рендереру не отдаётся (не свойство формы для
	// респондента).
	NotifyOnSubmission bool
	// NotifyRespondent — тот же гейт для письма РЕСПОНДЕНТУ (0046). Здесь едет
	// только флаг: бланк письма приезжает с Owner, то есть лишь тогда, когда письмо
	// действительно ставится, — публичная форма читается на каждом открытии.
	NotifyRespondent bool
	// CollectPartial — тумблер сбора незавершённых ответов (спека §10.0). Живая
	// колонка: включается без перепубликации. Право тарифа спрашивает service — и
	// при включении, и при отдаче публичной формы.
	CollectPartial bool
	// Branding — намерение автора о бейдже «Сделано в Trillix» (ADR §10, миграция
	// 0038): true = показывать. Живая колонка, а не поле схемы, ровно затем, чтобы
	// тумблер доезжал до респондента без перепубликации. Факт (намерение плюс право
	// тарифа) считает service.ShowBadge при отдаче.
	Branding bool
	// Progress — намерение автора о шкале прогресса (миграция 0040): true =
	// показывать индикатор шагов. Живая колонка по тем же доводам, что Branding, но
	// БЕЗ тарифа: шкала открыта всем планам, и поверх намерения service ничего не
	// спрашивает — рендерер получает его как есть.
	Progress bool
	// AutoJump/SaveLocally/AllowBack — поведение формы у респондента (0044, 0055).
	// Как и Progress, чистое намерение автора: тарифа у них нет, и решать поверх нечего.
	AutoJump    bool
	SaveLocally bool
	AllowBack   bool
	// PasswordSealed — шифротекст пароля формы (0047); nil = пароля нет. Наружу не
	// отдаётся ни в одном ответе: он нужен только чтобы ПРОВЕРИТЬ токен
	// разблокировки, в подпись которого подмешан, — оттого смена пароля и гасит
	// выданные токены (Service.VerifyUnlock).
	//
	// ⚠ МИНА: спросить его обязан КАЖДЫЙ публичный вход по slug — отдача формы,
	// приём ответа, автосохранение, выдача слота файла, выдача свободного времени и
	// холд (фаза 27). Общего middleware нет и быть
	// не может: решение принимается по строке формы, а не по маршруту. Забытая
	// проверка означает форму, которая спрашивает пароль на экране и пускает мимо
	// него; список входов — design/form-password.md §3.3.
	PasswordSealed []byte
	// ScheduleID — расписание записи (0050); nil = у формы нет записи. Публичный путь
	// берёт по нему само расписание: вопрос о времени в форме без расписания отвечает
	// 404, как и не существующая вовсе (design/booking.md §7).
	ScheduleID *uuid.UUID
	// LinkPreview — намерение автора по карточке ссылки (nil = не настраивал).
	// Право тарифа поверх него спрашивает service при отдаче страницы — карточка
	// это свойство выдачи, а не документа (тот же приём, что у бейджа).
	LinkPreview *domain.LinkPreview
	// MetrikaCounter — номер счётчика Яндекс Метрики, подключённого автором и
	// включённого (0067); nil — счётчика нет. Право тарифа поверх номера спрашивает
	// service.MetrikaFor при отдаче формы — счётчик, как бейдж, свойство выдачи.
	MetrikaCounter *string
	// ConsentRevisionID — текущая ревизия согласия, если согласие ВКЛЮЧЕНО (0069); nil —
	// выключено или не настраивалось. Тарифа нет: согласие — требование закона.
	ConsentRevisionID *uuid.UUID
}

// PublicForm — та же форма ВМЕСТЕ с документом: сырая схема опубликованной версии,
// её разбор и выведенный из неё заголовок. Встраивает PublicFormRef, поэтому
// обращения вида pf.FormID работают одинаково на обеих строках.
type PublicForm struct {
	PublicFormRef
	// Title — заголовок, уже разрешённый сервисом: из блока form_title документа,
	// а при его отсутствии — из колонки forms.title (версии, снятые до фазы 15,
	// блока не несут).
	Title string
	// Schema — сырой JSONB документа опубликованной версии, как он лежит в базе.
	Schema json.RawMessage
	// Parsed — тот же документ, уже разобранный. Едет отсюда, а не разбирается
	// заново у каждого вызывающего: сервис всё равно разбирает схему, чтобы
	// разрешить Title, и второй разбор тех же байтов был чистой потерей на самом
	// горячем публичном пути (TD-77).
	//
	// ⚠ Значим только вместе с ParseErr: у неразобравшейся схемы Parsed нулевой.
	Parsed domain.FormSchema
	// ParseErr — почему документ не разобрался; nil = разобрался. Ошибка едет
	// полем, а не возвращается из PublicForm, потому что вызывающие расходятся в
	// отношении к битой схеме, и оба отношения законны: страница формы и OG-мета
	// деградируют (страница без оформления лучше 500), а приём ответа, слот файла
	// и автосохранение обязаны отказать — они бы иначе писали в базу по документу,
	// которого не поняли.
	ParseErr error
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

// linkPreviewFromJSON разбирает колонку forms.link_preview: NULL или пустой JSON →
// nil («карточку не настраивали», публичный слой берёт дефолты).
//
// БИТЫЙ JSON ДАЁТ nil, А НЕ ОШИБКУ, и это то же правило, по которому публичная
// страница переживает неразбираемую схему: карточка ссылки — украшение выдачи, и
// испорченная строка обязана стоить дефолтного превью, а не пятисотки на форме,
// которая исправно принимает ответы. Записываем сюда только мы и только через
// ValidateLinkPreview, поэтому ветка недостижима в здоровой базе.
// notifyEmailFromJSON разбирает колонку forms.notify_email: NULL, пустой JSON или
// настройка из пустых строк → nil («не настраивали», письмо уходит дефолтным
// шаблоном). Битый JSON тоже даёт nil, и по тому же доводу, что у карточки ссылки:
// испорченная строка обязана стоить дефолтного письма, а не потерянного
// уведомления.
func notifyEmailFromJSON(raw []byte) *domain.NotifyEmail {
	if len(raw) == 0 {
		return nil
	}
	var n domain.NotifyEmail
	if err := json.Unmarshal(raw, &n); err != nil {
		return nil
	}
	if n.Empty() {
		return nil
	}
	return &n
}

// respondentEmailFromJSON разбирает колонку forms.respondent_email тем же правилом,
// что notifyEmailFromJSON: битая строка даёт nil, то есть дефолтное письмо, а не
// потерянное. Своя функция, а не общая с ним, потому что типы разные: у бланка
// респондента есть sourceBlockId, и через один тип они не проходят.
func respondentEmailFromJSON(raw []byte) *domain.RespondentEmail {
	if len(raw) == 0 {
		return nil
	}
	var r domain.RespondentEmail
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil
	}
	if r.Empty() {
		return nil
	}
	return &r
}

func linkPreviewFromJSON(raw []byte) *domain.LinkPreview {
	if len(raw) == 0 {
		return nil
	}
	var p domain.LinkPreview
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil
	}
	if p.Empty() {
		return nil
	}
	return &p
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
	wsID, err := postgres.New(db).GetPersonalWorkspace(ctx, pgtype.UUID{Bytes: userID, Valid: true})
	if err != nil {
		return uuid.Nil, fmt.Errorf("get personal workspace: %w", err)
	}
	return wsID, nil
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
		LastSubmissionAt:      ptrTime(row.LastSubmissionAt),
		VisitCount:            row.VisitCount,
		VisitSubmittedCount:   row.VisitSubmittedCount,
		CloseAt:               ptrTime(row.CloseAt),
		ResponseLimit:         ptrInt32(row.ResponseLimit),
		ClosedMessage:         ptrStr(row.ClosedMessage),
		ClosedTitle:           ptrStr(row.ClosedTitle),
		NotifyOnSubmission:    row.NotifyOnSubmission,
		CollectPartial:        row.CollectPartial,
		Branding:              row.Branding,
		Progress:              row.Progress,
		AutoJump:              row.AutoJump,
		SaveLocally:           row.SaveLocally,
		AllowBack:             row.AllowBack,
		LinkPreview:           linkPreviewFromJSON(row.LinkPreview),
		NotifyEmail:           notifyEmailFromJSON(row.NotifyEmail),
		NotifyRespondent:      row.NotifyRespondent,
		RespondentEmail:       respondentEmailFromJSON(row.RespondentEmail),
		PasswordSealed:        row.Password,
		WorkspaceSlug:         row.WorkspaceSlug,
		ScheduleID:            ptrUUID(row.ScheduleID),
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
		LastSubmissionAt:      ptrTime(row.LastSubmissionAt),
		VisitCount:            row.VisitCount,
		VisitSubmittedCount:   row.VisitSubmittedCount,
		CloseAt:               ptrTime(row.CloseAt),
		ResponseLimit:         ptrInt32(row.ResponseLimit),
		ClosedMessage:         ptrStr(row.ClosedMessage),
		ClosedTitle:           ptrStr(row.ClosedTitle),
		NotifyOnSubmission:    row.NotifyOnSubmission,
		CollectPartial:        row.CollectPartial,
		Branding:              row.Branding,
		Progress:              row.Progress,
		AutoJump:              row.AutoJump,
		SaveLocally:           row.SaveLocally,
		AllowBack:             row.AllowBack,
		LinkPreview:           linkPreviewFromJSON(row.LinkPreview),
		NotifyEmail:           notifyEmailFromJSON(row.NotifyEmail),
		NotifyRespondent:      row.NotifyRespondent,
		RespondentEmail:       respondentEmailFromJSON(row.RespondentEmail),
		PasswordSealed:        row.Password,
		WorkspaceSlug:         row.WorkspaceSlug,
		ScheduleID:            ptrUUID(row.ScheduleID),
		CreatedAt:             row.CreatedAt.Time,
		UpdatedAt:             row.UpdatedAt.Time,
	}, nil
}

// ListPageQuery — параметры страницы списка на уровне репозитория. Структурой, а не
// позиционными аргументами: Sort, Search и Status — три соседние строки, и порядок
// их в вызове ничем не проверяется.
type ListPageQuery struct {
	WorkspaceID uuid.UUID
	Sort        string
	// Search — подстрока отображаемого имени; пусто = без фильтра. Спецсимволы LIKE
	// экранирует вызывающий (service).
	Search string
	// Status — статус формы; пусто = все статусы. Значение проверяет транспорт
	// (ParseStatusFilter), в SQL произвольная строка не попадает.
	Status string
	// After — nil на первой странице.
	After *Cursor
	Limit int32
}

// ListFormsPage — страница списка форм воркспейса: поиск, фильтр по статусу,
// сортировка и курсор одним запросом (фаза 8.5 шаг 8).
// SearchHit — форма в результатах поиска по всем пространствам. Свой тип, а не
// Form: у поиска нет ни счётчиков, ни схемы, ни версии — ему нужны имя, место и
// ссылка, и лишние нулевые поля в этом ответе врали бы (как врёт SubmissionCount у
// результатов мутаций).
type SearchHit struct {
	ID    uuid.UUID
	Slug  string
	Name  *string
	Title string
	// Status — статус формы: строка результата ведёт черновик в редактор, а
	// розданную форму — на ответы, ровно как карточка списка.
	Status string
	// WorkspaceSlug и WorkspaceName — ГДЕ лежит найденное. Несущее здесь имя: без
	// него список результатов из разных пространств неотличим от списка одного, а
	// именно «в каком из них форма» человек и не помнил.
	WorkspaceSlug string
	WorkspaceName string
	UpdatedAt     time.Time
}

// SearchForms — формы по всем пространствам с членством. Право доступа держит
// сам запрос (JOIN по членству), поэтому отдельной проверки здесь нет: спросить
// «можно ли» было бы не у чего — пространство не названо, их много.
func (Repo) SearchForms(ctx context.Context, db postgres.DBTX, userID uuid.UUID, search string, limit int32) ([]SearchHit, error) {
	rows, err := postgres.New(db).SearchFormsForUser(ctx, postgres.SearchFormsForUserParams{
		UserID:    userID,
		Search:    search,
		PageLimit: limit,
	})
	if err != nil {
		return nil, fmt.Errorf("search forms: %w", err)
	}
	out := make([]SearchHit, len(rows))
	for i, r := range rows {
		hit := SearchHit{
			ID: r.ID, Slug: r.Slug, Title: r.Title, Status: r.Status,
			WorkspaceSlug: r.WorkspaceSlug, WorkspaceName: r.WorkspaceName,
			UpdatedAt: r.UpdatedAt.Time,
		}
		if r.Name.Valid {
			name := r.Name.String
			hit.Name = &name
		}
		out[i] = hit
	}
	return out, nil
}

func (Repo) ListFormsPage(ctx context.Context, db postgres.DBTX, q ListPageQuery) ([]ListRow, error) {
	params := postgres.ListFormsPageParams{
		WorkspaceID: q.WorkspaceID,
		Sort:        q.Sort,
		PageLimit:   q.Limit,
	}
	if q.Search != "" {
		params.Search = pgtype.Text{String: q.Search, Valid: true}
	}
	if q.Status != "" {
		params.Status = pgtype.Text{String: q.Status, Valid: true}
	}
	if q.After != nil {
		params.CursorKey = pgtype.Int8{Int64: q.After.SortKey, Valid: true}
		params.CursorID = pgtype.UUID{Bytes: q.After.ID, Valid: true}
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
				LastSubmissionAt:      ptrTime(r.LastSubmissionAt),
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
	title := strings.TrimSpace(s.ClosedTitle)
	var titlePtr *string
	if title != "" {
		titlePtr = &title
	}
	row, err := postgres.New(db).UpdateFormCloseSettings(ctx, postgres.UpdateFormCloseSettingsParams{
		ID:            id,
		WorkspaceID:   workspaceID,
		CloseAt:       pgTime(s.CloseAt),
		ResponseLimit: pgInt4(s.ResponseLimit),
		ClosedMessage: pgText(msgPtr),
		ClosedTitle:   pgText(titlePtr),
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
	// WorkspaceID — чей тариф спрашивать перед тем, как взять СВОЙ текст письма:
	// настройка платная, и даунгрейд обязан возвращать дефолтный шаблон сам, как
	// возвращает бейдж (BILLING.md).
	WorkspaceID uuid.UUID
	// NotifyEmail — свой текст письма (nil = дефолтный шаблон).
	NotifyEmail *domain.NotifyEmail
	// Slug — публичный адрес формы. Нужен ПОДВАЛУ писем респонденту: и квитанция,
	// и письмо о записи уходят на адрес, введённый в форму, и обязаны сказать
	// получателю, откуда взялись. Больше его на этом пути взять негде.
	Slug string
	// PublicTitle — как форма называется ДЛЯ РЕСПОНДЕНТА (колонка title). Отдельно
	// от Title: тот несёт внутреннее имя из кабинета («Анкета (копия 2)»), и в
	// подвале письма респонденту оно читалось бы как чужая кухня.
	PublicTitle string
	// RespondentEmail — бланк письма респонденту (nil = дефолтный шаблон). Едет
	// вместе с владельцем, потому что оба письма ставятся в один момент и по одному
	// поводу; второй запрос за ним означал бы поход в базу на каждый ответ.
	RespondentEmail *domain.RespondentEmail
}

// GetSubmissionOwner отдаёт владельца формы и её имя для письма-уведомления (слайс
// D). Не проверяет членство: это адресат уведомления, а не доступ пользователя;
// форма уже резолвнута приёмом ответа. pgx.ErrNoRows пробрасывается обёрнутым.
func (Repo) GetSubmissionOwner(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (Owner, error) {
	row, err := postgres.New(db).GetSubmissionOwner(ctx, formID)
	if err != nil {
		return Owner{}, fmt.Errorf("get submission owner: %w", err)
	}
	return Owner{
		Email:           row.Email,
		Title:           row.Title,
		PublicTitle:     row.PublicTitle,
		Slug:            row.Slug,
		WorkspaceID:     row.WorkspaceID,
		NotifyEmail:     notifyEmailFromJSON(row.NotifyEmail),
		RespondentEmail: respondentEmailFromJSON(row.RespondentEmail),
	}, nil
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
		PublicFormRef: PublicFormRef{
			FormID:             row.FormID,
			WorkspaceID:        row.WorkspaceID,
			CabinetName:        row.CabinetName,
			Version:            row.Version,
			VersionID:          uuid.UUID(row.PublishedVersionID.Bytes),
			Status:             row.Status,
			CloseAt:            ptrTime(row.CloseAt),
			ResponseLimit:      ptrInt32(row.ResponseLimit),
			ClosedMessage:      ptrStr(row.ClosedMessage),
			ClosedTitle:        ptrStr(row.ClosedTitle),
			SubmissionCount:    row.SubmissionCount,
			NotifyOnSubmission: row.NotifyOnSubmission,
			NotifyRespondent:   row.NotifyRespondent,
			CollectPartial:     row.CollectPartial,
			Branding:           row.Branding,
			Progress:           row.Progress,
			AutoJump:           row.AutoJump,
			SaveLocally:        row.SaveLocally,
			AllowBack:          row.AllowBack,
			PasswordSealed:     row.Password,
			ScheduleID:         ptrUUID(row.ScheduleID),
			LinkPreview:        linkPreviewFromJSON(row.LinkPreview),
			MetrikaCounter:     ptrStr(row.MetrikaCounter),
			ConsentRevisionID:  enabledConsent(row.ConsentRevisionID, row.ConsentEnabled),
		},
		Title:  row.Title,
		Schema: json.RawMessage(row.Schema),
	}, nil
}

// GetPublicFormRefBySlug — та же строка без документа (TD-77): для путей, которым
// схема не нужна. Отказы те же и по тем же причинам, что у широкого соседа:
// черновик/нет формы/осиротевшее пространство/удалённый владелец → pgx.ErrNoRows →
// service вернёт 404.
func (Repo) GetPublicFormRefBySlug(ctx context.Context, db postgres.DBTX, slug string) (PublicFormRef, error) {
	row, err := postgres.New(db).GetPublicFormRefBySlug(ctx, slug)
	if err != nil {
		return PublicFormRef{}, fmt.Errorf("get public form ref by slug: %w", err)
	}
	return PublicFormRef{
		FormID:             row.FormID,
		WorkspaceID:        row.WorkspaceID,
		CabinetName:        row.CabinetName,
		Version:            row.Version,
		VersionID:          uuid.UUID(row.PublishedVersionID.Bytes),
		Status:             row.Status,
		CloseAt:            ptrTime(row.CloseAt),
		ResponseLimit:      ptrInt32(row.ResponseLimit),
		ClosedMessage:      ptrStr(row.ClosedMessage),
		ClosedTitle:        ptrStr(row.ClosedTitle),
		SubmissionCount:    row.SubmissionCount,
		NotifyOnSubmission: row.NotifyOnSubmission,
		NotifyRespondent:   row.NotifyRespondent,
		CollectPartial:     row.CollectPartial,
		Branding:           row.Branding,
		Progress:           row.Progress,
		AutoJump:           row.AutoJump,
		SaveLocally:        row.SaveLocally,
		AllowBack:          row.AllowBack,
		PasswordSealed:     row.Password,
		ScheduleID:         ptrUUID(row.ScheduleID),
		LinkPreview:        linkPreviewFromJSON(row.LinkPreview),
		MetrikaCounter:     ptrStr(row.MetrikaCounter),
		ConsentRevisionID:  enabledConsent(row.ConsentRevisionID, row.ConsentEnabled),
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

// UpdateFormLinkPreview заменяет карточку ссылки формы в пределах воркспейса.
// Пустая карточка нормализуется в NULL — «не настраивали» обязано иметь ровно одно
// представление в колонке, иначе читателю приходится знать оба (domain.Empty).
// pgx.ErrNoRows (чужая/нет формы) пробрасывается — service вернёт 404.
func (Repo) UpdateFormLinkPreview(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, p *domain.LinkPreview) (Form, error) {
	var raw []byte
	if !p.Empty() {
		var err error
		raw, err = json.Marshal(p)
		if err != nil {
			return Form{}, fmt.Errorf("marshal link preview: %w", err)
		}
	}
	row, err := postgres.New(db).UpdateFormLinkPreview(ctx, postgres.UpdateFormLinkPreviewParams{
		ID:          id,
		WorkspaceID: workspaceID,
		LinkPreview: raw,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form link_preview: %w", err)
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

// UpdateFormBehavior заменяет раздел «Поведение» целиком (0044, третья колонка —
// 0055): автопереход, хранение ответов в браузере респондента и ход назад по
// страницам. Набором, а не по одной колонке: это один экранный раздел, по отдельности
// эти настройки не спрашиваются нигде.
func (Repo) UpdateFormBehavior(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, autoJump, saveLocally, allowBack bool) (Form, error) {
	row, err := postgres.New(db).UpdateFormBehavior(ctx, postgres.UpdateFormBehaviorParams{
		ID:          id,
		WorkspaceID: workspaceID,
		AutoJump:    autoJump,
		SaveLocally: saveLocally,
		AllowBack:   allowBack,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form behavior: %w", err)
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

// SetFormReopened открывает закрытую форму: status='published' БЕЗ новой версии.
// 0 строк — это либо чужая форма, либо не закрытая (черновик, уже открытая); service
// различает их по прочитанной ранее форме.
func (Repo) SetFormReopened(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (Form, error) {
	row, err := postgres.New(db).SetFormReopened(ctx, postgres.SetFormReopenedParams{
		ID:          id,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		return Form{}, fmt.Errorf("reopen form: %w", err)
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

// UpdateFormNotifyEmail заменяет настройку письма о новом ответе в пределах
// воркспейса. Пустая настройка нормализуется в NULL — «не настраивали» обязано
// иметь ровно одно представление в колонке (domain.Empty). Право тарифа проверяет
// service до вызова; pgx.ErrNoRows (чужая/нет формы) пробрасывается — 404.
func (Repo) UpdateFormNotifyEmail(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, n *domain.NotifyEmail) (Form, error) {
	var raw []byte
	if !n.Empty() {
		var err error
		raw, err = json.Marshal(n)
		if err != nil {
			return Form{}, fmt.Errorf("marshal notify email: %w", err)
		}
	}
	row, err := postgres.New(db).UpdateFormNotifyEmail(ctx, postgres.UpdateFormNotifyEmailParams{
		ID:          id,
		WorkspaceID: workspaceID,
		NotifyEmail: raw,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form notify_email: %w", err)
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

// UpdateFormNotifyRespondent переключает тумблер письма респонденту (0046) в
// пределах воркспейса. pgx.ErrNoRows (чужая/нет формы) пробрасывается — service
// вернёт 404.
func (Repo) UpdateFormNotifyRespondent(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error) {
	row, err := postgres.New(db).UpdateFormNotifyRespondent(ctx, postgres.UpdateFormNotifyRespondentParams{
		ID:               id,
		WorkspaceID:      workspaceID,
		NotifyRespondent: enabled,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form notify_respondent: %w", err)
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

// UpdateFormPassword ставит или снимает пароль формы (0047): sealed — шифротекст,
// nil — снять. Шифрует service; repo и БД видят только байты. В пределах воркспейса
// (анти-IDOR); pgx.ErrNoRows (чужая/нет формы) пробрасывается — service вернёт 404.
// ScheduleInWorkspace — принадлежит ли расписание пространству формы.
func (Repo) ScheduleInWorkspace(ctx context.Context, db postgres.DBTX, scheduleID, workspaceID uuid.UUID) (bool, error) {
	ok, err := postgres.New(db).ScheduleInWorkspace(ctx, postgres.ScheduleInWorkspaceParams{
		ID:          scheduleID,
		WorkspaceID: workspaceID,
	})
	if err != nil {
		return false, fmt.Errorf("check schedule %s in workspace %s: %w", scheduleID, workspaceID, err)
	}
	return ok, nil
}

// UpdateFormSchedule ставит или снимает расписание записи у формы. Проверку «то же
// пространство» делает service — ключу её не выразить.
func (Repo) UpdateFormSchedule(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, scheduleID *uuid.UUID) (Form, error) {
	arg := pgtype.UUID{}
	if scheduleID != nil {
		arg = pgtype.UUID{Bytes: *scheduleID, Valid: true}
	}
	row, err := postgres.New(db).UpdateFormSchedule(ctx, postgres.UpdateFormScheduleParams{
		ID:          id,
		WorkspaceID: workspaceID,
		ScheduleID:  arg,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form schedule: %w", err)
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

func (Repo) UpdateFormPassword(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, sealed []byte) (Form, error) {
	row, err := postgres.New(db).UpdateFormPassword(ctx, postgres.UpdateFormPasswordParams{
		ID:          id,
		WorkspaceID: workspaceID,
		Password:    sealed,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form password: %w", err)
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

// GetFormPasswordBySlug — id опубликованной формы и шифротекст её пароля. Только для
// публичной ручки разблокировки: на горячем пути (отдача формы) шифротекст не нужен.
// pgx.ErrNoRows (черновик, нет формы) пробрасывается — service вернёт 404.
func (Repo) GetFormPasswordBySlug(ctx context.Context, db postgres.DBTX, slug string) (uuid.UUID, []byte, error) {
	row, err := postgres.New(db).GetFormPasswordBySlug(ctx, slug)
	if err != nil {
		return uuid.Nil, nil, fmt.Errorf("get form password by slug: %w", err)
	}
	return row.FormID, row.Password, nil
}

// UpdateFormRespondentEmail заменяет бланк письма респонденту (0046). Пустая
// настройка пишется как NULL: у «не настраивали» одно представление.
func (Repo) UpdateFormRespondentEmail(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, r *domain.RespondentEmail) (Form, error) {
	var raw []byte
	if !r.Empty() {
		var err error
		raw, err = json.Marshal(r)
		if err != nil {
			return Form{}, fmt.Errorf("marshal respondent email: %w", err)
		}
	}
	row, err := postgres.New(db).UpdateFormRespondentEmail(ctx, postgres.UpdateFormRespondentEmailParams{
		ID:              id,
		WorkspaceID:     workspaceID,
		RespondentEmail: raw,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form respondent_email: %w", err)
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

// UpdateBranding переключает бейдж «Сделано в Trillix». Тариф здесь не при чём:
// право спрашивается при отдаче публичной формы (service.ShowBadge).
func (Repo) UpdateBranding(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, show bool) (Form, error) {
	row, err := postgres.New(db).UpdateFormBranding(ctx, postgres.UpdateFormBrandingParams{
		ID:          id,
		WorkspaceID: workspaceID,
		Branding:    show,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form branding: %w", err)
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

// UpdateProgress переключает шкалу прогресса (индикатор шагов). Тариф здесь ни при
// чём вовсе: шкала открыта всем планам, гейта у неё нет ни в кабинете, ни на отдаче.
func (Repo) UpdateProgress(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, show bool) (Form, error) {
	row, err := postgres.New(db).UpdateFormProgress(ctx, postgres.UpdateFormProgressParams{
		ID:          id,
		WorkspaceID: workspaceID,
		Progress:    show,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form progress: %w", err)
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

// UpdateCollectPartial переключает сбор незавершённых ответов. Право тарифа
// проверяет service до вызова — repo только пишет.
func (Repo) UpdateCollectPartial(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error) {
	row, err := postgres.New(db).UpdateFormCollectPartial(ctx, postgres.UpdateFormCollectPartialParams{
		ID:             id,
		WorkspaceID:    workspaceID,
		CollectPartial: enabled,
	})
	if err != nil {
		return Form{}, fmt.Errorf("update form collect_partial: %w", err)
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

// ConsentRevision — ревизия раздела «Персональные данные» (0069).
type ConsentRevision struct {
	ID       uuid.UUID
	Enabled  bool
	Settings domain.ConsentSettings
	// Template — версия шаблона типового текста, которой собираются документы ревизии.
	Template  int
	CreatedAt time.Time
}

// NewConsentRevision — строка для вставки.
type NewConsentRevision struct {
	ID        uuid.UUID
	FormID    uuid.UUID
	Enabled   bool
	Settings  domain.ConsentSettings
	Template  int
	CreatedBy uuid.UUID
}

// enabledConsent — id ревизии, только если согласие по ней включено. Выключенная
// ревизия для публичного пути то же, что её отсутствие.
func enabledConsent(id pgtype.UUID, enabled pgtype.Bool) *uuid.UUID {
	if !id.Valid || !enabled.Valid || !enabled.Bool {
		return nil
	}
	v := uuid.UUID(id.Bytes)
	return &v
}

func consentRevisionFromRow(id uuid.UUID, enabled bool, settings []byte, template int16, createdAt pgtype.Timestamptz) (ConsentRevision, error) {
	var s domain.ConsentSettings
	if err := json.Unmarshal(settings, &s); err != nil {
		return ConsentRevision{}, fmt.Errorf("decode consent settings %s: %w", id, err)
	}
	return ConsentRevision{ID: id, Enabled: enabled, Settings: s, Template: int(template), CreatedAt: createdAt.Time}, nil
}

// GetFormConsent — текущая ревизия согласия формы. pgx.ErrNoRows — раздел не
// сохраняли ни разу.
func (Repo) GetFormConsent(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (ConsentRevision, error) {
	row, err := postgres.New(db).GetFormConsent(ctx, formID)
	if err != nil {
		return ConsentRevision{}, fmt.Errorf("get form consent: %w", err)
	}
	return consentRevisionFromRow(row.ID, row.Enabled, row.Settings, row.Template, row.CreatedAt)
}

// GetConsentRevision — ревизия именно этой формы. pgx.ErrNoRows — у формы такой нет.
func (Repo) GetConsentRevision(ctx context.Context, db postgres.DBTX, formID, revisionID uuid.UUID) (ConsentRevision, error) {
	row, err := postgres.New(db).GetConsentRevision(ctx, postgres.GetConsentRevisionParams{ID: revisionID, FormID: formID})
	if err != nil {
		return ConsentRevision{}, fmt.Errorf("get consent revision: %w", err)
	}
	return consentRevisionFromRow(row.ID, row.Enabled, row.Settings, row.Template, row.CreatedAt)
}

// InsertConsentRevision пишет ревизию и возвращает её целиком.
func (Repo) InsertConsentRevision(ctx context.Context, db postgres.DBTX, in NewConsentRevision) (ConsentRevision, error) {
	settings, err := json.Marshal(in.Settings)
	if err != nil {
		return ConsentRevision{}, fmt.Errorf("encode consent settings: %w", err)
	}
	createdBy := pgtype.UUID{}
	if in.CreatedBy != uuid.Nil {
		createdBy = pgtype.UUID{Bytes: in.CreatedBy, Valid: true}
	}
	createdAt, err := postgres.New(db).InsertConsentRevision(ctx, postgres.InsertConsentRevisionParams{
		ID:        in.ID,
		FormID:    in.FormID,
		Enabled:   in.Enabled,
		Settings:  settings,
		Template:  int16(in.Template),
		CreatedBy: createdBy,
	})
	if err != nil {
		return ConsentRevision{}, fmt.Errorf("insert consent revision: %w", err)
	}
	return ConsentRevision{ID: in.ID, Enabled: in.Enabled, Settings: in.Settings, Template: in.Template, CreatedAt: createdAt.Time}, nil
}

// SetFormConsentRevision ставит текущую ревизию. 0 строк — форма чужого пространства.
func (Repo) SetFormConsentRevision(ctx context.Context, db postgres.DBTX, formID, workspaceID, revisionID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).SetFormConsentRevision(ctx, postgres.SetFormConsentRevisionParams{
		ID:                formID,
		WorkspaceID:       workspaceID,
		ConsentRevisionID: pgtype.UUID{Bytes: revisionID, Valid: true},
	})
	if err != nil {
		return 0, fmt.Errorf("set form consent revision: %w", err)
	}
	return n, nil
}

// ConsentOperatorItem — строка списка реквизитов пространства (0070).
type ConsentOperatorItem struct {
	ID uuid.UUID
	domain.ConsentOperator
}

// RememberConsentOperator кладёт реквизиты в список пространства; тот же набор
// поднимается наверх, а не дублируется.
func (Repo) RememberConsentOperator(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, o domain.ConsentOperator) error {
	err := postgres.New(db).RememberConsentOperator(ctx, postgres.RememberConsentOperatorParams{
		ID:          domain.NewID(),
		WorkspaceID: workspaceID,
		Name:        o.Name,
		Inn:         o.INN,
		Address:     o.Address,
		Email:       o.Email,
	})
	if err != nil {
		return fmt.Errorf("remember consent operator: %w", err)
	}
	return nil
}

// ListConsentOperators — свежие наборы пространства, не больше limit.
func (Repo) ListConsentOperators(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, limit int32) ([]ConsentOperatorItem, error) {
	rows, err := postgres.New(db).ListConsentOperators(ctx, postgres.ListConsentOperatorsParams{WorkspaceID: workspaceID, Limit: limit})
	if err != nil {
		return nil, fmt.Errorf("list consent operators: %w", err)
	}
	out := make([]ConsentOperatorItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, ConsentOperatorItem{
			ID:              r.ID,
			ConsentOperator: domain.ConsentOperator{Name: r.Name, INN: r.Inn, Address: r.Address, Email: r.Email},
		})
	}
	return out, nil
}

// GetConsentOperatorWorkspace — пространство строки списка. pgx.ErrNoRows — строки нет.
func (Repo) GetConsentOperatorWorkspace(ctx context.Context, db postgres.DBTX, id uuid.UUID) (uuid.UUID, error) {
	ws, err := postgres.New(db).GetConsentOperatorWorkspace(ctx, id)
	if err != nil {
		return uuid.Nil, fmt.Errorf("get consent operator workspace: %w", err)
	}
	return ws, nil
}

// DeleteConsentOperator убирает строку списка. 0 строк — её уже нет.
func (Repo) DeleteConsentOperator(ctx context.Context, db postgres.DBTX, id, workspaceID uuid.UUID) (int64, error) {
	n, err := postgres.New(db).DeleteConsentOperator(ctx, postgres.DeleteConsentOperatorParams{ID: id, WorkspaceID: workspaceID})
	if err != nil {
		return 0, fmt.Errorf("delete consent operator: %w", err)
	}
	return n, nil
}
