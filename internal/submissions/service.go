package submissions

import (
	"context"
	"encoding/json"
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

	// notifyDigestWindow — окно троттлинга уведомлений владельцу (слайс D): все
	// ответы, пришедшие за это окно после первого, склеиваются в одно письмо «N
	// ответов». Ограничивает поток до ≤1 письма на форму за окно даже у вирусной
	// формы; цена — одиночный ответ владелец увидит с задержкой в это окно.
	notifyDigestWindow = 5 * time.Minute
)

// Forms — коллаборатор из модуля forms: отдаёт опубликованную форму по slug (приём
// ответа) и авторизует доступ автора к форме по id (листинг). Реализация —
// *forms.Service; общение через интерфейс сервиса (не чужой repo).
type Forms interface {
	PublicForm(ctx context.Context, slug string) (forms.PublicForm, error)
	// Get проверяет членство пользователя в воркспейсе формы и возвращает её;
	// чужая или несуществующая → domain.ErrNotFound (анти-IDOR, приватное не
	// раскрывается). Листингу нужен только факт доступа, не поля формы.
	Get(ctx context.Context, userID, formID uuid.UUID) (forms.Form, error)
	// Versions авторизует доступ (как Get) и отдаёт все опубликованные версии
	// формы — их схемы нужны CSV-экспорту для объединения колонок и подписей опций.
	Versions(ctx context.Context, userID, formID uuid.UUID) ([]forms.Version, error)
	// SubmissionOwner — адресат уведомления о новом ответе (email владельца + имя
	// формы). Форма уже резолвнута по slug, членство не проверяется (это адресат, а
	// не доступ пользователя). Слайс D.
	SubmissionOwner(ctx context.Context, formID uuid.UUID) (forms.Owner, error)
}

// Mailer — коллаборатор из модуля mail: ставит письмо-уведомление в outbox с
// коалесингом (троттлинг-дайджест «N ответов»). Пишется в транзакции приёма ответа
// (transactional outbox). Реализация — *mail.Service. Слайс D.
type Mailer interface {
	EnqueueCoalesced(ctx context.Context, db postgres.DBTX, key string, msg mail.EmailMessage, delay time.Duration) error
}

// Visits — коллаборатор из модуля visits: отмечает визит как закончившийся ответом
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

// Store — доступ к данным submissions, объявленный на стороне потребителя.
type Store interface {
	InsertSubmission(ctx context.Context, db postgres.DBTX, in NewSubmission) (int64, error)
	ListSubmissions(ctx context.Context, db postgres.DBTX, formID uuid.UUID, limit int32) ([]Submission, error)
	ListSubmissionsAfter(ctx context.Context, db postgres.DBTX, formID, cursorID uuid.UUID, limit int32) ([]Submission, error)
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
	// appBaseURL — origin кабинета, из которого строится ссылка в таблицу ответов в
	// письме владельцу (${appBaseURL}/forms/{slug}/responses). Совпадает с cfg.AppOrigin.
	appBaseURL string
	now        func() time.Time // подменяется в тестах (проверка даты закрытия)
}

func NewService(db postgres.DBTX, tx Transactor, forms Forms, visits Visits, mailer Mailer, plans Plans, repo Store, appBaseURL string) *Service {
	return &Service{db: db, tx: tx, forms: forms, visits: visits, mail: mailer, plans: plans, repo: repo, appBaseURL: appBaseURL, now: time.Now}
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
	schema, err := domain.ValidateSchema(pf.Schema)
	if err != nil {
		return fmt.Errorf("parse published schema for %s: %v", slug, err)
	}
	if err := domain.ValidateAnswers(schema, answers); err != nil {
		return err
	}

	answersJSON, err := json.Marshal(answers)
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
		Period:      s.plans.PeriodStart(),
	}
	if d, e := s.plans.CheckWorkspace(ctx, pf.WorkspaceID, entitlements.SubmissionsPerMonth); e != nil {
		httpserver.LoggerFrom(ctx).Error("quota not checked, submission accepted as within quota",
			slog.String("workspace_id", pf.WorkspaceID.String()),
			slog.String("error", e.Error()))
	} else {
		in.OverQuota = !d.Allowed
	}

	// inserted — была ли вставлена НОВАЯ строка (n > 0). false = идемпотентный ретрай
	// (тот же id): ответ уже принят, повторно ни считать лимит, ни слать письмо не надо.
	var inserted bool

	// Без лимита — прежний путь без блокировки: одна вставка на пуле.
	if pf.ResponseLimit == nil {
		n, err := s.repo.InsertSubmission(ctx, s.db, in)
		if err != nil {
			return err
		}
		inserted = n > 0
	} else {
		// Жёсткий кап (ADR §10): advisory-lock по форме сериализует конкурентные приёмы,
		// поэтому счёт точен и перебор невозможен. Порядок «вставка → счёт» держит
		// идемпотентность: ретрай даёт n == 0 (конфликт по PK) и проходит МИМО лимита
		// (ответ уже принят); новая вставка сверх лимита откатывается (счёт с учётом
		// только что вставленной строки превышает лимит) — форма как раз заполнилась.
		limit := int64(*pf.ResponseLimit)
		if err := s.tx.WithTx(ctx, func(tx pgx.Tx) error {
			if err := s.repo.LockFormForSubmit(ctx, tx, pf.FormID); err != nil {
				return err
			}
			n, err := s.repo.InsertSubmission(ctx, tx, in)
			if err != nil {
				return err
			}
			if n == 0 {
				return nil // идемпотентный ретрай — ответ уже принят, лимит ни при чём
			}
			count, err := s.repo.CountSubmissions(ctx, tx, pf.FormID)
			if err != nil {
				return err
			}
			if count > limit {
				return domain.ErrFormClosed // откат вставки: форма только что заполнилась
			}
			inserted = true
			return nil
		}); err != nil {
			return err
		}
	}

	// Побочные эффекты — ПОСЛЕ приёма и best-effort (ни один не имеет права уронить
	// принятый ответ): конверсия визита и уведомление владельцу. Только для новой
	// строки (не для идемпотентного ретрая).
	s.markVisitSubmitted(ctx, pf.FormID, meta.VisitID)
	if inserted && pf.NotifyOnSubmission {
		s.notifyOwner(ctx, pf.FormID, slug)
	}
	return nil
}

// notifyOwner ставит владельцу письмо-дайджест о новом ответе — коалесцирующим
// enqueue по ключу формы (ответы за окно склеиваются в одно письмо «N ответов»,
// шквал ответов не даёт шквала писем). Ссылка ведёт в таблицу ответов кабинета.
//
// Вызывается ПОСЛЕ приёма и best-effort, как markVisitSubmitted: уведомление —
// вторичный эффект, и уронить из-за него принятый ответ нельзя (респондент увидел
// бы «не удалось отправить» на записанном ответе). Поэтому НЕ в транзакции приёма:
// это размен строгой атомарности «ответ+письмо» на неприкосновенность hot-path и
// принятого ответа. Цена — краш в узком окне между коммитом ответа и enqueue теряет
// одно уведомление; данные целы (владелец видит ответ в таблице), а следующий ответ
// открывает/наращивает дайджест заново. Сбой (нет владельца, пустой email, недоступна
// БД) уходит в лог с request_id — ответ уже принят. Слайс D. Гонка диспетчера с
// инкрементом во время отправки — TD-36. Слайс D.
func (s *Service) notifyOwner(ctx context.Context, formID uuid.UUID, slug string) {
	owner, err := s.forms.SubmissionOwner(ctx, formID)
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("submission owner not resolved for notification",
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
		return
	}
	link := s.appBaseURL + "/forms/" + slug + "/responses"
	err = s.mail.EnqueueCoalesced(ctx, s.db, "submission:"+formID.String(), mail.EmailMessage{
		To:       owner.Email,
		Template: mail.TemplateSubmissionDigest,
		Data:     map[string]any{"form_title": owner.Title, "link": link, "count": 1},
	}, notifyDigestWindow)
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("owner notification not enqueued",
			slog.String("form_id", formID.String()), slog.String("error", err.Error()))
	}
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

// ListForForm возвращает страницу ответов формы для её автора. Порядок: авторизация
// через forms.Get (чужая/нет формы → 404, приватное не раскрывается), затем чтение
// страницы. after — курсор предыдущей страницы (nil для первой). Общий счётчик
// считается всегда (кабинет показывает «N ответов»).
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
		rows, err = s.repo.ListSubmissions(ctx, s.db, formID, fetch)
	} else {
		rows, err = s.repo.ListSubmissionsAfter(ctx, s.db, formID, after.ID, fetch)
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
func (s *Service) eachSubmission(ctx context.Context, formID uuid.UUID, fn func(sub Submission, answers map[string]json.RawMessage) error) error {
	var after *Cursor
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		var rows []Submission
		var err error
		if after == nil {
			rows, err = s.repo.ListSubmissions(ctx, s.db, formID, streamBatch)
		} else {
			rows, err = s.repo.ListSubmissionsAfter(ctx, s.db, formID, after.ID, streamBatch)
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
	if err := emit(builder.Header()); err != nil {
		return err
	}
	return s.eachSubmission(ctx, formID, func(sub Submission, answers map[string]json.RawMessage) error {
		return emit(builder.Row(sub.ID.String(), sub.CreatedAt, int(sub.FormVersion), answers))
	})
}

// Summary собирает сводку ответов формы (фаза 8.5 шаг 3): распределения, статистику
// чисел и доли заполнивших. Тот же путь, что у выгрузки — авторизация и чтение версий,
// затем обход всех ответов, — но вместо строк файла копятся счётчики, поэтому наружу
// уходит итог, а не сырые ответы: браузер их целиком не получает.
//
// Стоимость линейна по числу ответов формы: см. строку лога в handler.go — по ней
// видно, во что она обходится на реальных данных.
func (s *Service) Summary(ctx context.Context, userID, formID uuid.UUID) (domain.Summary, error) {
	vs, err := s.versionedSchemas(ctx, userID, formID)
	if err != nil {
		return domain.Summary{}, err
	}

	builder := domain.NewSummaryBuilder(vs)
	if err := s.eachSubmission(ctx, formID, func(sub Submission, answers map[string]json.RawMessage) error {
		builder.Add(int(sub.FormVersion), answers)
		return nil
	}); err != nil {
		return domain.Summary{}, err
	}
	return builder.Result(), nil
}

// DeleteForForm удаляет один ответ формы (GDPR-гигиена). Порядок: авторизация через
// forms.Get (чужая/нет формы → 404), затем удаление в пределах формы. Отсутствие
// ответа (или он из другой формы) → domain.ErrNotFound.
func (s *Service) DeleteForForm(ctx context.Context, userID, formID, submissionID uuid.UUID) error {
	if _, err := s.forms.Get(ctx, userID, formID); err != nil {
		return err
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
