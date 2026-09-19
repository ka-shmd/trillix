package submissions

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/notify"
	"github.com/ka-shmd/trillix/internal/postgres"
)

const (
	// maxMetaFieldLen — потолок длины строк меты (user_agent, referer): обрезаем, чтобы
	// раздутый заголовок не распухал JSONB. Само тело ограничено MaxBytesReader'ом,
	// но заголовки в лимит тела не входят.
	maxMetaFieldLen = 512

	// DefaultPageLimit / MaxPageLimit — размер страницы листинга ответов. Запрошенный
	// клиентом limit зажимается в [1, MaxPageLimit]; пустой → Default. Совпадает с
	// forms по значениям, но свой — модули не делят константы пагинации.
	DefaultPageLimit = 50
	MaxPageLimit     = 100

	// PartialTTL — сколько живёт черновик после последней правки. Константа, а не
	// переменная окружения (решение владельца): черновик — наблюдение, а не
	// документ, и ещё одна строка конфига дороже пользы. Хранить его вечно значит
	// копить чужой неотправленный текст без причины.
	PartialTTL = 30 * 24 * time.Hour
)

// Forms — коллаборатор из модуля forms: отдаёт опубликованную форму по slug (приём
// ответа) и авторизует доступ автора к форме по id (листинг). Реализация —
// *forms.Service; общение через интерфейс сервиса (не чужой repo).
type Forms interface {
	PublicForm(ctx context.Context, slug string) (forms.PublicForm, error)
	// VerifyUnlock — пускать ли к содержимому формы, закрытой паролем (0047).
	// sealed — шифротекст пароля прямо сейчас (пустой = пароля нет). Спрашивается у
	// forms, а не решается здесь: секрет подписи обязан лежать в одном месте
	// (design/form-password.md §3.3).
	VerifyUnlock(formID uuid.UUID, sealed []byte, tok string) error
	// CollectPartial — собирать ли черновики у этой формы прямо сейчас: тумблер
	// автора плюс разрешение тарифа (даунгрейд останавливает сбор).
	CollectPartial(ctx context.Context, workspaceID uuid.UUID, intent bool) (bool, error)
	// Get проверяет членство пользователя в воркспейсе формы и возвращает её;
	// чужая или несуществующая → domain.ErrNotFound (анти-IDOR, приватное не
	// раскрывается). Листингу нужен только факт доступа, не поля формы.
	Get(ctx context.Context, userID, formID uuid.UUID) (forms.Form, error)
	GetForAction(ctx context.Context, userID, formID uuid.UUID, action domain.Action) (forms.Form, error)
	// Versions авторизует доступ (как Get) и отдаёт все опубликованные версии
	// формы — их схемы нужны CSV-экспорту для объединения колонок и подписей опций.
	Versions(ctx context.Context, userID, formID uuid.UUID) ([]forms.Version, error)
	// PublishedVersions — то же БЕЗ проверки прав: у фоновой доставки (фаза 25)
	// нет пользователя, чьё право можно спросить, а форма приезжает не из URL.
	PublishedVersions(ctx context.Context, formID uuid.UUID) ([]forms.Version, error)
	// SubmissionOwner — адресат уведомления о новом ответе (email владельца + имя
	// формы). Форма уже резолвнута по slug, членство не проверяется (это адресат, а
	// не доступ пользователя). Слайс D.
	SubmissionOwner(ctx context.Context, formID uuid.UUID) (forms.Owner, error)
	// ConsentRevisionEnabled — ревизия согласия принадлежит форме и включена (0069).
	ConsentRevisionEnabled(ctx context.Context, formID, revisionID uuid.UUID) (bool, error)
}

// Mailer — коллаборатор из модуля mail: ставит письмо-уведомление в outbox.
// Реализация — *mail.Service.
//
// Письмо — ОДНО НА ОДИН ответ (ADR §10, отмена дайджеста 2026-08-30), поэтому здесь
// обычный EnqueueEmail, а не коалесцирующая постановка: склейка N ответов в одно
// письмо несовместима с настраиваемым текстом (свой текст заменяет тело целиком) и
// с PDF-вложением, у которого в дайджесте нет ответа на вопрос «чей ответ печатать».
type Mailer interface {
	EnqueueEmail(ctx context.Context, db postgres.DBTX, msg mail.EmailMessage) error
}

// Notifications — уведомления кабинета глазами этого модуля (internal/notify).
// Реализация — *notify.Service.
//
// От письма отличаются двумя вещами. Тумблер формы их не гасит: письмо — настройка
// формы, а лента — вид человека на своё хозяйство, и выключать его автору формы
// нечем. Адресат у них не один: повод получает каждый участник, кому можно видеть
// формы, — поэтому здесь уезжает событие, а не сообщение.
type Notifications interface {
	Notify(ctx context.Context, db postgres.DBTX, ev notify.Event) error
}

// RespondentLimiter — потолок писем РЕСПОНДЕНТАМ на одну форму
// (docs/design/respondent-email.md §5). Ключ — id формы; false значит «в этом окне
// больше не шлём». Реализация — ratelimit.TokenBucket, в тестах ratelimit.AllowAll
// (инвариант 6: лимитер подменяется пермиссивным, а не ослабляется).
//
// Потолок стоит здесь, а не на транспорте: квота отправки у провайдера общая на
// весь сервис, и выесть её может одна виральная форма. Письма ВЛАДЕЛЬЦУ он не
// касается — их получает один известный адрес, согласившийся их получать.
type RespondentLimiter interface {
	Allow(key string) bool
}

// Visits — коллаборатор из модуля visits// Visits — коллаборатор из модуля visits: отмечает визит как закончившийся ответом
// (фаза 8.5 шаг 6). Реализация — *visits.Service; общение через интерфейс сервиса.
//
// Метод вызывается ПОСЛЕ коммита приёма и best-effort: аналитика не имеет права ни
// отклонить принятый ответ, ни усложнить транзакцию с advisory-lock на самом
// атакуемом эндпоинте. Цена решения — краш в окне между коммитом и отметкой теряет
// флаг у одного визита (конверсия занизится на единицу); альтернатива «в той же
// транзакции» потребовала бы протащить postgres.DBTX через межмодульный интерфейс.
type Visits interface {
	MarkSubmitted(ctx context.Context, formID, visitID uuid.UUID) error
}

// Plans — коллаборатор из модуля entitlements: единственная точка, где код
// спрашивает «можно ли» (ADR §10). Реализация — *entitlements.Service.
//
// Приёму ответа он нужен НЕ для отказа: квота тарифа мягкая, ответ принимается
// при любом состоянии подписки. Нужен факт «сверх квоты», чтобы пометить строку
// (в кабинете владельца она скроется до апгрейда) и период — тот же, в который
// ляжет инкремент расхода, иначе проверка и счёт разъехались бы на границе месяца.
type Plans interface {
	CheckWorkspace(ctx context.Context, workspaceID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
	PeriodStart() time.Time
}

// AnswerFiles — коллаборатор из модуля answerfiles: файлы, приложенные к ответу
// (фаза 24). Реализация — *answerfiles.Service.
//
// Две операции, и порядок между ними принципиален. Verify ходит в хранилище и
// потому зовётся ДО транзакции: держать её открытой на время HEAD к S3 значит
// отдать самый атакуемый эндпоинт во власть чужого таймаута. Claim пишет и потому
// зовётся ВНУТРИ неё: файл, заявленный без ответа, нарушил бы внешний ключ, а
// ответ без заявленных файлов остался бы со ссылками на строки, которые через
// сутки унесёт чистка сирот.
//
// nil означает «файлов в этой сборке нет» (юнит-тесты): ответ без файлов проходит
// прежним путём, ответ с файлами при nil-коллабораторе отвергается — молча принять
// ссылку, которую некому проверить, нельзя.
type AnswerFiles interface {
	Verify(ctx context.Context, formID, submissionID uuid.UUID, byBlock map[string][]string) error
	Claim(ctx context.Context, tx pgx.Tx, submissionID, formID uuid.UUID, byBlock map[string][]string) error
	// RemoveBySubmission сносит объекты ответа из бакета. Зовётся ДО удаления
	// строки ответа: каскад унёс бы вместе со строками ключи, и объекты остались
	// бы в бакете навсегда — их не нашла бы ни чистка (она смотрит в таблицу), ни
	// человек.
	RemoveBySubmission(ctx context.Context, formID, submissionID uuid.UUID) error
	// InfoBySubmissions — имена и размеры файлов перечисленных ответов: id → файл.
	// Нужны и таблице ответов, и выгрузке — в обеих автор видит имя, а не id.
	InfoBySubmissions(ctx context.Context, submissionIDs []uuid.UUID) (map[string]domain.AnswerFile, error)
	// InfoByForm — то же по всей форме: выгрузка не может собирать имена по
	// ответу, иначе получит поездку в базу на каждую строку файла.
	InfoByForm(ctx context.Context, formID uuid.UUID) (map[string]domain.AnswerFile, error)
}

// PartialInput — то, что присылает автосохранение рендерера.
type PartialInput struct {
	VisitID     uuid.UUID
	Version     int32
	Answers     map[string]json.RawMessage
	LastBlockID *string
	// Unlock — токен разблокировки формы под паролем (0047); пусто у открытой формы.
	// У ЭТОЙ ручки он приезжает в ТЕЛЕ, а не заголовком, как у остальных трёх входов:
	// последнее автосохранение уходит через sendBeacon, который заголовков не умеет
	// вовсе (design/form-password.md §3.4).
	Unlock string
}

// Store — доступ к данным submissions, объявленный на стороне потребителя.
type Store interface {
	UpsertPartial(ctx context.Context, db postgres.DBTX, visitID, formID, versionID uuid.UUID, answers json.RawMessage, lastBlockID *string) error
	DeletePartialByVisit(ctx context.Context, db postgres.DBTX, visitID, formID uuid.UUID) (int64, error)
	ListPartials(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32, after *TimeCursor) ([]Partial, error)
	ListFeed(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32, after *TimeCursor) ([]FeedRow, error)
	CountPartials(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int64, error)
	DeletePartial(ctx context.Context, db postgres.DBTX, visitID, formID uuid.UUID) (int64, error)
	DeleteOldPartials(ctx context.Context, db postgres.DBTX, before time.Time) (int64, error)
	InsertSubmission(ctx context.Context, db postgres.DBTX, in NewSubmission) (int64, error)
	ListSubmissions(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32, period domain.Period) ([]Submission, error)
	SubmissionByID(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (Submission, error)
	GetForDelivery(ctx context.Context, db postgres.DBTX, formID, id uuid.UUID) (Submission, error)
	GetForPrint(ctx context.Context, db postgres.DBTX, formID, id uuid.UUID) (PrintRow, error)
	ListForDelivery(ctx context.Context, db postgres.DBTX, formID uuid.UUID, ids []uuid.UUID) ([]Submission, error)
	ListSubmissionsAfter(ctx context.Context, db postgres.DBTX, formID, cursorID uuid.UUID, limit int32, period domain.Period) ([]Submission, error)
	CountInPeriod(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period, prev *domain.Period) (current, previous int64, err error)
	// CountSubmissions — ВСЕ ответы формы (включая скрытые тарифом): нужен
	// жёсткому капу формы, у которого своя семантика.
	CountSubmissions(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (int64, error)
	// CountSubmissionsForCabinet — видимые и скрытые тарифом, одной поездкой.
	CountSubmissionsForCabinet(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (visible, hidden int64, err error)
	DeleteSubmission(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error)
	LockFormForSubmit(ctx context.Context, db postgres.DBTX, formID uuid.UUID) error
}

// Transactor открывает транзакцию (без знания о конкретном пуле). Реализация —
// postgres.TxRunner; нужен жёсткому капу лимита (advisory-lock + счёт + вставка одной
// транзакцией). В юнитах без лимита не вызывается.
type Transactor interface {
	WithTx(ctx context.Context, fn func(pgx.Tx) error) error
}

var _ Store = Repo{}

// Cursor — курсор листинга ответов: id последнего показанного ответа. Ответы
// иммутабельны и монотонны по id (UUIDv7), поэтому курсор одноколоночный (в отличие
// от составного у forms). Транспорт кодирует его в непрозрачную строку.
type Cursor struct {
	ID uuid.UUID
}

// Page — страница ответов, курсор на следующую (nil на последней) и счётчики.
type Page struct {
	Submissions []Submission
	NextCursor  *Cursor
	// Total — сколько ответов ВИДНО (сверхлимитные не считаются): иначе карточка
	// и таблица разошлись бы в числах.
	Total int64
	// Hidden — сколько скрыто квотой тарифа (0014). Кабинет показывает это числом
	// в плашке: молча спрятать собранные человеком данные нельзя.
	Hidden int64
	// Files — метаданные приложенных файлов, id → имя и размер (фаза 24). Отдельной
	// картой, а не внутри answers: в ответе лежат только id (правда о файле живёт в
	// submission_files), и подмешивать имя в значение ответа значило бы хранить его
	// в двух местах, из которых одно — недоверенное.
	Files map[string]domain.AnswerFile
}

var _ Store = Repo{}

// Meta — необязательный контекст ответа (без IP в открытом виде, ARCHITECTURE §3.3).
//
// В JSONB submissions.meta уходят только UserAgent и Referer — перечислением, а не
// маршалингом структуры целиком, поэтому VisitID туда не попадает: он не свойство
// ответа, а связь с визитом, и живёт в form_visits.submitted.
type Meta struct {
	UserAgent string
	Referer   string
	// VisitID — визит, из которого пришёл ответ (uuid.Nil = визита нет: бикон не
	// дошёл или страница из кэша прежней версии рендерера). Отсюда точная конверсия
	// вместо деления двух независимых счётчиков.
	VisitID uuid.UUID
	// Unlock — токен разблокировки формы, закрытой паролем (0047); пусто, если
	// форма открытая. Приехал с запросом, как UserAgent, но в ОТЛИЧИЕ от остальных
	// полей в базу не пишется и писаться не должен: это доказательство права
	// отправить ответ, а не свойство самого ответа.
	Unlock string
	// ConsentRevision — ревизия согласия, под которой человек поставил галочку
	// (0069); uuid.Nil — галочки не было. Недоверенный ввод: сверяется с формой.
	ConsentRevision uuid.UUID
}

// Service — приём ответов. Валидация идёт против ОПУБЛИКОВАННОЙ версии формы, а
// submission привязывается к её id — правки схемы после отправки не искажают данные.
type Service struct {
	db     postgres.DBTX
	tx     Transactor // для жёсткого капа лимита ответов (шаг 4) и enqueue уведомления
	forms  Forms
	visits Visits
	mail   Mailer
	plans  Plans
	repo   Store
	// files — файлы в ответах (фаза 24). Не в конструкторе, а отдельным сеттером
	// (тот же приём, что WithTeams у auth): у приёма ответа уже восемь
	// коллабораторов, и девятый позиционный аргумент — это способ однажды
	// перепутать два соседних интерфейса местами.
	files AnswerFiles
	// bookings — подтверждение записи на время (фаза 27); nil = записи на контуре
	// нет, и ответ с бронью отвергается.
	bookings Bookings
	// bookingGuard — стоп-кран удаления ответа с живой будущей записью (фаза 27).
	bookingGuard BookingGuard
	// notes — уведомления кабинета. Тем же сеттером и по той же причине, что files;
	// nil = уведомлений в сборке нет, и приём ответа этого не замечает.
	notes Notifications
	// bookingOrganizer — адрес отправителя контура: он уезжает ORGANIZER'ом в
	// приглашение календаря. Пусто — письма о записи нет (bookingmail.go).
	bookingOrganizer string
	// integrations — доставка ответа во внешние системы (фаза 25). Тем же
	// сеттером и по той же причине, что files; nil = интеграций в сборке нет.
	// appBaseURL — origin кабинета, из которого строится ссылка в таблицу ответов в
	// письме владельцу (${appBaseURL}/forms/{slug}/responses). Совпадает с cfg.AppOrigin.
	appBaseURL string
	// formBaseURL — origin публичного рендерера: из него собирается адрес самой
	// формы для подвала письма респонденту. Совпадает с cfg.PublicRendererBaseURL.
	//
	// Вместе с respondentLimiter приезжает сеттером, а не девятым аргументом
	// конструктора (тот же довод, что у files). Не настроено — письма респондентам
	// НЕ уходят: письмо без подвала и без потолка отправлять нельзя, это ровно та
	// обвязка, ради которой оно вообще разрешено (спека §5).
	formBaseURL       string
	respondentLimiter RespondentLimiter
	now               func() time.Time // подменяется в тестах (проверка даты закрытия)
}

// WithRespondentMail подключает письмо респонденту: адрес формы для подвала и
// потолок писем на форму. Вызывается при сборке приложения; без него тумблер формы
// остаётся намерением, о котором путь отправки говорит в лог.
func (s *Service) WithRespondentMail(formBaseURL string, limiter RespondentLimiter) *Service {
	s.formBaseURL, s.respondentLimiter = formBaseURL, limiter
	return s
}

func NewService(db postgres.DBTX, tx Transactor, forms Forms, visits Visits, mailer Mailer, plans Plans, repo Store, appBaseURL string) *Service {
	return &Service{db: db, tx: tx, forms: forms, visits: visits, mail: mailer, plans: plans, repo: repo, appBaseURL: appBaseURL, now: time.Now}
}

// Bookings — подтверждение брони внутри транзакции приёма (фаза 27). Реализация —
// *booking.Confirmer. Интерфейс объявлен здесь, у потребителя: приём ответа знает про
// бронь ровно две вещи — придержать место и привязать его к ответу.
type Bookings interface {
	// Reserve проверяет бронь и держит место ДО вставки строки ответа: время записи
	// уезжает в сам ответ, и узнать его надо раньше.
	Reserve(ctx context.Context, tx pgx.Tx, bookingID, formID, submissionID uuid.UUID) (domain.SlotHold, error)
	// Attach привязывает бронь к принятому ответу — ПОСЛЕ вставки: внешний ключ
	// требует, чтобы строка ответа уже существовала.
	Attach(ctx context.Context, tx pgx.Tx, bookingID, submissionID uuid.UUID) error
	// CancelLink — адрес страницы отмены для этой брони. Спрашивается у модуля
	// записи, а не собирается здесь: подпись ссылки требует секрета, и знать его
	// приёму ответа незачем.
	CancelLink(bookingID uuid.UUID) string
}

// BookingGuard — сколько живых будущих записей держит ответ (фаза 27). Реализация —
// *booking.Guard; nil = записи на контуре нет, и стоп-кран не спрашивается.
type BookingGuard interface {
	FutureOfSubmission(ctx context.Context, submissionID uuid.UUID) (int64, error)
	// ZoneOfForm — пояс расписания формы для выгрузок; пусто = записи у формы нет.
	// Время записи автор читает в своём рабочем поясе, а не в UTC (решение владельца
	// 2026-09-03).
	ZoneOfForm(ctx context.Context, formID uuid.UUID) string
}

// WithBookingGuard подключает стоп-кран удаления ответа.
func (s *Service) WithBookingGuard(g BookingGuard) *Service {
	s.bookingGuard = g
	return s
}

// WithBookings подключает подтверждение записи. Без него форма с вопросом о времени
// отвергает ответ с бронью: молча принять ссылку на бронь, которую некому проверить,
// нельзя — ровно как с файлами.
func (s *Service) WithBookings(b Bookings) *Service {
	s.bookings = b
	return s
}

// WithNotifications подключает уведомления кабинета.
func (s *Service) WithNotifications(n Notifications) *Service {
	s.notes = n
	return s
}

// WithFiles подключает модуль файлов ответов. Без него форма с блоком file
// отвергает ответ с файлами (см. Submit) — молча принять ссылку, которую некому
// проверить, нельзя.
func (s *Service) WithFiles(f AnswerFiles) *Service {
	s.files = f
	return s
}

// Submit принимает ответ на форму slug. Порядок: резолв формы (черновик/нет → 404,
// приватное не раскрывается) → проверка «форма закрыта» (снята/дата → 410; лимит —
// транзакционно ниже) → валидация ответа против её схемы (нарушения →
// domain.AnswerErrors, транспорт кладёт карту полей в 422) → INSERT с привязкой к
// версии. Идемпотентность: повтор с тем же id (ретрай после сбоя сети) не создаёт
// второй строки и возвращается как успех — даже у заполненной формы (см. кап ниже).
//
// meta.VisitID (uuid.Nil = визита нет) отмечает конверсию — после успеха и
// best-effort, см. интерфейс Visits.
func (s *Service) Submit(ctx context.Context, slug string, id uuid.UUID, answers map[string]json.RawMessage, meta Meta) error {
	pf, err := s.forms.PublicForm(ctx, slug)
	if err != nil {
		return err
	}

	// Пароль формы (0047) — раньше всего остального: ответ на форму, которую этот
	// браузер не открывал, принимать нечем. Экран ввода пароля в рендерере эту
	// проверку НЕ заменяет: сюда приходят curl'ом, а не только со страницы.
	if err := s.forms.VerifyUnlock(pf.FormID, pf.PasswordSealed, meta.Unlock); err != nil {
		return err
	}

	// Форма закрыта владельцем (снята вручную или наступила дата) → приём отклонён
	// (410 «приём закрыт»). Лимит здесь НЕ проверяем: он enforce'ится транзакционно
	// под advisory-lock (жёсткий кап), иначе гонка пропустила бы лишние ответы.
	if domain.ClosedByStatusOrDate(pf.Status, pf.CloseAt, s.now().UTC()) {
		return domain.ErrFormClosed
	}

	// Опубликованная схема уже канонична и валидна (проверена при публикации);
	// разбираем её в типы для ValidateAnswers. Сбой здесь означал бы нарушенный
	// инвариант иммутабельности версии — это внутренняя ошибка, а не ошибка ввода
	// респондента.
	//
	// %v, а НЕ %w — намеренно: ValidateSchema возвращает ошибку с сентинелом
	// domain.ErrValidation, и сохранение его в цепочке уводило бы respond.go в 422 с
	// внутренним текстом наружу — респондент видел бы «не удалось разобрать схему:
	// json: unknown field ...». Обрыв цепочки роняет ошибку в default → 500: текст
	// скрыт от клиента и залогирован с request_id.
	if pf.ParseErr != nil {
		return fmt.Errorf("parse published schema for %s: %v", slug, pf.ParseErr)
	}
	schema := pf.Parsed
	// Нормализация вместо голой проверки (фаза 21): условная логика решает, какие
	// вопросы респондент видел, поэтому обязательность спрашивается только у видимых, а
	// ответы на скрытое отбрасываются молча — они не попадают ни в базу, ни в CSV, ни в
	// сводку. Клиент чистит ответ у себя тем же движком; доверия к нему нет, план
	// считается здесь заново. У формы без правил результат тот же, что до фазы.
	clean, err := domain.NormalizeAnswers(schema, answers)
	if err != nil {
		return err
	}

	// Файлы, названные в ответе, сверяются с базой и хранилищем ДО записи: та ли
	// форма, тот ли вопрос, лежит ли объект и совпал ли его размер с подписанным.
	// Без этой сверки в ответе оказалась бы ссылка на чужую или несуществующую
	// загрузку — и увидел бы это автор, а не тот, кто её подставил.
	files := domain.FileAnswers(schema, clean)
	if len(files) > 0 {
		if s.files == nil {
			return fmt.Errorf("%w: форма не принимает файлы", domain.ErrValidation)
		}
		if err := s.files.Verify(ctx, pf.FormID, id, files); err != nil {
			return err
		}
	}

	// Бронь, названная в ответе. Как и файлы, она сверяется с базой ДО записи: та ли
	// форма, тот ли клиент, не отменена ли, — иначе в ответе оказалась бы ссылка на
	// чужую или несуществующую запись.
	booking, err := slotAnswer(schema, clean)
	if err != nil {
		return err
	}
	if booking.BlockID != "" && s.bookings == nil {
		return fmt.Errorf("%w: форма не принимает запись на время", domain.ErrValidation)
	}

	consentRevision, err := s.acceptedConsent(ctx, pf.PublicFormRef, meta.ConsentRevision)
	if err != nil {
		return err
	}

	answersJSON, err := json.Marshal(clean)
	if err != nil {
		return fmt.Errorf("marshal answers: %w", err)
	}
	metaJSON, err := json.Marshal(map[string]string{
		"user_agent": truncate(meta.UserAgent, maxMetaFieldLen),
		"referer":    truncate(meta.Referer, maxMetaFieldLen),
	})
	if err != nil {
		return fmt.Errorf("marshal meta: %w", err)
	}

	// Квота тарифа (фаза 17). Спрашивается ПЕРЕД вставкой и ни при каком исходе
	// не отменяет приём: респондент не знает, что у владельца формы есть тариф,
	// и отказ здесь потерял бы данные КЛИЕНТА за неоплату ВЛАДЕЛЬЦЕМ (ADR §10).
	// Сбой самой проверки (нет подписки, битые limits) — тем более не повод: он
	// уходит в лог, а ответ считается «в пределах квоты», то есть щедро.
	in := NewSubmission{
		ID:          id,
		FormID:      pf.FormID,
		VersionID:   pf.VersionID,
		Answers:     answersJSON,
		Meta:        metaJSON,
		WorkspaceID: pf.WorkspaceID,
		// Ревизия согласия пишется в ту же строку, что ответ: ответа без следа согласия
		// на форме с включённым согласием не бывает (design/privacy-consent.md §3.4).
		ConsentRevisionID: consentRevision,
	}
	// Визит сохраняется как прислан: без FK, неизвестный id просто не даст меток
	// (читается LEFT JOIN по визиту этой же формы).
	if meta.VisitID != uuid.Nil {
		vid := meta.VisitID
		in.VisitID = &vid
	}
	if d, e := s.plans.CheckWorkspace(ctx, pf.WorkspaceID, entitlements.SubmissionsPerMonth); e != nil {
		httpserver.LoggerFrom(ctx).Error("quota not checked, submission accepted as within quota",
			slog.String("workspace_id", pf.WorkspaceID.String()),
			slog.String("error", e.Error()))
		// Проверки не было — период считаем сами; расход при несостоявшейся
		// проверке всё равно best-effort.
		in.Period = s.plans.PeriodStart()
	} else {
		in.OverQuota = !d.Allowed
		// Период берём ИЗ РЕШЕНИЯ, а не читаем часы второй раз: два независимых
		// чтения расходятся на границе месяца — проверка смотрит счётчик нового
		// периода, а инкремент уезжает в закрытый старый.
		in.Period = d.Period
	}

	// inserted — была ли вставлена НОВАЯ строка (n > 0). false = идемпотентный ретрай
	// (тот же id): ответ уже принят, повторно ни считать лимит, ни слать письмо не надо.
	var inserted bool

	// ТРАНЗАКЦИЯ НУЖНА НЕ ВСЕГДА, и это не микрооптимизация: приём ответа — самый
	// нагруженный путь продукта, а у формы без лимита, файлов и записи вставка одна.
	//
	// До фазы 27 здесь стоял switch по парам «лимит × файлы». Третья причина открывать
	// транзакцию превратила бы его в восемь веток с повторами внутри, поэтому ветвление
	// снято: причины перечислены, шаги внутри — под своими условиями.
	needsTx := pf.ResponseLimit != nil || len(files) > 0 || booking.BlockID != ""
	if !needsTx {
		n, err := s.repo.InsertSubmission(ctx, s.db, in)
		if err != nil {
			return err
		}
		inserted = n > 0
	} else if err := s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		// ⚠ ПОРЯДОК ЛОКОВ ФИКСИРОВАН: сначала форма (жёсткий кап лимита), потом слот
		// (подтверждение брони). Два лока, взятых в обратном порядке двумя приёмами,
		// дают дедлок — и увидеть его можно только под нагрузкой.
		if pf.ResponseLimit != nil {
			if err := s.repo.LockFormForSubmit(ctx, tx, pf.FormID); err != nil {
				return err
			}
		}

		// Бронь придерживается ДО вставки: время записи уезжает В САМ ОТВЕТ, и
		// узнать его надо раньше, чем строка ответа уйдёт в базу.
		if booking.BlockID != "" {
			held, err := s.bookings.Reserve(ctx, tx, booking.BookingID, pf.FormID, id)
			if err != nil {
				return err
			}
			// ⚠ ЗНАЧЕНИЕ ОТВЕТА ПЕРЕПИСЫВАЕТСЯ СЕРВЕРОМ: на проводе приезжал id
			// брони, в базе лежит ВРЕМЯ (design/booking.md §5.6). Поверить телу
			// запроса значило бы позволить записаться на время, которого никто не
			// бронировал.
			slotValue, err := json.Marshal(held.StartsAt.UTC().Format(time.RFC3339))
			if err != nil {
				return fmt.Errorf("marshal slot answer: %w", err)
			}
			clean[booking.BlockID] = slotValue
			if in.Answers, err = json.Marshal(clean); err != nil {
				return fmt.Errorf("marshal answers: %w", err)
			}
			booking.StartsAt = held.StartsAt
			booking.DurationMinutes, booking.Timezone = held.DurationMinutes, held.Timezone
		}

		n, err := s.repo.InsertSubmission(ctx, tx, in)
		if err != nil {
			return err
		}
		// n == 0 — идемпотентный ретрай: ответ уже принят. Заявление файлов и
		// привязка брони всё равно повторяются — оба узнают свой же ответ и второго
		// места не занимают; лимит же проходит МИМО (форма уже приняла этот ответ).
		inserted = n > 0

		if pf.ResponseLimit != nil && inserted {
			count, err := s.repo.CountSubmissions(ctx, tx, pf.FormID)
			if err != nil {
				return err
			}
			if count > int64(*pf.ResponseLimit) {
				return domain.ErrFormClosed // откат вставки: форма только что заполнилась
			}
		}
		if len(files) > 0 {
			if err := s.files.Claim(ctx, tx, id, pf.FormID, files); err != nil {
				return err
			}
		}
		if booking.BlockID != "" {
			if err := s.bookings.Attach(ctx, tx, booking.BookingID, id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		return err
	}

	// Побочные эффекты — ПОСЛЕ приёма и best-effort (ни один не имеет права уронить
	// принятый ответ): конверсия визита и уведомление владельцу. Только для новой
	// строки (не для идемпотентного ретрая).
	s.markVisitSubmitted(ctx, pf.FormID, meta.VisitID)
	s.dropPartial(ctx, pf.FormID, meta.VisitID)
	if inserted && (pf.NotifyOnSubmission || pf.NotifyRespondent) {
		s.notifyMail(ctx, pf, id, slug, schema, clean)
	}
	// Повод кабинета о новых ответах ставится ВСЕГДА: тумблеры выше про письма, а
	// лента — вид человека на своё хозяйство, и выключать его автору формы нечем.
	// Сверхлимитный ответ повода не поднимает (ADR §10): в таблице ответов кабинета
	// такой строки не видно, и обещать её колокольчиком нельзя — про упёршуюся
	// квоту придёт свой повод.
	if inserted && !in.OverQuota {
		s.notifyNewSubmissions(ctx, pf, slug)
	}
	// А сверхлимитный — свой повод, и адресован он другим людям: тариф это дело
	// владельца пространства, редактор на него всё равно не ответит.
	if inserted && in.OverQuota {
		s.notifyOverQuota(ctx, pf, in.Period)
	}
	// Письмо о записи НЕ зависит от тумблеров уведомлений и от тарифа: без него у
	// респондента нет ссылки отмены, а значит, место не вернуть в оборот (§4.8 спеки).
	if inserted && booking.BlockID != "" {
		s.notifyBooking(ctx, pf.FormID, id, slug, schema, clean, booking)
	}
	return nil
}

// WebhookRecord — ответ, приведённый к телу вебхука (контракт v1): поля с типами
// и метаданные. Название формы едет здесь же — спросить его у forms доставке
// нечем: пользователя, чьё право можно проверить, на фоновом пути нет.
type WebhookRecord struct {
	FormTitle   string
	Fields      []domain.WebhookField
	FormVersion int
	CreatedAt   time.Time
}

// WebhookRow строит поля ответа для тела вебхука — ТОЙ ЖЕ моделью колонок, что
// выгрузка и таблица: иначе у вопроса «какие у формы поля» стало бы три ответа.
//
// ⚠ Прав НЕ проверяет по тем же основаниям, что SheetRow: у фоновой доставки нет
// пользователя, а id формы и ответа приезжают из строки очереди, которую завели
// мы сами. Из обработчика приватного API этот метод не зовут.
//
// pgx.ErrNoRows означает «доставлять нечего»: ответ удалён автором или скрыт
// тарифом.
func (s *Service) WebhookRow(ctx context.Context, formID, submissionID uuid.UUID) (WebhookRecord, error) {
	builder, sub, answers, err := s.deliveryRecord(ctx, formID, submissionID)
	if err != nil {
		return WebhookRecord{}, err
	}
	return WebhookRecord{
		FormTitle:   sub.FormTitle,
		Fields:      builder.WebhookFields(int(sub.FormVersion), answers),
		FormVersion: int(sub.FormVersion),
		CreatedAt:   sub.CreatedAt,
	}, nil
}

// deliveryRecord — общее начало обеих доставок: модель колонок по всем
// опубликованным версиям, сам ответ и его разобранные ответы. Одна на два
// вида цели: две копии этой сборки разъехались бы на первой же правке
// (пояс расписания, имена файлов).
func (s *Service) deliveryRecord(ctx context.Context, formID, submissionID uuid.UUID) (*domain.CSVBuilder, Submission, map[string]json.RawMessage, error) {
	versions, err := s.forms.PublishedVersions(ctx, formID)
	if err != nil {
		return nil, Submission{}, nil, err
	}
	vs, err := parseVersions(formID, versions)
	if err != nil {
		return nil, Submission{}, nil, err
	}

	sub, err := s.repo.GetForDelivery(ctx, s.db, formID, submissionID)
	if err != nil {
		return nil, Submission{}, nil, err
	}
	var answers map[string]json.RawMessage
	if err := json.Unmarshal(sub.Answers, &answers); err != nil {
		return nil, Submission{}, nil, fmt.Errorf("unmarshal answers of submission %s: %w", submissionID, err)
	}

	builder := domain.NewCSVBuilder(vs)
	builder.WithSchedule(s.scheduleZone(ctx, formID))
	// Имена файлов — только если у формы вообще есть вопрос-файл: та же
	// экономия, что в выгрузке.
	if s.files != nil && hasFileBlock(vs) {
		files, err := s.files.InfoByForm(ctx, formID)
		if err != nil {
			return nil, Submission{}, nil, err
		}
		builder.WithFiles(files)
	}
	return builder, sub, answers, nil
}

// SheetPage — пачка ответов, приведённых к строкам внешней таблицы: колонки
// один раз на всю пачку и строки со своими id.
//
// id не украшение: доставщик раскладывает пачку по СВОЕМУ списку — порядок
// назвала очередь связки, — а ответ, которого в пачке не оказалось, удалён
// автором или скрыт тарифом и снимается с очереди без записи в лист.
type SheetPage struct {
	Columns []domain.SheetColumn
	Rows    []SheetRow
}

// SheetRow — одна строка пачки.
type SheetRow struct {
	ID     uuid.UUID
	Values []string
}

// SheetRows строит строки НАЗВАННЫХ ответов формы для внешней таблицы — той же
// моделью колонок, что выгрузка CSV и сводка (иначе у вопроса «какие у формы
// вопросы» стало бы два ответа).
//
// Пачкой, а не по ответу за раз: у Таблиц один values.append увозит все строки
// тика разом, и собирать их поштучно значило бы читать версии формы и справочник
// файлов заново на каждую строку переноса.
//
// ⚠ Прав НЕ проверяет: у фоновой доставки нет пользователя, чьё право можно
// спросить. Безопасность держится на том, ОТКУДА приходят id: форма — из строки
// form_integrations, которую завёл человек с правом на неё, ответы — из очереди
// этой связки, которую заполнили мы сами. Из обработчика приватного API этот
// метод не зовут.
func (s *Service) SheetRows(ctx context.Context, formID uuid.UUID, ids []uuid.UUID) (SheetPage, error) {
	versions, err := s.forms.PublishedVersions(ctx, formID)
	if err != nil {
		return SheetPage{}, err
	}
	vs, err := parseVersions(formID, versions)
	if err != nil {
		return SheetPage{}, err
	}

	subs, err := s.repo.ListForDelivery(ctx, s.db, formID, ids)
	if err != nil {
		return SheetPage{}, err
	}

	builder := domain.NewCSVBuilder(vs)
	builder.WithSchedule(s.scheduleZone(ctx, formID))
	if s.files != nil && hasFileBlock(vs) {
		files, err := s.files.InfoByForm(ctx, formID)
		if err != nil {
			return SheetPage{}, err
		}
		builder.WithFiles(files)
	}

	page := SheetPage{Columns: builder.SheetColumns(), Rows: make([]SheetRow, 0, len(subs))}
	for _, sub := range subs {
		var answers map[string]json.RawMessage
		if err := json.Unmarshal(sub.Answers, &answers); err != nil {
			return SheetPage{}, fmt.Errorf("unmarshal answers of submission %s: %w", sub.ID, err)
		}
		page.Rows = append(page.Rows, SheetRow{
			ID:     sub.ID,
			Values: builder.SheetRow(sub.ID.String(), sub.CreatedAt, int(sub.FormVersion), answers),
		})
	}
	return page, nil
}

// notifyNewSubmissions ставит повод кабинета «на форме новые ответы». Повторы
// склеиваются в одну непрочитанную строку со счётчиком — это делает сам запрос
// постановки, здесь про склейку знать не надо.
//
// Best-effort и ПОСЛЕ приёма, как markVisitSubmitted и письмо владельцу: краш в
// окне между коммитом ответа и постановкой теряет уведомление, данные целы (ответ
// лежит в таблице). Название формы и её адрес берём из уже прочитанной публичной
// формы — отдельного запроса на это не делаем.
func (s *Service) notifyNewSubmissions(ctx context.Context, pf forms.PublicForm, slug string) {
	if s.notes == nil {
		return
	}
	err := s.notes.Notify(ctx, s.db, notify.Event{
		WorkspaceID: pf.WorkspaceID,
		Kind:        notify.KindNewSubmissions,
		FormID:      pf.FormID,
		SubjectID:   pf.FormID,
		Payload:     notify.Payload{FormTitle: pf.CabinetName, FormSlug: slug},
	})
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("new submissions notification not stored",
			slog.String("form_id", pf.FormID.String()), slog.String("error", err.Error()))
	}
}

// notifyOverQuota ставит повод «ответы пошли сверх лимита тарифа». Субъект —
// ПРОСТРАНСТВО, а не форма: лимит считается по пространству, и три формы,
// упёршиеся в общий потолок, — одна новость, а не три.
//
// Период уезжает в снимок, потому что по нему рвётся склейка: непрочитанная
// строка прошлого месяца не должна копить счётчик дальше, иначе «сверх лимита:
// 43» означало бы сумму за два месяца. Разрывает её сама постановка (запрос
// InsertNotifications), здесь достаточно честно назвать период.
func (s *Service) notifyOverQuota(ctx context.Context, pf forms.PublicForm, period time.Time) {
	if s.notes == nil {
		return
	}
	err := s.notes.Notify(ctx, s.db, notify.Event{
		WorkspaceID: pf.WorkspaceID,
		Kind:        notify.KindOverQuota,
		// FormID не заполняется: повод про пространство, и каскад формы ему не
		// нужен — форму удалят, а счёт за месяц останется.
		SubjectID: pf.WorkspaceID,
		Payload:   notify.Payload{Period: period.Format("2006-01")},
	})
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("over quota notification not stored",
			slog.String("workspace_id", pf.WorkspaceID.String()), slog.String("error", err.Error()))
	}
}

// notifyMail ставит письма, поводом для которых стал принятый ответ: владельцу
// формы и/или респонденту. Владельца резолвим ОДИН раз на оба письма — строка
// нужна обоим (тариф, заголовки формы, бланки), а поход в базу стоит одинаково.
//
// Вызывается ПОСЛЕ приёма и best-effort, как markVisitSubmitted: уведомление —
// вторичный эффект, и уронить из-за него принятый ответ нельзя (респондент увидел
// бы «не удалось отправить» на записанном ответе). Поэтому НЕ в транзакции приёма:
// это размен строгой атомарности «ответ+письмо» на неприкосновенность hot-path и
// принятого ответа. Цена — краш в узком окне между коммитом ответа и enqueue теряет
// уведомление; данные целы (владелец видит ответ в таблице). Любой сбой уходит в
// лог с request_id — ответ уже принят.
func (s *Service) notifyMail(
	ctx context.Context,
	pf forms.PublicForm,
	submissionID uuid.UUID,
	slug string,
	schema domain.FormSchema,
	answers map[string]json.RawMessage,
) {
	owner, err := s.forms.SubmissionOwner(ctx, pf.FormID)
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("submission owner not resolved for notification",
			slog.String("form_id", pf.FormID.String()), slog.String("error", err.Error()))
		return
	}
	if pf.NotifyOnSubmission {
		s.notifyOwner(ctx, pf.FormID, submissionID, slug, owner, schema, answers)
	}
	if pf.NotifyRespondent {
		s.notifyRespondent(ctx, pf.FormID, submissionID, slug, owner, schema, answers)
	}
}

// notifyOwner ставит владельцу письмо о новом ответе — ОДНО ПИСЬМО НА ОДИН ответ
// (ADR §10, отмена троттлинг-дайджеста 2026-08-30). Ссылка ведёт в таблицу ответов
// кабинета.
//
// Защиты от шквала писем здесь нет: планы поток ответов не ограничивают, и
// единственный потолок — rate limit приёма. Переливной клапан (порог на форму, сверх
// которого остаток снова склеивается) записан в BACKLOG.md; механика коалесинга в
// outbox для него сохранена и стоит без потребителей. Потолок писем РЕСПОНДЕНТАМ
// (notifyRespondent) — не он: тот стоит за адресатом, который нам не давал согласия.
func (s *Service) notifyOwner(
	ctx context.Context,
	formID, submissionID uuid.UUID,
	slug string,
	owner forms.Owner,
	schema domain.FormSchema,
	answers map[string]json.RawMessage,
) {
	link := s.appBaseURL + "/forms/" + slug + "/responses"
	msg := mail.EmailMessage{
		To:       owner.Email,
		Template: mail.TemplateSubmissionNew,
		Data:     map[string]any{"form_title": owner.Title, "link": link},
	}
	// Свой текст письма — платная настройка (0042), поэтому право спрашивается ЗДЕСЬ,
	// на каждой отправке, а не один раз при сохранении: даунгрейд обязан вернуть
	// дефолтное письмо сам, ничего не стирая, — тот же приём, что у бейджа.
	//
	// Перебивки едут в payload строки outbox: письмо уходит ПОЗЖЕ постановки, и
	// диспетчер за настройкой формы уже не пойдёт.
	if n := s.notifyEmailFor(ctx, owner); n != nil {
		// Подстановки разворачиваются ЗДЕСЬ, а не при доставке (mentions.md §10):
		// схема уже разобрана, ответ уже нормализован (скрытое логикой отброшено), и
		// в payload уезжает готовый плоский текст — диспетчер за ними не пойдёт.
		//
		// Тема разворачивается отдельной функцией: она обязана остаться ОДНОЙ строкой,
		// потому что уезжает в заголовок письма, а подставляется в неё недоверенный
		// ввод респондента.
		mc := domain.NewMentionContext(schema, answers,
			s.mentionFiles(ctx, submissionID, schema, n.Subject, n.Body))
		msg.FromName, msg.ReplyTo = n.FromName, n.ReplyTo
		msg.Subject = domain.MentionLine(n.Subject, mc)
		msg.Body = domain.MentionText(n.Body, mc)
		// Вложение называется ССЫЛКОЙ, а не файлом: печатает его диспетчер при
		// доставке (ADR §10). Печатать здесь значило бы держать браузер на пути
		// приёма ответа.
		if n.AttachPDF {
			msg.Attachments = []mail.AttachmentRef{{
				Kind:         mail.KindSubmissionPDF,
				FormID:       formID.String(),
				SubmissionID: submissionID.String(),
			}}
		}
	}
	if err := s.mail.EnqueueEmail(ctx, s.db, msg); err != nil {
		httpserver.LoggerFrom(ctx).Warn("owner notification not enqueued",
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
	}
}

// notifyRespondent ставит письмо ЧЕЛОВЕКУ, заполнившему форму
// (docs/design/respondent-email.md). От письма владельцу отличается тем, что
// адресата мы узнаём из ответа, а не из аккаунта, — отсюда четыре условия, каждое
// из которых молча отменяет письмо:
//
//  1. обвязка не настроена на контуре (нет адреса формы для подвала или потолка);
//  2. тариф не разрешает — здесь ОТКАЗ, а не отступление к дефолтному тексту, как
//     у владельца: неподтверждённое право означает не «письмо не тем текстом», а
//     письмо постороннему человеку за наш счёт;
//  3. адреса нет (вопрос не выбран, удалён, не типа email, ответ пуст) — самый
//     частый случай и совершенно штатный;
//  4. выбран потолок писем на форму за окно.
//
// Ответ во всех четырёх случаях уже принят, и письмо владельцу уходит своим путём.
func (s *Service) notifyRespondent(
	ctx context.Context,
	formID, submissionID uuid.UUID,
	slug string,
	owner forms.Owner,
	schema domain.FormSchema,
	answers map[string]json.RawMessage,
) {
	log := httpserver.LoggerFrom(ctx)
	if s.formBaseURL == "" || s.respondentLimiter == nil {
		log.Warn("respondent notification is not configured on this deployment",
			slog.String("form_id", formID.String()))
		return
	}
	d, err := s.plans.CheckWorkspace(ctx, owner.WorkspaceID, entitlements.FormRespondentEmail)
	if err != nil {
		log.Warn("plan lookup for respondent notification",
			slog.String("workspace_id", owner.WorkspaceID.String()), slog.String("error", err.Error()))
		return
	}
	if !d.Allowed {
		return
	}
	r := owner.RespondentEmail
	to := domain.RespondentAddress(r, schema, answers)
	if to == "" {
		return
	}
	// Потолок спрашивается ПОСЛЕДНИМ из условий: ответы без адреса не имеют права
	// тратить окно формы, иначе анкета, где почту спрашивают необязательным
	// вопросом, выедала бы его отказами.
	if !s.respondentLimiter.Allow(formID.String()) {
		log.Warn("respondent notification throttled, email skipped",
			slog.String("form_id", formID.String()))
		return
	}
	// Заголовок в подвале — ПУБЛИЧНЫЙ (owner.PublicTitle), а не внутреннее имя из
	// кабинета: респондент заполнял форму, которая называлась так, и «Анкета
	// (копия 2)» в его письме читалась бы как чужая кухня.
	msg := mail.EmailMessage{
		To:       to,
		Template: mail.TemplateRespondentReceipt,
		Data: map[string]any{
			"form_title": owner.PublicTitle,
			// Адрес формы собирается ровно так же, как его собирает og:url публичной
			// страницы (forms/public_page.go) и ссылка на экране «Поделиться»:
			// ${origin}/r/{slug}. Без "/r/" ссылка ведёт в никуда, и увидеть это
			// можно только письмом — юниты подвала сверяют строку с собой же.
			"form_link": s.formBaseURL + "/r/" + slug,
		},
	}
	if !r.Empty() {
		mc := domain.NewMentionContext(schema, answers,
			s.mentionFiles(ctx, submissionID, schema, r.Subject, r.Body))
		msg.FromName, msg.ReplyTo = r.FromName, r.ReplyTo
		msg.Subject = domain.MentionLine(r.Subject, mc)
		msg.Body = domain.MentionText(r.Body, mc)
		if r.AttachPDF {
			msg.Attachments = []mail.AttachmentRef{{
				Kind:         mail.KindSubmissionPDF,
				FormID:       formID.String(),
				SubmissionID: submissionID.String(),
			}}
		}
	}
	if err := s.mail.EnqueueEmail(ctx, s.db, msg); err != nil {
		log.Warn("respondent notification not enqueued",
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
	}
}

// mentionFiles — имена файлов ответа, нужные подстановке «Все ответы»: без них
// вопрос-файл читался бы в письме как оставшийся без ответа.
//
// Поход в базу трижды обусловлен — сборка с файлами, форма с вопросом-файлом, письмо
// с «Все ответы»: письмо ставится на самом нагруженном пути продукта, и лишний
// запрос на каждый ответ здесь не бесплатен. Сбой запроса даёт nil, а не отказ:
// уведомление без имён файлов дешевле, чем непришедшее.
func (s *Service) mentionFiles(
	ctx context.Context,
	submissionID uuid.UUID,
	schema domain.FormSchema,
	subject, body []domain.Span,
) map[string]domain.AnswerFile {
	if s.files == nil || !domain.HasFileQuestion(schema) {
		return nil
	}
	if !domain.MentionsAllAnswers(body) && !domain.MentionsAllAnswers(subject) {
		return nil
	}
	files, err := s.files.InfoBySubmissions(ctx, []uuid.UUID{submissionID})
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("file names for notification not resolved",
			slog.String("submission_id", submissionID.String()), slog.String("error", err.Error()))
		return nil
	}
	return files
}

// notifyEmailFor — настройка письма, действующая прямо сейчас: nil значит «слать
// дефолтным шаблоном».
//
// Сбой опроса тарифа даёт дефолтное письмо, а не отказ: уведомление обязано уйти, а
// «не тем текстом» дешевле, чем «никаким». Тот же выбор, что у бейджа (лишний бренд
// дешевле пятисотки), и обратный тому, что у сбора черновиков.
func (s *Service) notifyEmailFor(ctx context.Context, owner forms.Owner) *domain.NotifyEmail {
	if owner.NotifyEmail == nil {
		return nil
	}
	d, err := s.plans.CheckWorkspace(ctx, owner.WorkspaceID, entitlements.FormNotifyEmail)
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("plan lookup for notification email",
			slog.String("workspace_id", owner.WorkspaceID.String()), slog.String("error", err.Error()))
		return nil
	}
	if !d.Allowed {
		return nil
	}
	return owner.NotifyEmail
}

// markVisitSubmitted отмечает конверсию визита. Вызывается ПОСЛЕ успешного приёма и
// НЕ возвращает ошибку: ответ уже в базе, и уронить его из-за аналитики нельзя —
// респондент увидел бы «не удалось отправить» на принятом ответе и отправил бы
// второй раз. Сбой уходит в лог с request_id, там его и видно.
//
// uuid.Nil — штатный случай (бикон не дошёл, старый бандл рендерера не шлёт
// visit_id), запроса не делаем. Неизвестный или подделанный id даёт 0 строк — это
// тоже не ошибка (запрос ограничен form_id, чужой визит не пометить).
func (s *Service) markVisitSubmitted(ctx context.Context, formID, visitID uuid.UUID) {
	if visitID == uuid.Nil {
		return
	}
	if err := s.visits.MarkSubmitted(ctx, formID, visitID); err != nil {
		httpserver.LoggerFrom(ctx).Warn("visit not marked submitted",
			slog.String("form_id", formID.String()),
			slog.String("error", err.Error()))
	}
}

// dropPartial убирает черновик, ставший ответом. По тем же основаниям, что и
// markVisitSubmitted: ПОСЛЕ коммита приёма, без возврата ошибки — ответ уже принят,
// и уронить его из-за неубранного черновика нельзя.
//
// Не доехавший visit_id (uuid.Nil) — штатный случай: черновик останется и попадёт
// во вкладку «Незавершённые» рядом со своим же отправленным ответом. Погрешность
// записана; чистка по возрасту унесёт его сама.
func (s *Service) dropPartial(ctx context.Context, formID, visitID uuid.UUID) {
	if visitID == uuid.Nil {
		return
	}
	if _, err := s.repo.DeletePartialByVisit(ctx, s.db, visitID, formID); err != nil {
		httpserver.LoggerFrom(ctx).Warn("partial not deleted after submit",
			slog.String("form_id", formID.String()),
			slog.String("error", err.Error()))
	}
}

// SavePartial сохраняет черновик — то, что респондент набрал и не отправил (спека
// §10.2). Публичный путь: авторизации нет, зато есть три отказа.
//
// Порядок повторяет приём ответа и запись визита: резолв формы (черновик/нет → 404),
// «форма закрыта» → 410, версия из тела против опубликованной. Сверх этого —
// ТУМБЛЕР: выключен или тариф его больше не разрешает → 404, ручки для этой формы
// всё равно что нет. 404, а не 403: существование настройки чужой формы посторонним
// не раскрывается.
//
// ВАЛИДАЦИЯ МЯГКАЯ, и это несущее решение. Черновик неполон по определению:
// требовать обязательные поля значило бы не сохранить ничего. Проверяется только
// то, что защищает нас: размер (транспорт), известность блока в схеме версии и
// строковый тип значения. Неизвестные ключи молча отбрасываются — схема могла
// смениться, а ронять автосохранение из-за этого незачем.
func (s *Service) SavePartial(ctx context.Context, slug string, p PartialInput) error {
	pf, err := s.forms.PublicForm(ctx, slug)
	if err != nil {
		return err
	}
	// Пароль формы (0047): черновик — это те же ответы респондента, и складывать их
	// автору от того, кто формы не открывал, незачем.
	if err := s.forms.VerifyUnlock(pf.FormID, pf.PasswordSealed, p.Unlock); err != nil {
		return err
	}
	if domain.FormClosed(pf.Status, pf.CloseAt, pf.ResponseLimit, pf.SubmissionCount, s.now().UTC()) {
		return domain.ErrFormClosed
	}
	on, err := s.forms.CollectPartial(ctx, pf.WorkspaceID, pf.CollectPartial)
	if err != nil {
		return err
	}
	if !on {
		return domain.ErrNotFound
	}
	if p.Version != pf.Version {
		return fmt.Errorf("%w: форма переиздана", domain.ErrValidation)
	}

	if pf.ParseErr != nil {
		return fmt.Errorf("parse published schema of %s: %v", slug, pf.ParseErr)
	}
	schema := pf.Parsed
	answers := domain.FilterDraftAnswers(schema, p.Answers)
	raw, err := json.Marshal(answers)
	if err != nil {
		return fmt.Errorf("marshal partial answers: %w", err)
	}
	return s.repo.UpsertPartial(ctx, s.db, p.VisitID, pf.FormID, pf.VersionID, raw, p.LastBlockID)
}

// CleanupPartials удаляет черновики старше срока хранения. Зовётся периодической
// задачей; возвращает число удалённых для лога.
func (s *Service) CleanupPartials(ctx context.Context) (int64, error) {
	return s.repo.DeleteOldPartials(ctx, s.db, s.now().UTC().Add(-PartialTTL))
}

// PartialPage — страница черновиков формы, курсор на следующую (nil на последней)
// и общее число. Files здесь нет: файлы в черновик не входят вовсе (спека §10.2) —
// слот файла выдаётся отдельным потоком и считается в квоту хранилища.
type PartialPage struct {
	Partials   []Partial
	NextCursor *TimeCursor
	Total      int64
}

// ListPartialsForForm — страница черновиков формы для её автора.
//
// Порядок проверок тот же, что у листинга ответов, плюс гейт: сперва forms.Get
// (чужая/несуществующая → 404 раньше, чем разговор о тарифе), затем право
// SubmissionsPartial. Гейт здесь ВТОРОЙ раз после тумблера, и это не
// перестраховка: тумблер мог остаться включённым с прежнего плана, а даунгрейд
// обязан закрывать и показ, не дожидаясь, пока владелец про него вспомнит.
func (s *Service) ListPartialsForForm(ctx context.Context, userID, formID uuid.UUID, after *TimeCursor, limit int) (PartialPage, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return PartialPage{}, err
	}
	d, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.SubmissionsPartial)
	if err != nil {
		return PartialPage{}, err
	}
	if !d.Allowed {
		return PartialPage{}, domain.ErrPlanRequired
	}
	limit = clampLimit(limit)

	total, err := s.repo.CountPartials(ctx, s.db, formID)
	if err != nil {
		return PartialPage{}, err
	}

	// limit+1: «лишняя» строка означает, что есть следующая страница; сам её в
	// ответ не отдаём, а превращаем в курсор (как у листинга ответов).
	rows, err := s.repo.ListPartials(ctx, s.db, formID, int32(limit+1), after)
	if err != nil {
		return PartialPage{}, err
	}
	page := PartialPage{Partials: rows, Total: total}
	if len(rows) > limit {
		last := rows[limit-1]
		page.Partials = rows[:limit]
		page.NextCursor = &TimeCursor{At: last.UpdatedAt, ID: last.VisitID}
	}
	return page, nil
}

// FeedPage — страница вкладки «Все ответы»: отправленные и незавершённые одним
// списком по времени.
type FeedPage struct {
	Rows       []FeedRow
	NextCursor *TimeCursor
	// Total — сколько строк ВИДНО в этой ленте: ответы (без сверхлимитных) плюс
	// черновики, если форма их сейчас собирает.
	Total int64
	// Hidden — ответы, скрытые квотой тарифа (0014). Черновиков не касается: они в
	// квоту не считаются вовсе.
	Hidden int64
	Files  map[string]domain.AnswerFile
}

// ListFeedForForm — страница вкладки «Все ответы» (спека §11).
//
// ЧЕРНОВИКИ ПОДМЕШИВАЮТСЯ, ТОЛЬКО ЕСЛИ ФОРМА ИХ СЕЙЧАС СОБИРАЕТ (тумблер плюс
// право тарифа) — тем же вопросом, каким это решается при отдаче публичной формы.
// Иначе «Все ответы» показывали бы ровно то, что прячет соседняя вкладка
// «Частичные»: у формы со снятым тумблером черновики ещё лежат в базе до чистки, и
// показать их здесь значило бы обойти и тумблер, и гейт одним переключением вкладки.
//
// Гейта на самой ленте поэтому нет: без права подмешивать нечего, и вкладка молча
// вырождается в список отправленных — то же, что «Законченные».
func (s *Service) ListFeedForForm(ctx context.Context, userID, formID uuid.UUID, after *TimeCursor, limit int) (FeedPage, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return FeedPage{}, err
	}
	withPartials, err := s.forms.CollectPartial(ctx, form.WorkspaceID, form.CollectPartial)
	if err != nil {
		return FeedPage{}, err
	}
	if !withPartials {
		// Ленты нет — есть обычный листинг ответов. Второй раз объяснять «где
		// начинается страница» нечем: курсор ленты составной, и первая же
		// подгрузка на смешанном пути разошлась бы с одноколоночным.
		return s.feedFromSubmissions(ctx, userID, formID, after, limit)
	}

	limit = clampLimit(limit)
	total, hidden, err := s.repo.CountSubmissionsForCabinet(ctx, s.db, formID)
	if err != nil {
		return FeedPage{}, err
	}
	partials, err := s.repo.CountPartials(ctx, s.db, formID)
	if err != nil {
		return FeedPage{}, err
	}

	rows, err := s.repo.ListFeed(ctx, s.db, formID, int32(limit+1), after)
	if err != nil {
		return FeedPage{}, err
	}
	page := FeedPage{Rows: rows, Total: total + partials, Hidden: hidden}
	if len(rows) > limit {
		last := rows[limit-1]
		page.Rows = rows[:limit]
		page.NextCursor = &TimeCursor{At: last.At, ID: last.ID}
	}
	if err := s.attachFiles(ctx, &page); err != nil {
		return FeedPage{}, err
	}
	return page, nil
}

// feedFromSubmissions — та же лента из одних отправленных ответов: форма
// незавершённые не собирает. Идёт по ленточному запросу, а не по листингу ответов,
// ровно ради курсора: он обязан остаться составным, иначе страницы одной и той же
// вкладки склеивались бы по разным правилам.
func (s *Service) feedFromSubmissions(ctx context.Context, userID, formID uuid.UUID, after *TimeCursor, limit int) (FeedPage, error) {
	limit = clampLimit(limit)
	total, hidden, err := s.repo.CountSubmissionsForCabinet(ctx, s.db, formID)
	if err != nil {
		return FeedPage{}, err
	}
	rows, err := s.repo.ListFeed(ctx, s.db, formID, int32(limit+1), after)
	if err != nil {
		return FeedPage{}, err
	}
	// Черновики отбрасываются ПОСЛЕ выборки: запрос один на оба случая, а строк
	// черновиков у формы без сбора либо нет вовсе, либо они доживают срок чистки.
	kept := rows[:0]
	for _, r := range rows {
		if r.Kind == feedKindSubmission {
			kept = append(kept, r)
		}
	}
	page := FeedPage{Rows: kept, Total: total, Hidden: hidden}
	if len(kept) > limit {
		last := kept[limit-1]
		page.Rows = kept[:limit]
		page.NextCursor = &TimeCursor{At: last.At, ID: last.ID}
	}
	if err := s.attachFiles(ctx, &page); err != nil {
		return FeedPage{}, err
	}
	return page, nil
}

// attachFiles добавляет к странице имена приложенных файлов — одним запросом на всю
// страницу, как в листинге ответов. Черновики файлов не заявляют вовсе (спека
// §10.2), поэтому спрашиваются только строки ответов.
func (s *Service) attachFiles(ctx context.Context, page *FeedPage) error {
	if s.files == nil {
		return nil
	}
	ids := make([]uuid.UUID, 0, len(page.Rows))
	for _, r := range page.Rows {
		if r.Kind == feedKindSubmission {
			ids = append(ids, r.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	files, err := s.files.InfoBySubmissions(ctx, ids)
	if err != nil {
		return err
	}
	page.Files = files
	return nil
}

// Метки строк ленты. Зеркалят литералы в queries.sql (ListFeedFirstPage) и поле
// `kind` в JSON кабинета — разъехавшись, они молча превратили бы половину ленты в
// строки не того вида.
const (
	feedKindSubmission = "submission"
	feedKindPartial    = "partial"
)

// DeletePartialForForm удаляет один черновик (спека §10.6: тот же жест, что и
// удаление ответа). Спрашивается ActionSubmissionDelete — то же действие матрицы
// прав, что у ответа: это чужой набранный текст, и разница между отправленным и
// неотправленным для права его стирать несущественна.
//
// Гейта тарифа здесь НЕТ намеренно: удалить собранное обязан мочь и тот, у кого
// показ уже закрыт даунгрейдом, — запрет убрать чужие данные был бы дефектом.
func (s *Service) DeletePartialForForm(ctx context.Context, userID, formID, visitID uuid.UUID) error {
	if _, err := s.forms.GetForAction(ctx, userID, formID, domain.ActionSubmissionDelete); err != nil {
		return err
	}
	n, err := s.repo.DeletePartial(ctx, s.db, visitID, formID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// ListForForm возвращает страницу ответов формы для её автора. Порядок: авторизация
// через forms.Get (чужая/нет формы → 404, приватное не раскрывается), затем чтение
// страницы. after — курсор предыдущей страницы (nil для первой). Общий счётчик
// считается всегда (кабинет показывает «N ответов»).
// GetForForm — ОДИН ответ с его файлами. Нужен окну ответа, открытому не из списка:
// карточка записи на полотне расписания знает только id ответа, а страница ответов
// показывает окно из уже загруженной страницы списка и ничего не запрашивает.
//
// Права — те же и тем же способом, что у списка: доступ даёт членство в пространстве
// ФОРМЫ, а id ответа из адреса правом не является (form_id стоит и в самом запросе).
func (s *Service) GetForForm(ctx context.Context, userID, formID, submissionID uuid.UUID) (Submission, map[string]domain.AnswerFile, error) {
	if _, err := s.forms.Get(ctx, userID, formID); err != nil {
		return Submission{}, nil, err
	}
	row, err := s.repo.SubmissionByID(ctx, s.db, submissionID, formID)
	if err != nil {
		return Submission{}, nil, err
	}
	if s.files == nil {
		return row, nil, nil
	}
	files, err := s.files.InfoBySubmissions(ctx, []uuid.UUID{row.ID})
	if err != nil {
		return Submission{}, nil, err
	}
	return row, files, nil
}

func (s *Service) ListForForm(ctx context.Context, userID, formID uuid.UUID, after *Cursor, limit int) (Page, error) {
	if _, err := s.forms.Get(ctx, userID, formID); err != nil {
		return Page{}, err
	}
	limit = clampLimit(limit)

	total, hidden, err := s.repo.CountSubmissionsForCabinet(ctx, s.db, formID)
	if err != nil {
		return Page{}, err
	}

	// limit+1: «лишняя» строка означает, что есть следующая страница; сам её в
	// ответ не отдаём, а превращаем в курсор.
	fetch := int32(limit + 1)
	var rows []Submission
	if after == nil {
		rows, err = s.repo.ListSubmissions(ctx, s.db, formID, fetch, domain.Period{})
	} else {
		rows, err = s.repo.ListSubmissionsAfter(ctx, s.db, formID, after.ID, fetch, domain.Period{})
	}
	if err != nil {
		return Page{}, err
	}

	page := Page{Submissions: rows, Total: total, Hidden: hidden}
	if len(rows) > limit {
		last := rows[limit-1]
		page.Submissions = rows[:limit]
		page.NextCursor = &Cursor{ID: last.ID}
	}

	// Файлы страницы — одним запросом на всю страницу, а не по ответу: тридцать
	// строк таблицы иначе дали бы тридцать поездок в базу.
	if s.files != nil {
		ids := make([]uuid.UUID, 0, len(page.Submissions))
		for _, r := range page.Submissions {
			ids = append(ids, r.ID)
		}
		files, err := s.files.InfoBySubmissions(ctx, ids)
		if err != nil {
			return Page{}, err
		}
		page.Files = files
	}
	return page, nil
}

// streamBatch — размер порции keyset-итерации по всем ответам формы. Память
// потребителя плоская (одна порция за раз) независимо от общего числа ответов — DoD
// «10k строк не растит память».
const streamBatch = 1000

// versionedSchemas — схемы всех опубликованных версий формы (с авторизацией доступа:
// чужая/несуществующая → 404). Общее начало выгрузки и сводки: обе строят своё
// представление по объединению версий (domain/csv.go, domain/summary.go).
func (s *Service) versionedSchemas(ctx context.Context, userID, formID uuid.UUID) ([]domain.VersionedSchema, error) {
	versions, err := s.forms.Versions(ctx, userID, formID)
	if err != nil {
		return nil, err
	}

	return parseVersions(formID, versions)
}

// scopeSchemas — то же для чтений с выборкой (сводка, сопряжённость, окно «все
// ответы»): версии формы и её пространство одним разом. Пространство нужно гейту
// кросс-аналитики, и добывать его заново на каждой проверке значило бы читать форму
// по три раза за запрос.
func (s *Service) scopeSchemas(ctx context.Context, userID, formID uuid.UUID) ([]domain.VersionedSchema, uuid.UUID, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return nil, uuid.Nil, err
	}
	vs, err := s.versionedSchemas(ctx, userID, formID)
	if err != nil {
		return nil, uuid.Nil, err
	}
	return vs, form.WorkspaceID, nil
}

// parseVersions разбирает снапшоты версий в типы домена. Общее у авторизованного
// чтения (выгрузка, сводка) и у фоновой доставки — разница между ними в том, кто
// и с какой проверкой прав добыл versions, а не в том, как их читать.
func parseVersions(formID uuid.UUID, versions []forms.Version) ([]domain.VersionedSchema, error) {
	vs := make([]domain.VersionedSchema, 0, len(versions))
	for _, v := range versions {
		schema, e := domain.ValidateSchema(v.Schema)
		if e != nil {
			// Опубликованный снапшот обязан быть валиден (проверен при публикации) —
			// иначе нарушен инвариант иммутабельности версии. %v, а не %w: см. Submit —
			// сентинел ErrValidation в цепочке дал бы 422 с внутренним текстом вместо 500.
			return nil, fmt.Errorf("parse version %d schema of form %s: %v", v.Number, formID, e)
		}
		vs = append(vs, domain.VersionedSchema{Version: int(v.Number), Schema: schema})
	}
	return vs, nil
}

// eachSubmission проходит все ответы формы порциями streamBatch (новые сверху, тем же
// keyset-курсором, что и листинг) и зовёт fn на каждый с разобранной картой ответов.
// Поток, а не выборка целиком: в памяти живёт одна порция, а потребитель решает, что
// с ней делать — выгрузка пишет строку сразу, сводка копит счётчики. Между порциями
// уважается отмена ctx (клиент закрыл соединение); ошибка fn прерывает обход.
//
// Авторизацию НЕ делает: вызывающий обязан сделать её сам (versionedSchemas или
// forms.Get) — id формы из URL правом доступа не является (инвариант 1).
func (s *Service) eachSubmission(ctx context.Context, formID uuid.UUID, period domain.Period, fn func(sub Submission, answers map[string]json.RawMessage) error) error {
	return s.eachSubmissionFrom(ctx, formID, period, nil, fn)
}

// eachSubmissionFrom — тот же обход, но с произвольного места. Начальный курсор
// нужен окну «все ответы на вопрос»: оно листает один вопрос страницами и на каждую
// заходит с того ответа, где остановилось прошлое чтение.
func (s *Service) eachSubmissionFrom(ctx context.Context, formID uuid.UUID, period domain.Period, after *Cursor, fn func(sub Submission, answers map[string]json.RawMessage) error) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		var rows []Submission
		var err error
		if after == nil {
			rows, err = s.repo.ListSubmissions(ctx, s.db, formID, streamBatch, period)
		} else {
			rows, err = s.repo.ListSubmissionsAfter(ctx, s.db, formID, after.ID, streamBatch, period)
		}
		if err != nil {
			return err
		}
		for i := range rows {
			var answers map[string]json.RawMessage
			if e := json.Unmarshal(rows[i].Answers, &answers); e != nil {
				return fmt.Errorf("unmarshal answers of submission %s: %w", rows[i].ID, e)
			}
			if e := fn(rows[i], answers); e != nil {
				return e
			}
		}
		if len(rows) < streamBatch {
			return nil
		}
		after = &Cursor{ID: rows[len(rows)-1].ID}
	}
}

// ExportCSV потоково выгружает все ответы формы в emit (по строке; первая — заголовок).
// Порядок: авторизация + чтение версий (чужая/нет формы → 404), сборка модели колонок
// (объединение блоков по версиям), затем обход ответов — каждая строка эмитится сразу,
// без накопления всей выборки. emit-ошибка (обрыв записи в сеть) прерывает экспорт.
func (s *Service) ExportCSV(ctx context.Context, userID, formID uuid.UUID, emit func(record []string) error) error {
	vs, err := s.versionedSchemas(ctx, userID, formID)
	if err != nil {
		return err
	}

	builder := domain.NewCSVBuilder(vs)
	builder.WithSchedule(s.scheduleZone(ctx, formID))
	// Имена файлов — только если у формы вообще есть вопрос-файл: у остальных (а
	// это подавляющее большинство) выгрузка не платит ни запросом, ни памятью.
	if s.files != nil && hasFileBlock(vs) {
		files, err := s.files.InfoByForm(ctx, formID)
		if err != nil {
			return err
		}
		builder.WithFiles(files)
	}
	if err := emit(append(builder.Header(), domain.VisitHeader()...)); err != nil {
		return err
	}
	// Выгрузка периодом не режется: CSV — документ «все ответы формы», и молчаливое
	// урезание его окном экрана владелец заметил бы уже в чужой таблице.
	return s.eachSubmission(ctx, formID, domain.Period{}, func(sub Submission, answers map[string]json.RawMessage) error {
		return emit(append(builder.Row(sub.ID.String(), sub.CreatedAt, int(sub.FormVersion), answers), domain.VisitCells(sub.Visit)...))
	})
}

// Summary собирает сводку ответов формы (фаза 8.5 шаг 3): распределения, статистику
// чисел и доли заполнивших. Тот же путь, что у выгрузки — авторизация и чтение версий,
// затем обход всех ответов, — но вместо строк файла копятся счётчики, поэтому наружу
// уходит итог, а не сырые ответы: браузер их целиком не получает.
//
// Стоимость линейна по числу ответов формы: см. строку лога в handler.go — по ней
// видно, во что она обходится на реальных данных.
//
// scope — выборка (спека design/analytics-v2.md §6.2, §6.4): фильтр по ответам и
// сегмент по визиту. При выборке в Unfiltered — сколько ответов в окне без неё;
// визитная выборка меньше domain.SegmentK не раскрывается (Withheld, без вопросов).
func (s *Service) Summary(ctx context.Context, userID, formID uuid.UUID, period domain.Period, scope domain.AnswerScope) (domain.Summary, error) {
	vs, workspaceID, err := s.scopeSchemas(ctx, userID, formID)
	if err != nil {
		return domain.Summary{}, err
	}
	match, err := s.answerMatcher(ctx, workspaceID, vs, scope)
	if err != nil {
		return domain.Summary{}, err
	}

	builder := domain.NewSummaryBuilder(vs)
	// Ряд шкал — тем же шагом, что ряд визитов за это окно: два графика одного экрана
	// с разной сеткой времени читались бы как расхождение данных.
	builder.Trend(domain.StepFor(period), period.From, period.To)
	unfiltered := 0
	// linked — сколько ответов окна вообще знают свой визит. Нужен ровно для одного
	// ответа экрану: «выборка по визиту дала ноль, потому что сопоставлять не с чем».
	linked := 0
	if err := s.eachSubmission(ctx, formID, period, func(sub Submission, answers map[string]json.RawMessage) error {
		unfiltered++
		if sub.Visit != nil {
			linked++
		}
		if !match(sub, answers) {
			return nil
		}
		builder.Add(int(sub.FormVersion), sub.CreatedAt, answers)
		return nil
	}); err != nil {
		return domain.Summary{}, err
	}
	noVisitLink := scope.Segment.VisitSegment() && unfiltered > 0 && linked == 0
	sum := builder.Result()
	sum.NoVisitLink = noVisitLink
	if !scope.IsZero() {
		sum.Unfiltered = &unfiltered
	}
	if scope.Withheld(sum.Total) {
		return domain.Summary{
			Unfiltered:  &unfiltered,
			Blocks:      []domain.BlockSummary{},
			Withheld:    true,
			NoVisitLink: noVisitLink,
		}, nil
	}
	return sum, nil
}

// Crosstab — таблица сопряжённости двух закрытых вопросов (спека design/analytics-v2.md
// §6.3) за окно, с выборкой сводки. Кросс-аналитика: ключ analytics_segments, после
// авторизации, — даже без выборки.
func (s *Service) Crosstab(ctx context.Context, userID, formID uuid.UUID, period domain.Period, rowID, colID string, scope domain.AnswerScope) (domain.Crosstab, error) {
	vs, workspaceID, err := s.scopeSchemas(ctx, userID, formID)
	if err != nil {
		return domain.Crosstab{}, err
	}
	// Гейт спрашивается ОДИН раз: с выборкой тот же ключ (и analytics_sources у
	// сегмента по источнику) проверит answerMatcher ниже, а без выборки спросить
	// больше некому — сопряжённость закрыта тарифом и сама по себе.
	if scope.IsZero() {
		if err := s.checkSegments(ctx, workspaceID, domain.Segment{}); err != nil {
			return domain.Crosstab{}, err
		}
	}
	// Матчер строится ДО разбора вопросов таблицы: при непустой выборке тариф
	// спрашивает он, а отказ по тарифу обязан опережать отказ по кривому запросу.
	match, err := s.answerMatcher(ctx, workspaceID, vs, scope)
	if err != nil {
		return domain.Crosstab{}, err
	}
	builder, err := domain.NewCrosstabBuilder(vs, rowID, colID)
	if err != nil {
		return domain.Crosstab{}, err
	}
	if err := s.eachSubmission(ctx, formID, period, func(sub Submission, answers map[string]json.RawMessage) error {
		if match(sub, answers) {
			builder.Add(int(sub.FormVersion), answers)
		}
		return nil
	}); err != nil {
		return domain.Crosstab{}, err
	}
	ct := builder.Result()
	if scope.Withheld(ct.Total) {
		return domain.Crosstab{Withheld: true}, nil
	}
	return ct, nil
}

// checkSegments — ключ кросс-аналитики analytics_segments; у сегмента по источнику —
// ещё и analytics_sources (иначе закрытая разбивка источников читалась бы сегментами).
//
// Пространство приходит аргументом, а не добывается здесь: чтение формы делает
// scopeSchemas один раз на запрос, и повторный forms.Get был бы вторым походом за
// тем же полем (авторизацию он тоже уже сделал).
func (s *Service) checkSegments(ctx context.Context, workspaceID uuid.UUID, seg domain.Segment) error {
	keys := []entitlements.Key{entitlements.AnalyticsSegments}
	if seg.Dim == domain.SegSource {
		keys = append(keys, entitlements.AnalyticsSources)
	}
	for _, key := range keys {
		d, err := s.plans.CheckWorkspace(ctx, workspaceID, key)
		if err != nil {
			return err
		}
		if !d.Allowed {
			return domain.ErrPlanRequired
		}
	}
	return nil
}

// answerMatcher — проверка ответа выборкой: фильтром по ответам и сегментом по визиту.
// Выборка — кросс-аналитика (checkSegments, после авторизации, которую уже сделал
// versionedSchemas). Условия сверяются с моделью вопросов: инертное условие молча дало
// бы пустую сводку. Без выборки проходит всё, и тариф не спрашивается.
func (s *Service) answerMatcher(ctx context.Context, workspaceID uuid.UUID, vs []domain.VersionedSchema, scope domain.AnswerScope) (func(sub Submission, answers map[string]json.RawMessage) bool, error) {
	if scope.IsZero() {
		return func(Submission, map[string]json.RawMessage) bool { return true }, nil
	}
	if err := s.checkSegments(ctx, workspaceID, scope.Segment); err != nil {
		return nil, err
	}
	if err := scope.Filter.Check(domain.QuestionOrder(vs)); err != nil {
		return nil, err
	}
	blocks := make(map[int][]domain.Block, len(vs))
	for _, v := range vs {
		blocks[v.Version] = v.Schema.Blocks
	}
	return func(sub Submission, answers map[string]json.RawMessage) bool {
		version := int(sub.FormVersion)
		return domain.MatchesSegment(scope.Segment, sub.Visit, version) &&
			scope.Filter.Match(blocks[version], answers)
	}, nil
}

// AnswerPage — страница значений ОДНОГО вопроса, новыми сверху.
type AnswerPage struct {
	Answers []domain.AnswerSample
	// NextCursor — nil, когда ответы формы кончились. Не «когда страница неполная»:
	// вопрос за условием даёт пустые страницы посреди формы, и остановка по их
	// длине обрезала бы список на первом же таком месте.
	NextCursor *Cursor
	// Withheld — визитная выборка меньше domain.SegmentK: значения не раскрываются.
	Withheld bool
}

// errAnswersEnough — сигнал остановить обход: страница набрана. Ошибкой, потому что
// другого способа выйти из eachSubmissionFrom досрочно нет; наружу не уходит.
var errAnswersEnough = errors.New("submissions: answer page is full")

// BlockAnswers — значения одного вопроса страницами: окно «все ответы» на вкладке
// «Сводка». Сводка отдаёт десять последних на каждый вопрос (domain.SamplesLimit),
// здесь тот же вопрос листается целиком.
//
// Считает ТОТ ЖЕ SummaryBuilder в режиме одного вопроса (domain.AnswerLog): подписи
// опций, тип вопроса и правило «что считать вопросом» обязаны совпасть со сводкой,
// иначе окно покажет не то, что строка над ним.
//
// Наружу уходит РЕНДЕР значения, а не сырой ответ: id опции владельцу ничего не
// говорит, а разбор его на клиенте был бы третьей копией доменных правил после Go и
// Zod.
//
// scope — та же выборка, что у сводки над окном: открыв «все ответы» из
// отфильтрованной сводки, владелец обязан увидеть те же ответы. У визитной выборки
// порог domain.SegmentK проверяется ДО листания — отдельным подсчётом по окну: иначе
// первая же страница раскрыла бы ответы выборки из двух человек.
func (s *Service) BlockAnswers(ctx context.Context, userID, formID uuid.UUID, blockID string, period domain.Period, scope domain.AnswerScope, after *Cursor, limit int) (AnswerPage, error) {
	vs, workspaceID, err := s.scopeSchemas(ctx, userID, formID)
	if err != nil {
		return AnswerPage{}, err
	}
	match, err := s.answerMatcher(ctx, workspaceID, vs, scope)
	if err != nil {
		return AnswerPage{}, err
	}
	if scope.Segment.VisitSegment() {
		matched := 0
		if err := s.eachSubmission(ctx, formID, period, func(sub Submission, answers map[string]json.RawMessage) error {
			if match(sub, answers) {
				matched++
			}
			return nil
		}); err != nil {
			return AnswerPage{}, err
		}
		if scope.Withheld(matched) {
			return AnswerPage{Withheld: true}, nil
		}
	}
	limit = clampLimit(limit)

	builder := domain.NewSummaryBuilder(vs)
	builder.AnswerLog(blockID, limit)

	// last — id последнего ПРОСМОТРЕННОГО ответа, а не последнего показанного:
	// следующая страница обязана начинаться за ним, иначе ответы, не давшие
	// значения (вопрос пропущен, скрыт условием), читались бы снова и снова.
	var last uuid.UUID
	var full bool
	err = s.eachSubmissionFrom(ctx, formID, period, after, func(sub Submission, answers map[string]json.RawMessage) error {
		last = sub.ID
		if !match(sub, answers) {
			return nil
		}
		builder.Add(int(sub.FormVersion), sub.CreatedAt, answers)
		if builder.SamplesFull(blockID) {
			full = true
			return errAnswersEnough
		}
		return nil
	})
	if err != nil && !errors.Is(err, errAnswersEnough) {
		return AnswerPage{}, err
	}

	page := AnswerPage{Answers: builder.Samples(blockID)}
	if full {
		page.NextCursor = &Cursor{ID: last}
	}
	return page, nil
}

// CountInPeriod — сколько видимых ответов пришло за окно наблюдения. Карточка
// «Ответы» над вкладками Insights; гейта тарифа нет (счётчик своих же ответов
// платным быть не может), авторизация — та же, что у листинга.
//
// previous — то же за прошлое окно той же длины (сравнение на карточке); nil у
// «всего времени».
func (s *Service) CountInPeriod(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (count int, previous *int, err error) {
	if _, err := s.forms.Get(ctx, userID, formID); err != nil {
		return 0, nil, err
	}
	var prev *domain.Period
	if p, ok := domain.PreviousPeriod(period, s.now()); ok {
		prev = &p
	}
	cur, prevN, err := s.repo.CountInPeriod(ctx, s.db, formID, period, prev)
	if err != nil {
		return 0, nil, err
	}
	if prev != nil {
		n := int(prevN)
		previous = &n
	}
	return int(cur), previous, nil
}

// DeleteForForm удаляет один ответ формы (GDPR-гигиена). Порядок: авторизация
// (чужая/нет формы → 404), затем удаление в пределах формы. Отсутствие ответа
// (или он из другой формы) → domain.ErrNotFound.
//
// Спрашивается ActionSubmissionDelete, а НЕ право читать форму: удаление ответа
// респондента — отдельное действие в матрице прав, и запрет на него обязан
// действовать. Спроси здесь «прочитать форму» — снятая ячейка молча ничего не
// изменит (найдено ревью фазы 18).
func (s *Service) DeleteForForm(ctx context.Context, userID, formID, submissionID uuid.UUID) error {
	if _, err := s.forms.GetForAction(ctx, userID, formID, domain.ActionSubmissionDelete); err != nil {
		return err
	}
	// СТОП-КРАН ЗАПИСИ (фаза 27, ADR §10): у ответа есть живая будущая встреча.
	// Удалить его молча — значит либо снести бронь, не предупредив клиента (его адрес
	// лежит в этом же ответе), либо оставить в расписании занятое время, о котором
	// больше ничего не известно. Сначала отмена, и это тот шаг, на котором уходит
	// письмо. Прошлые записи не держат ничего.
	if s.bookingGuard != nil {
		n, err := s.bookingGuard.FutureOfSubmission(ctx, submissionID)
		if err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: на этот ответ есть будущая запись — сначала отмените её в расписании",
				domain.ErrConflict)
		}
	}
	// Файлы — первыми: строка ответа уносит каскадом строки загрузок, а с ними и
	// ключи объектов. Сбой здесь ОСТАНАВЛИВАЕТ удаление: лучше отказать автору
	// (он повторит), чем оставить в бакете чужие персональные данные, о которых
	// больше нигде нет записи.
	if s.files != nil {
		if err := s.files.RemoveBySubmission(ctx, formID, submissionID); err != nil {
			return err
		}
	}
	n, err := s.repo.DeleteSubmission(ctx, s.db, submissionID, formID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	return nil
}

// PrintDoc — всё, из чего собирается печатная страница одного ответа: схема той
// версии, которую видел респондент, его ответы и имена приложенных файлов.
//
// Схема и ответы едут наружу СЫРЫМИ: печатную страницу рисует тот же код полей,
// что и публичную форму (`@fields`), и любая перепаковка по дороге завела бы
// второй формат документа — то есть место, где печать однажды разойдётся с формой.
type PrintDoc struct {
	ID          uuid.UUID
	FormVersion int32
	CreatedAt   time.Time
	Schema      json.RawMessage
	Answers     json.RawMessage
	// Files — приложенные к ответу файлы, upload_id → имя и размер. На бумаге у
	// файла нет ссылки (подпись хранилища живёт минуту, а лист живёт годы) —
	// печатается имя, поэтому карта нужна и здесь, как в таблице и выгрузке.
	Files map[string]domain.AnswerFile
	// Timezone — пояс расписания формы; пусто = записи у формы нет. ПРИЕЗЖАЕТ
	// ДАННЫМИ, а не берётся у браузера (design/booking.md §4.9): лист печатает
	// headless-контейнер, у которого пояса нет вовсе, и время записи вставало бы на
	// бумагу в UTC — на три часа мимо у московского расписания, без единого признака
	// ошибки на самом листе.
	Timezone string
}

// PrintAccess — что известно об ответе тому, кто ИМЕЕТ ПРАВО его печатать: имя
// формы и время приёма, из которых складывается имя файла PDF.
type PrintAccess struct {
	FormTitle string
	CreatedAt time.Time
}

// AuthorizePrint отвечает на один вопрос: можно ли этому пользователю печатать этот
// ответ. Право — то же, что у листинга (членство через forms.Get): печать это способ
// прочитать ответ, который человек и так видит на экране, и свой барьер на неё
// обещал бы защиту, которой рядом нет.
//
// Существование ответа проверяется ЗДЕСЬ, а не на печатной странице: иначе запрос на
// удалённый или чужой ответ поднимал бы браузер, чтобы вернуть лист со словами
// «печатать нечего» вместо честного 404.
func (s *Service) AuthorizePrint(ctx context.Context, userID, formID, submissionID uuid.UUID) (PrintAccess, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return PrintAccess{}, err
	}
	row, err := s.repo.GetForPrint(ctx, s.db, formID, submissionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PrintAccess{}, domain.ErrNotFound
		}
		return PrintAccess{}, fmt.Errorf("authorize print of submission %s: %w", submissionID, err)
	}
	return PrintAccess{FormTitle: form.Title, CreatedAt: row.CreatedAt}, nil
}

// PrintAccessForDelivery — имя формы и дата ответа для вложения в письмо владельцу.
//
// ⚠ Прав НЕ проверяет, как и PrintDocFor: письмо отправляем мы сами, адресат —
// владелец пространства (его же и вернул SubmissionOwner при постановке), и
// пользователя, которому надо что-то разрешать, здесь просто нет. Существование
// ответа проверяется: между постановкой письма и его доставкой ответ могли удалить,
// и тогда вложения не будет (ErrNotFound → письмо уйдёт без файла).
func (s *Service) PrintAccessForDelivery(ctx context.Context, formID, submissionID uuid.UUID) (PrintAccess, error) {
	owner, err := s.forms.SubmissionOwner(ctx, formID)
	if err != nil {
		return PrintAccess{}, fmt.Errorf("print access for delivery, form %s: %w", formID, err)
	}
	row, err := s.repo.GetForPrint(ctx, s.db, formID, submissionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PrintAccess{}, domain.ErrNotFound
		}
		return PrintAccess{}, fmt.Errorf("print access for delivery, submission %s: %w", submissionID, err)
	}
	return PrintAccess{FormTitle: owner.Title, CreatedAt: row.CreatedAt}, nil
}

// PrintDocFor собирает документ одного ответа для печати: схема СВОЕЙ версии, ответы
// и имена файлов.
//
// ⚠ Прав НЕ проверяет — по тем же основаниям, что SheetRow: страницу открывает
// headless-браузер принтера, у которого нет ни сессии, ни пользователя. Право
// проверено раньше и в другом месте (AuthorizePrint), а сюда оно приезжает
// подписанным токеном печати, который без права не выдаётся.
func (s *Service) PrintDocFor(ctx context.Context, formID, submissionID uuid.UUID) (PrintDoc, error) {
	row, err := s.repo.GetForPrint(ctx, s.db, formID, submissionID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return PrintDoc{}, domain.ErrNotFound
		}
		return PrintDoc{}, fmt.Errorf("get submission %s for print: %w", submissionID, err)
	}

	doc := PrintDoc{
		ID:          row.ID,
		FormVersion: row.FormVersion,
		CreatedAt:   row.CreatedAt,
		Schema:      row.Schema,
		Answers:     row.Answers,
	}

	// Имена файлов — одним запросом по этому ответу: на бумаге у файла печатается
	// имя, а в самих ответах лежат только id.
	if s.files != nil {
		files, err := s.files.InfoBySubmissions(ctx, []uuid.UUID{row.ID})
		if err != nil {
			return PrintDoc{}, err
		}
		doc.Files = files
	}
	// Пояс — тем же путём, что у выгрузок: у стража записи.
	if s.bookingGuard != nil {
		doc.Timezone = s.bookingGuard.ZoneOfForm(ctx, formID)
	}
	return doc, nil
}

// hasFileBlock — есть ли в какой-нибудь версии формы вопрос-файл. Дешёвый обход
// уже разобранных схем: он решает, платить ли за имена файлов вообще.
func hasFileBlock(vs []domain.VersionedSchema) bool {
	for _, v := range vs {
		for i := range v.Schema.Blocks {
			if v.Schema.Blocks[i].Type == domain.BlockFile {
				return true
			}
		}
	}
	return false
}

func clampLimit(limit int) int {
	switch {
	case limit <= 0:
		return DefaultPageLimit
	case limit > MaxPageLimit:
		return MaxPageLimit
	default:
		return limit
	}
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// slotBooking — что приём ответа знает о записи на время из самого ответа.
type slotBooking struct {
	// BlockID — id вопроса о записи; пусто = записи в этом ответе нет (вопроса нет в
	// схеме или на него не ответили).
	BlockID   string
	BookingID uuid.UUID
	// Ниже — то, что известно ТОЛЬКО ПОСЛЕ подтверждения: время из строки брони, её
	// длительность и пояс расписания. Ими живёт письмо о записи (bookingmail.go).
	StartsAt        time.Time
	DurationMinutes int
	Timezone        string
}

// slotAnswer достаёт бронь из ответа. На проводе у вопроса о записи лежит id брони —
// и только он (design/booking.md §5.6); всё остальное о записи знает база.
//
// Пустой ответ на необязательный вопрос — не ошибка: вопрос о времени можно не
// заполнить, как любой другой. Обязательность уже проверена NormalizeAnswers.
func slotAnswer(schema domain.FormSchema, answers map[string]json.RawMessage) (slotBooking, error) {
	for i := range schema.Blocks {
		b := schema.Blocks[i]
		if b.Type != domain.BlockSlot {
			continue
		}
		raw, ok := answers[b.ID]
		if !ok || len(raw) == 0 {
			return slotBooking{}, nil
		}
		var v string
		if json.Unmarshal(raw, &v) != nil || v == "" {
			return slotBooking{}, nil
		}
		id, err := uuid.Parse(v)
		if err != nil {
			// Строка не id брони: либо мусор, либо уже записанное время (повторная
			// проверка сохранённого). Второе сюда не приходит — ответ принимается
			// один раз, — а первое подтверждать нечем.
			return slotBooking{}, fmt.Errorf("%w: время записи не выбрано", domain.ErrValidation)
		}
		return slotBooking{BlockID: b.ID, BookingID: id}, nil
	}
	return slotBooking{}, nil
}

// scheduleZone — пояс расписания формы для выгрузок. Нет записи или страж не
// подключён — nil, и время (которого тогда и не бывает) осталось бы в UTC.
func (s *Service) scheduleZone(ctx context.Context, formID uuid.UUID) *time.Location {
	if s.bookingGuard == nil {
		return nil
	}
	zone := s.bookingGuard.ZoneOfForm(ctx, formID)
	if zone == "" {
		return nil
	}
	loc, err := domain.LoadScheduleLocation(zone)
	if err != nil {
		// Зона в базе есть, а в базе зон её нет: печатаем в UTC, но говорим об этом.
		httpserver.LoggerFrom(ctx).Warn("schedule zone not loaded, export stays in UTC",
			slog.String("form_id", formID.String()), slog.String("zone", zone))
		return nil
	}
	return loc
}

// errConsentRequired — отказ приёму без галочки согласия. Текст видит респондент, если
// рендерер его пропустил (curl, страница из кэша до включения согласия).
var errConsentRequired = fmt.Errorf("%w: нужно согласие на обработку персональных данных — обновите форму и отметьте его", domain.ErrValidation)

// acceptedConsent решает, с какой ревизией согласия принять ответ (спека §3.4).
//
// Согласие у формы включено → нужна присланная ВКЛЮЧЁННАЯ ревизия ЭТОЙ формы, и
// записывается она, а не текущая: автор мог сохранить новую, пока человек заполнял
// форму, а соглашался человек с тем текстом, который видел.
//
// Выключено → ответ принимается как без согласия. Присланная включённая ревизия формы
// всё равно записывается: человек согласился, и это правда. Чужая или выключенная —
// молча не пишется: отказывать ответу из-за устаревшей страницы незачем.
func (s *Service) acceptedConsent(ctx context.Context, pf forms.PublicFormRef, sent uuid.UUID) (*uuid.UUID, error) {
	required := pf.ConsentRevisionID != nil
	if sent == uuid.Nil {
		if required {
			return nil, errConsentRequired
		}
		return nil, nil
	}
	// Текущая включённая ревизия — самый частый случай, и базе здесь нечего добавить.
	if required && *pf.ConsentRevisionID == sent {
		return &sent, nil
	}
	ok, err := s.forms.ConsentRevisionEnabled(ctx, pf.FormID, sent)
	if err != nil {
		return nil, err
	}
	switch {
	case ok:
		return &sent, nil
	case required:
		return nil, errConsentRequired
	default:
		return nil, nil
	}
}
