package integrations

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/httpserver"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// Access — права в пространстве глазами этого модуля (internal/workspaces).
// Спрашивается ДЕЙСТВИЕ, а не роль (ADR §10). Can сам различает два отказа:
// не участник → ErrNotFound (404, чужое не раскрывается), участник без права →
// ErrForbidden (403).
type Access interface {
	Can(ctx context.Context, workspaceID, userID uuid.UUID, action domain.Action) error
	// IsMember — голое членство, без вопроса о правах. Нужно доставке: аккаунт
	// Google личный, и связку ушедшего участника поток ответов обязан потерять.
	IsMember(ctx context.Context, workspaceID, userID uuid.UUID) (bool, error)
}

// Store — доступ к данным, объявленный потребителем. Реализация — Repo.
type Store interface {
	Upsert(ctx context.Context, db postgres.DBTX, c NewConnection) (uuid.UUID, error)
	ListByUser(ctx context.Context, db postgres.DBTX, userID uuid.UUID, provider string) ([]Connection, error)
	// Delete удаляет аккаунт человека у НАЗВАННОГО провайдера: адрес отключения
	// Яндекса не трогает аккаунт Google (фильтр в самом SQL).
	Delete(ctx context.Context, db postgres.DBTX, id, userID uuid.UUID, provider string) ([]byte, error)
	UpdateToken(ctx context.Context, db postgres.DBTX, id uuid.UUID, sealed []byte) error
	GetAccountByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Connection, error)
	InsertLink(ctx context.Context, db postgres.DBTX, l NewFormLink) error
	ListLinks(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]FormLink, error)
	DeleteLink(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error)
	// LinkIDsByAccount — связки аккаунта: нужны отбою поводов перед тем, как их
	// унесёт каскад отключения.
	LinkIDsByAccount(ctx context.Context, db postgres.DBTX, accountID uuid.UUID) ([]uuid.UUID, error)
	UpdateLinkSettings(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, name string, enabled bool) (int64, error)
	UpdateLinkTarget(ctx context.Context, db postgres.DBTX, id, formID, accountID uuid.UUID, sheet Spreadsheet, columns []domain.SheetColumn) (int64, error)
	GetLinkByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (FormLink, error)
	DueLinks(ctx context.Context, db postgres.DBTX, limit int32) ([]FormLink, error)
	PendingSheetSubmissions(ctx context.Context, db postgres.DBTX, linkID uuid.UUID, limit int32) ([]QueuedSheetRow, error)
	DropSheetQueued(ctx context.Context, db postgres.DBTX, linkID uuid.UUID, ids []uuid.UUID, before time.Time) error
	EnqueueSheet(ctx context.Context, db postgres.DBTX, linkID, submissionID uuid.UUID) error
	ClearSheetQueue(ctx context.Context, db postgres.DBTX, linkID uuid.UUID) error
	EnqueueSheetBackfill(ctx context.Context, db postgres.DBTX, linkID, formID uuid.UUID) (int64, error)
	ExpiredSheetQueued(ctx context.Context, db postgres.DBTX, before time.Time, limit int32) ([]SheetQueueRef, error)
	MarkFailed(ctx context.Context, db postgres.DBTX, id uuid.UUID, cause string, failingSince, next time.Time) error
	UpdateLinkColumns(ctx context.Context, db postgres.DBTX, id uuid.UUID, columns []domain.SheetColumn) error
	MarkDelivered(ctx context.Context, db postgres.DBTX, id uuid.UUID) error
	MarkBroken(ctx context.Context, db postgres.DBTX, id uuid.UUID, cause string) error
	ClearError(ctx context.Context, db postgres.DBTX, id uuid.UUID) error
	MarkAccessLost(ctx context.Context, db postgres.DBTX, id uuid.UUID, at time.Time) error
	ClearAccessLost(ctx context.Context, db postgres.DBTX, id uuid.UUID) error
	InsertDelivery(ctx context.Context, db postgres.DBTX, d Delivery) error
	ListDeliveries(ctx context.Context, db postgres.DBTX, linkID, cursor uuid.UUID, limit int32) ([]Delivery, error)
	GetDelivery(ctx context.Context, db postgres.DBTX, id, linkID uuid.UUID) (Delivery, error)
	SubmissionDelivered(ctx context.Context, db postgres.DBTX, linkID, submissionID uuid.UUID) (bool, error)
	DeleteOldDeliveries(ctx context.Context, db postgres.DBTX, before time.Time) (int64, error)
}

var _ Store = Repo{}

// Имена провайдеров — значения колонки integration_accounts.provider и сегмент
// адреса ручек подключения.
const (
	ProviderGoogle = "google"
	ProviderYandex = "yandex"
)

// AccountProvider — провайдер, к которому человек подключает СВОЙ аккаунт:
// согласие, обмен кода, обновление токена, профиль, отзыв. Его реализуют Google
// (Таблицы) и Яндекс (Метрика, фаза 29).
type AccountProvider interface {
	Provider() string
	AuthURL(state, verifier, loginHint string) string
	Exchange(ctx context.Context, code, verifier string) (Tokens, error)
	Refresh(ctx context.Context, refresh string) (Tokens, error)
	Account(ctx context.Context, accessToken string) (Account, error)
	Revoke(ctx context.Context, refresh string) error
}

// Provider — Google: аккаунт плюс таблицы. Интерфейс, а не *Google: на его место
// в тестах встаёт httptest-сервер.
type Provider interface {
	AccountProvider

	CreateSpreadsheet(ctx context.Context, accessToken, title, sheetTitle string) (Spreadsheet, error)
	AddSheet(ctx context.Context, accessToken, spreadsheetID, title string) (Spreadsheet, error)
	ListSpreadsheets(ctx context.Context, accessToken string) ([]SpreadsheetRef, error)
	ListSheets(ctx context.Context, accessToken, spreadsheetID string) ([]SheetRef, error)
	SpreadsheetURL(ctx context.Context, accessToken, spreadsheetID string) (string, error)
	FirstRowEmpty(ctx context.Context, accessToken string, s Spreadsheet) (bool, error)
	// AppID — номер проекта Google Cloud (для окна выбора файла).
	AppID() string
	ReadHeader(ctx context.Context, accessToken string, s Spreadsheet) ([]string, error)
	WriteHeader(ctx context.Context, accessToken string, s Spreadsheet, header []string) error
	AppendRows(ctx context.Context, accessToken string, s Spreadsheet, rows [][]string) error
	ClearSheet(ctx context.Context, accessToken string, s Spreadsheet) error
}

// MetrikaProvider — Яндекс: аккаунт плюс API управления Метрики (фаза 29). Цели
// и счётчики отдельным интерфейсом поверх аккаунтной части, а не в
// AccountProvider: у Google их нет и не будет.
type MetrikaProvider interface {
	AccountProvider

	ListCounters(ctx context.Context, accessToken string) ([]MetrikaCounter, error)
	CreateCounter(ctx context.Context, accessToken, name, site string) (MetrikaCounter, error)
	EnsureGoals(ctx context.Context, accessToken string, counterID int64, goals []MetrikaGoal) (GoalsResult, error)
}

// Transactor открывает транзакцию (postgres.TxRunner). Нужен ровно в одном
// месте — при подключении связки, где три записи обязаны лечь вместе.
type Transactor interface {
	WithTx(ctx context.Context, fn func(pgx.Tx) error) error
}

// Service — подключение внешних аккаунтов человека и доставка в них.
type Service struct {
	db     postgres.DBTX
	tx     Transactor
	repo   Store
	access Access
	forms  Forms
	// submissions — строки ответов для листа. Подключается сеттером WithDelivery;
	// nil означает «сборка без доставки» (её нет в тестах привязки).
	submissions Submissions
	// webhooks и egress — вебхуки (фаза 28). Подключаются сеттером WithWebhooks;
	// nil означает «сборка без вебхуков» (её нет в тестах связок Таблиц).
	webhooks WebhookStore
	egress   Egress
	// counters — счётчики аналитики формы (фаза 29). Подключаются сеттером
	// WithCounters; nil означает «сборка без счётчиков».
	counters CounterStore
	// formBase — адрес публичного рендерера (тем же сеттером): из его хоста
	// берётся «сайт» счётчика, который продукт заводит в Метрике.
	formBase string
	// notes — уведомления кабинета о поломке цели. Тем же сеттером и по той же
	// причине, что webhooks; nil = уведомлений в сборке нет.
	notes Notifications
	// now — часы доставки (бэкофф цели, срок хранения очереди); подменяются в
	// тестах через WithClock.
	now func() time.Time
	// pickerKey — браузерный ключ для окна выбора файла (см. WithPicker).
	pickerKey string
	google    Provider
	// yandex — аккаунт Яндекса для счётчика Метрики (WithYandex); nil — приложение
	// не настроено на контуре, счётчик вписывается номером вручную.
	yandex MetrikaProvider
	// key — общий секрет приложения (FORM_TOKEN_SECRET). Из него HKDF выводит
	// ключ шифрования refresh-токенов; сам он здесь не используется ни для чего
	// другого и наружу не отдаётся.
	key []byte
}

func NewService(db postgres.DBTX, tx Transactor, repo Store, access Access, f Forms, google Provider, key []byte) *Service {
	return &Service{db: db, tx: tx, repo: repo, access: access, forms: f, google: google, key: key, now: time.Now}
}

// WithPicker включает окно выбора файла на Google Диске. Ключ — браузерный
// API-key из того же проекта Google Cloud; пусто = кнопки выбора нет, и
// интеграция работает как раньше (создать новую или взять созданную нами).
func (s *Service) WithPicker(apiKey string) *Service {
	s.pickerKey = apiKey
	return s
}

// WithYandex включает подключение аккаунта Яндекса (фаза 29, design/yandex-metrika.md
// §13). Звать только с настоящим провайдером: типизированный nil в интерфейсе
// сервис счёл бы настроенным.
func (s *Service) WithYandex(p MetrikaProvider) *Service {
	s.yandex = p
	return s
}

// accountProvider — провайдер по имени; nil — не настроен на контуре. Всё, что не
// Яндекс, — Google: таблицы есть только у него, и путь доставки зовёт обновление
// токена, не разбирая имя.
func (s *Service) accountProvider(name string) AccountProvider {
	if name == ProviderYandex {
		if s.yandex == nil {
			return nil
		}
		return s.yandex
	}
	if s.google == nil {
		return nil
	}
	return s.google
}

// providerTitle — провайдер в тексте отказа человеку.
func providerTitle(name string) string {
	if name == ProviderYandex {
		return "Яндекса"
	}
	return "Google"
}

// Enabled отвечает, настроен ли провайдер на этом контуре. Не настроен (нет
// ключей в env) — эндпоинты отдают 404, а экран говорит об этом человеческим
// текстом: dev-контур без проекта в Google Cloud обязан оставаться рабочим.
func (s *Service) Enabled() bool { return s.google != nil }

// ConnectedAccount — подключённый аккаунт человека глазами экрана. Имя длиннее
// напрашивающегося Account: так зовётся профиль, который отдаёт сам провайдер
// (google.go), и путать «что мы храним» с «что нам ответил Google» дорого.
type ConnectedAccount struct {
	ID    uuid.UUID
	Email string
	// NeedsReconnect — подключение есть, а пользоваться им нельзя. Лечение одно
	// («подключите ЗАНОВО»), поэтому и признак один, а причин у него две:
	//
	//  1. refresh-токен не расшифровывается — ключ шифрования выведен из
	//     FORM_TOKEN_SECRET, и его ротация оставляет за собой негодный
	//     шифротекст (secretbox.go). Видно без сети, на каждом показе таба.
	//  2. провайдер отказал в обновлении токена (`ErrAccessLost`): человек
	//     отозвал доступ в своём Google либо refresh протух — у приложения в
	//     статусе Testing это неделя. Шифротекст при этом ЦЕЛ, и без походов к
	//     провайдеру беда невидима: узнаём о ней при доставке и запоминаем
	//     моментом в access_lost_at (0061).
	//
	// ⚠ Вторая причина и есть та, из-за которой поле вообще расширяли: пока она
	// жила только в статусе СВЯЗКИ, мёртвый аккаунт выглядел рабочим везде,
	// кроме одной формы, где как раз упала доставка.
	NeedsReconnect bool
	ConnectedAt    time.Time
}

// Status — подключения СПРАШИВАЮЩЕГО, то, из чего он выбирает в окне связки.
type Status struct {
	// Enabled — настроен ли провайдер на этом контуре (ключи в env). Отдельно от
	// пустого списка: «интеграции здесь нет вовсе» и «есть, но ничего не
	// подключено» — разные экраны, и путать их значит советовать человеку нажать
	// кнопку, которой у него не появится.
	Enabled bool
	// PickerEnabled — настроено ли окно выбора файла на Диске (WithPicker).
	PickerEnabled bool
	// Accounts — аккаунты человека у этого провайдера, в порядке подключения.
	// Пустой список — штатное состояние экрана, а не ошибка.
	Accounts []ConnectedAccount
}

// Status читает подключения человека.
//
// Прав пространства здесь не спрашивают вовсе: с миграции 0037 аккаунт
// принадлежит человеку (ADR §10), и «мои подключения» — вопрос о себе. Роль в
// какой бы то ни было команде на ответ не влияет.
func (s *Service) Status(ctx context.Context, provider string, userID uuid.UUID) (Status, error) {
	p := s.accountProvider(provider)
	if p == nil {
		return Status{}, nil
	}
	conns, err := s.repo.ListByUser(ctx, s.db, userID, p.Provider())
	if err != nil {
		return Status{}, fmt.Errorf("integration status: %w", err)
	}
	// Окно выбора файла — только у Google.
	picker := provider != ProviderYandex && s.PickerAvailable()
	out := Status{Enabled: true, PickerEnabled: picker, Accounts: make([]ConnectedAccount, 0, len(conns))}
	for _, c := range conns {
		// Расшифровка — не поход к провайдеру, а AES-GCM над сотней байт: платить
		// за неё показом таба дешевле, чем врать про рабочее подключение.
		_, tokenErr := openToken(s.key, c.RefreshSealed)
		out.Accounts = append(out.Accounts, ConnectedAccount{
			ID:             c.ID,
			Email:          c.Email,
			NeedsReconnect: tokenErr != nil || !c.AccessLostAt.IsZero(),
			ConnectedAt:    c.ConnectedAt,
		})
	}
	return out, nil
}

// accountForLink — аккаунт, которым УЖЕ едет связка. Не обязан принадлежать
// спрашивающему: в команде связку заводит один участник, а правит другой, и
// право на неё даёт form.write.
//
// Но членство владельца аккаунта проверяется здесь так же, как на доставке:
// операция пойдёт ЕГО токеном в ЕГО Диск, и если человека из пространства сняли,
// делать это нельзя — иначе оставшийся участник чистит и переписывает личную
// таблицу бывшего коллеги его же кредом. Сторож в Deliver один этого не
// закрывает: он стоит на фоновом пути, а перезалив и переезд идут синхронно.
func (s *Service) accountForLink(ctx context.Context, link FormLink) (Connection, error) {
	conn, err := s.repo.GetAccountByID(ctx, s.db, link.AccountID)
	if err != nil {
		return Connection{}, fmt.Errorf("account of connection: %w", err)
	}
	member, err := s.access.IsMember(ctx, link.WorkspaceID, conn.UserID)
	if err != nil {
		return Connection{}, err
	}
	if !member {
		return Connection{}, fmt.Errorf(
			"%w: аккаунт Google, которым едет это подключение, принадлежит человеку без доступа к пространству. "+
				"Заведите подключение заново своим аккаунтом", domain.ErrValidation)
	}
	return conn, nil
}

// accountOf — аккаунт спрашивающего по id. ЕДИНСТВЕННАЯ точка проверки «аккаунт
// мой»: id приезжает из запроса и правом доступа сам по себе не является
// (инвариант 1). Чужой аккаунт неотличим от несуществующего — один и тот же
// текст на оба случая, чтобы отказ не подтверждал существование чужого.
func (s *Service) accountOf(ctx context.Context, userID, accountID uuid.UUID) (Connection, error) {
	return s.accountOfProvider(ctx, ProviderGoogle, userID, accountID)
}

// accountOfProvider — accountOf для названного провайдера. Аккаунт ДРУГОГО
// провайдера неотличим от чужого: токен Яндекса в походе к Google (и наоборот)
// ни к чему не ведёт, а подсказка переподключения несла бы его почту.
func (s *Service) accountOfProvider(ctx context.Context, provider string, userID, accountID uuid.UUID) (Connection, error) {
	conn, err := s.repo.GetAccountByID(ctx, s.db, accountID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (conn.UserID != userID || conn.Provider != provider)) {
		return Connection{}, fmt.Errorf("%w: аккаунт %s не подключён", domain.ErrValidation, providerTitle(provider))
	}
	if err != nil {
		return Connection{}, fmt.Errorf("integration account: %w", err)
	}
	return conn, nil
}

// StartURL — ссылка на экран согласия провайдера.
//
// Прав пространства не спрашивает: человек подключает СВОЙ аккаунт Google, и
// гейт по роли здесь был бы пуст — личное пространство есть у каждого, и в нём
// каждый владелец (ADR §10, решение 2026-08-27).
//
// reconnect — id СВОЕГО аккаунта, который переподключают: его почта уезжает
// провайдеру подсказкой, и человек попадает сразу в нужный аккаунт вместо
// выбора из всех своих. В этом вся разница между «подключить ещё один» и
// «переподключить»: адрес и обработка возврата у них одни и те же. Чужой или
// несуществующий id — отказ, а не молчаливое игнорирование: подсказка несёт
// ЧУЖУЮ ПОЧТУ, и отдавать её по перебору id нельзя.
func (s *Service) StartURL(ctx context.Context, provider string, userID, reconnect uuid.UUID, state, verifier string) (string, error) {
	p := s.accountProvider(provider)
	if p == nil {
		return "", domain.ErrNotFound
	}
	hint := ""
	if reconnect != uuid.Nil {
		conn, err := s.accountOfProvider(ctx, provider, userID, reconnect)
		if err != nil {
			return "", err
		}
		hint = conn.Email
	}
	return p.AuthURL(state, verifier, hint), nil
}

// Connect завершает подключение: меняет код на токены, узнаёт аккаунт и кладёт
// refresh шифротекстом. Отдаёт id аккаунта — экран подсвечивает свежий.
//
// Проверять здесь больше нечего, и это следствие модели, а не упущение:
// подключение своего аккаунта Google требует быть собой, а не иметь роль. Кто
// начал поход, говорит подписанная cookie (сессии на колбэке провайдера нет), и
// её подпись — то же доказательство личности, что раньше.
//
// Повторный заход ТЕМ ЖЕ аккаунтом Google обновляет строку, а не заводит
// вторую: арбитр ON CONFLICT — внешний аккаунт. Другим аккаунтом — заводит, и в
// этом вся задача: прежде он затирал первый, оставляя связки писать чужим
// токеном в таблицы, которых тот не видит.
func (s *Service) Connect(ctx context.Context, provider string, userID uuid.UUID, code, verifier string) (uuid.UUID, error) {
	p := s.accountProvider(provider)
	if p == nil {
		return uuid.Nil, domain.ErrNotFound
	}

	tokens, err := p.Exchange(ctx, code, verifier)
	if err != nil {
		return uuid.Nil, err
	}
	account, err := p.Account(ctx, tokens.Access)
	if err != nil {
		return uuid.Nil, err
	}
	sealed, err := sealToken(s.key, tokens.Refresh)
	if err != nil {
		return uuid.Nil, err
	}

	return s.repo.Upsert(ctx, s.db, NewConnection{
		ID:            domain.NewID(),
		UserID:        userID,
		Provider:      p.Provider(),
		ExternalID:    account.ID,
		Email:         account.Email,
		RefreshSealed: sealed,
		Scopes:        tokens.Scopes,
	})
}

// Disconnect отключает ОДИН аккаунт человека. Связки, которые им ехали, уносит
// каскад БД — во всех пространствах разом: иначе форма осталась бы привязанной к
// таблице, писать в которую больше нечем. Соседние аккаунты не затронуты.
//
// Отзыв согласия у провайдера — best effort и НЕ гейтит удаление: недоступный
// Google не должен запирать человека в подключении, которое он разрывает.
// Неудача уходит в лог — там же, где её увидит человек за логом.
func (s *Service) Disconnect(ctx context.Context, provider string, userID, accountID uuid.UUID) error {
	p := s.accountProvider(provider)
	if p == nil {
		return domain.ErrNotFound
	}

	// Id связок читаются ДО удаления: каскад БД унесёт их вместе с аккаунтом, а у
	// строки уведомления внешнего ключа на цель нет (субъект разного вида), и без
	// этого списка поводы о несуществующих связках висели бы до уборщика.
	// Прав здесь не проверяем — это делает сам Delete ниже, и до отбоя дело дойдёт
	// только после его успеха.
	linkIDs, linksErr := s.repo.LinkIDsByAccount(ctx, s.db, accountID)
	if linksErr != nil {
		httpserver.LoggerFrom(ctx).Warn("links of account not listed before disconnect",
			slog.String("account_id", accountID.String()), slog.String("error", linksErr.Error()))
	}

	sealed, err := s.repo.Delete(ctx, s.db, accountID, userID, p.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		// Отключать нечего — уже отключено (или аккаунт чужой, что снаружи
		// неотличимо). Идемпотентно: повторный запрос из второй вкладки не
		// должен краснеть.
		return nil
	}
	if err != nil {
		return fmt.Errorf("disconnect integration: %w", err)
	}
	// Связок больше нет — нет и препятствия: человек отключил аккаунт сам.
	for _, id := range linkIDs {
		s.noticeFixed(ctx, id)
	}

	refresh, err := openToken(s.key, sealed)
	if err != nil {
		// Токен не расшифровался (ротация ключа) — отзывать нечего, но строки
		// уже нет, и это правильный исход: человек отключился.
		httpserver.LoggerFrom(ctx).Warn("integration token not decrypted on disconnect",
			slog.String("account_id", accountID.String()))
		return nil
	}
	if err := p.Revoke(ctx, refresh); err != nil {
		httpserver.LoggerFrom(ctx).Warn("integration token not revoked at provider",
			slog.String("account_id", accountID.String()),
			slog.String("error", err.Error()))
	}
	return nil
}

// Статусы привязки формы (колонка form_integrations.status).
const (
	// StatusLive — доставка идёт.
	StatusLive = "live"
	// StatusBroken — доставка сломалась (доступ отозван, таблица удалена);
	// причина лежит в last_error и показывается человеку.
	StatusBroken = "broken"
)

// sheetTitle — имя листа, который заводим. Русское и человеческое: таблицу
// открывает автор, а не машина.
const sheetTitle = "Ответы"

// Forms — коллаборатор из модуля forms (модули общаются интерфейсами сервисов).
// Get авторизует доступ (чужая или несуществующая → ErrNotFound, инвариант 5),
// Versions отдаёт снапшоты опубликованных версий.
type Forms interface {
	Get(ctx context.Context, userID, formID uuid.UUID) (forms.Form, error)
	Versions(ctx context.Context, userID, formID uuid.UUID) ([]forms.Version, error)
}

// FormStatus — всё, что нужно табу «Интеграции» одной поездкой: подключения
// СПРАШИВАЮЩЕГО (из них он выбирает) и СПИСОК связок этой формы.
type FormStatus struct {
	WorkspaceID uuid.UUID
	// Account — аккаунты спрашивающего, а не пространства: в команде каждый
	// видит в селекте свои. Чужой аккаунт, которым едет соседняя связка, в этом
	// списке не появится — экран показывает его почтой самой связки.
	Account Status
	// Connections — подключённые связки, в порядке подключения. Их сколько
	// угодно, в том числе в одну и ту же книгу: интеграция это правило доставки,
	// а не состояние формы.
	Connections []FormLink
	// Webhooks — вебхуки формы в порядке заведения; без адреса у того, кто не
	// вправе править форму (listWebhooks).
	Webhooks []Webhook
	// Metrika — счётчик Яндекс Метрики формы; nil — не подключён.
	Metrika *Counter
	// Yandex — аккаунты Яндекса спрашивающего (фаза 29): из них выбирается счётчик.
	Yandex Status
}

// FormStatus читает состояние интеграций формы. Право — ActionFormRead внутри
// forms.Get: кто видит форму и её ответы, тот вправе знать, куда они уезжают.
func (s *Service) FormStatus(ctx context.Context, userID, formID uuid.UUID) (FormStatus, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return FormStatus{}, err
	}

	account, err := s.Status(ctx, ProviderGoogle, userID)
	if err != nil {
		return FormStatus{}, err
	}
	yandex, err := s.Status(ctx, ProviderYandex, userID)
	if err != nil {
		return FormStatus{}, err
	}
	links, err := s.repo.ListLinks(ctx, s.db, formID)
	if err != nil {
		return FormStatus{}, fmt.Errorf("form integration status: %w", err)
	}
	canEdit, err := s.canEdit(ctx, form.WorkspaceID, userID)
	if err != nil {
		return FormStatus{}, err
	}
	webhooks, err := s.listWebhooks(ctx, formID, canEdit)
	if err != nil {
		return FormStatus{}, fmt.Errorf("form webhooks: %w", err)
	}
	metrika, err := s.formCounter(ctx, formID, CounterYandexMetrika)
	if err != nil {
		return FormStatus{}, fmt.Errorf("form counters: %w", err)
	}
	// Пустые списки — штатное состояние экрана: у формы просто нет интеграций.
	return FormStatus{
		WorkspaceID: form.WorkspaceID,
		Account:     account,
		Connections: links,
		Webhooks:    webhooks,
		Metrika:     metrika,
		Yandex:      yandex,
	}, nil
}

// canEdit — вопрос «вправе ли править», а не охрана: отказ по праву — это
// false, а не ошибка; всё прочее (сбой базы) — ошибка.
func (s *Service) canEdit(ctx context.Context, workspaceID, userID uuid.UUID) (bool, error) {
	err := s.access.Can(ctx, workspaceID, userID, domain.ActionFormWrite)
	if errors.Is(err, domain.ErrForbidden) {
		return false, nil
	}
	return err == nil, err
}

// ConnectOptions — то, что человек назвал в окне подключения. Настройки
// спрашиваются ДО первой записи в чужие данные и приезжают одним объектом:
// подключение — одно осознанное действие, а не цепочка кнопок, каждая из
// которых уже что-то поменяла.
type ConnectOptions struct {
	// AccountID — каким подключением ехать. Обязателен: аккаунтов у человека
	// сколько угодно, и «подразумеваемого» среди них нет. Проверяется на
	// принадлежность спрашивающему (accountOf) — id из тела правом не является.
	AccountID uuid.UUID
	// Name — необязательная подпись связки. Пусто — экран показывает имя
	// провайдера.
	Name string
	// SpreadsheetID пуст — заводим новую книгу. Иначе работаем в названной: её
	// человек либо создавал через нас, либо выбрал в окне Google (и тем самым
	// выдал нам доступ по drive.file).
	SpreadsheetID string
	// SheetID — существующий лист выбранной книги. nil = завести новый лист.
	// Указатель, а не 0: у первого листа книги gid как раз 0, и «ноль» здесь
	// значил бы «Лист1», а не «не выбрано».
	SheetID *int32
	// Backfill — переносить ли уже накопленные ответы. Выбор человека, а не
	// наше умолчание: у формы может быть пятьдесят тысяч ответов, которые ему в
	// новой таблице не нужны.
	Backfill bool
}

// MaxConnectionNameLen — потолок длины подписи связки. Ввод валидируется на
// бэке независимо от фронта (инвариант 3).
const MaxConnectionNameLen = 80

// ConnectForm заводит таблицу в Диске подключённого аккаунта и привязывает к ней
// форму.
//
// Права два, и они про разное: ActionFormWrite на форму (кто её правит, тот
// решает, куда едут её ответы) и принадлежность аккаунта спрашивающему. Роль в
// пространстве про аккаунт не спрашивают — он личный (ADR §10).
func (s *Service) ConnectForm(ctx context.Context, userID, formID uuid.UUID, opts ConnectOptions) (FormLink, error) {
	if !s.Enabled() {
		return FormLink{}, domain.ErrNotFound
	}
	opts.Name = strings.TrimSpace(opts.Name)
	if utf8.RuneCountInString(opts.Name) > MaxConnectionNameLen {
		return FormLink{}, fmt.Errorf("%w: название длиннее %d символов", domain.ErrValidation, MaxConnectionNameLen)
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return FormLink{}, err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return FormLink{}, err
	}

	conn, err := s.accountOf(ctx, userID, opts.AccountID)
	if err != nil {
		return FormLink{}, err
	}

	builder, err := s.columnModel(ctx, userID, formID)
	if err != nil {
		return FormLink{}, err
	}

	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return FormLink{}, err
	}
	sheet, err := s.newSheet(ctx, token, form, opts)
	if err != nil {
		return FormLink{}, err
	}
	// Шапка пишется сразу: таблица без заголовков — это таблица, в которой
	// человек не поймёт, что за колонки, ещё до первого ответа.
	columns := builder.SheetColumns()
	if err := s.google.WriteHeader(ctx, token, sheet, columnLabels(columns)); err != nil {
		return FormLink{}, err
	}

	link := NewFormLink{
		ID:             domain.NewID(),
		FormID:         formID,
		AccountID:      conn.ID,
		Name:           opts.Name,
		SpreadsheetID:  sheet.ID,
		SpreadsheetURL: sheet.URL,
		SheetID:        sheet.SheetID,
		SheetTitle:     sheet.Title,
		Columns:        columns,
		Status:         StatusLive,
	}
	// Связка и очередь накопленных ложатся ОДНОЙ транзакцией.
	//
	// Иначе сбой между ними (обрыв к БД, отменённый контекст запроса) отдаёт
	// человеку ошибку при уже созданной связке: он жмёт «Подключить» второй раз,
	// в Диске появляется вторая книга, и каждый ответ с этого момента уезжает в
	// две таблицы — обе выглядят рабочими. Таблица в Диске, впрочем, останется
	// висеть в любом случае: её создание чужому откату не подлежит.
	//
	// Живой ответ, принятый в эти же секунды, в очередь встать ещё не может:
	// ветка CTE приёма видит связку только после коммита. Значит, вся пачка
	// переноса получает одно время постановки, и порядок в листе задаёт id
	// ответа — то есть хронология.
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.repo.InsertLink(ctx, tx, link); err != nil {
			return err
		}
		if !opts.Backfill {
			return nil
		}
		_, err := s.repo.EnqueueSheetBackfill(ctx, tx, link.ID, formID)
		return err
	})
	if err != nil {
		return FormLink{}, err
	}

	return FormLink{
		ID:             link.ID,
		FormID:         formID,
		AccountID:      conn.ID,
		Enabled:        true,
		WorkspaceID:    form.WorkspaceID,
		AccountUserID:  conn.UserID,
		AccountEmail:   conn.Email,
		SpreadsheetID:  sheet.ID,
		SpreadsheetURL: sheet.URL,
		SheetID:        sheet.SheetID,
		SheetTitle:     sheet.Title,
		Columns:        link.Columns,
		Name:           opts.Name,
		Status:         StatusLive,
	}, nil
}

// newSheet отдаёт лист, в который поедут ответы: новая книга, новая вкладка в
// существующей или уже существующая вкладка.
func (s *Service) newSheet(ctx context.Context, token string, form forms.Form, opts ConnectOptions) (Spreadsheet, error) {
	if opts.SpreadsheetID == "" {
		return s.google.CreateSpreadsheet(ctx, token, spreadsheetTitle(form), sheetTitle)
	}
	if opts.SheetID == nil {
		return s.google.AddSheet(ctx, token, opts.SpreadsheetID, sheetTitleForForm(form))
	}
	return s.existingSheet(ctx, token, opts.SpreadsheetID, *opts.SheetID)
}

// existingSheet готовит уже существующий лист под ответы.
//
// Первая строка обязана быть свободна: шапка ложится в A1, и лист с данными в
// первой строке мы бы молча затёрли — чужую работу, которую никто не просил
// трогать. Отказ здесь человеческий и с выходом: рядом есть «создать новый
// лист», и он всегда сработает.
func (s *Service) existingSheet(ctx context.Context, token, spreadsheetID string, sheetID int32) (Spreadsheet, error) {
	sheets, err := s.google.ListSheets(ctx, token, spreadsheetID)
	if err != nil {
		return Spreadsheet{}, err
	}
	idx := slices.IndexFunc(sheets, func(sh SheetRef) bool { return sh.ID == sheetID })
	if idx < 0 {
		return Spreadsheet{}, fmt.Errorf("%w: лист не найден в этой таблице", domain.ErrValidation)
	}

	url, err := s.google.SpreadsheetURL(ctx, token, spreadsheetID)
	if err != nil {
		return Spreadsheet{}, err
	}
	sheet := Spreadsheet{ID: spreadsheetID, URL: url, SheetID: sheetID, Title: sheets[idx].Title}

	empty, err := s.google.FirstRowEmpty(ctx, token, sheet)
	if err != nil {
		return Spreadsheet{}, err
	}
	if !empty {
		return Spreadsheet{}, fmt.Errorf(
			"%w: Лист «%s» не пустой — выберите пустой лист или создайте новый",
			domain.ErrValidation, sheets[idx].Title)
	}
	return sheet, nil
}

// Sheets — листы выбранной книги: второй шаг выбора («положить в существующий
// лист или завести новый»).
//
// Спрашивается про АККАУНТ, а не про форму: книга лежит в чужом Диске, и право
// на её оглавление даёт владение аккаунтом, а не роль в каком-либо пространстве.
func (s *Service) Sheets(ctx context.Context, userID, accountID uuid.UUID, spreadsheetID string) ([]SheetRef, error) {
	if !s.Enabled() {
		return nil, domain.ErrNotFound
	}
	if spreadsheetID == "" {
		return nil, fmt.Errorf("%w: таблица не выбрана", domain.ErrValidation)
	}
	conn, err := s.accountOf(ctx, userID, accountID)
	if err != nil {
		return nil, err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return nil, err
	}
	return s.google.ListSheets(ctx, token, spreadsheetID)
}

// PickerCredentials — то, чем браузер открывает окно выбора файла Google.
//
// AccessToken уезжает В БРАУЗЕР — единственное место, где мы это делаем.
// Причина: окно выбора рисует сам Google, и токен ему нужен на стороне клиента.
// Плата названа в ADR §10; смягчение — короткий срок (час) и узкий scope
// drive.file, то есть токен не открывает ничего, кроме файлов, которые и так
// создало это приложение для этого же человека.
type PickerCredentials struct {
	AccessToken  string
	DeveloperKey string
	// AppID — номер проекта Google Cloud. Picker обязан его знать, чтобы выбранный
	// файл был выдан ИМЕННО НАШЕМУ приложению по scope drive.file. Берётся из
	// client_id (его префикс до дефиса) — отдельной переменной окружения этот
	// номер не заслуживает.
	AppID string
}

// PickerAvailable — настроено ли окно выбора файла на этом контуре.
func (s *Service) PickerAvailable() bool { return s.Enabled() && s.pickerKey != "" }

// Picker выдаёт браузеру credentials окна выбора.
//
// Право — принадлежность аккаунта спрашивающему, и это сильнее прежнего гейта по
// роли, а не слабее. То, что уезжает в браузер, — access-токен со scope
// drive.file, то есть полный доступ ко ВСЕМ файлам, созданным приложением в этом
// аккаунте Google. Пока аккаунт принадлежал пространству, «свой» токен открывал
// чужие таблицы, и спасала только роль владельца; теперь человек получает токен
// исключительно на СВОЙ аккаунт, и открыть чужое им нечего (ADR §10).
func (s *Service) Picker(ctx context.Context, userID, accountID uuid.UUID) (PickerCredentials, error) {
	if !s.PickerAvailable() {
		return PickerCredentials{}, domain.ErrNotFound
	}
	conn, err := s.accountOf(ctx, userID, accountID)
	if err != nil {
		return PickerCredentials{}, err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return PickerCredentials{}, err
	}
	return PickerCredentials{
		AccessToken:  token,
		DeveloperKey: s.pickerKey,
		AppID:        s.google.AppID(),
	}, nil
}

// Spreadsheets — таблицы, которые приложение создавало в этом аккаунте Google.
//
// Список не ограничен пространством и ограничен быть не может: под drive.file в
// нём лежат все созданные нами файлы этого аккаунта. Роли для него не нужно —
// аккаунт свой, и раскрывать в нём человеку нечего.
func (s *Service) Spreadsheets(ctx context.Context, userID, accountID uuid.UUID) ([]SpreadsheetRef, error) {
	if !s.Enabled() {
		return nil, domain.ErrNotFound
	}
	conn, err := s.accountOf(ctx, userID, accountID)
	if err != nil {
		return nil, err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return nil, err
	}
	return s.google.ListSpreadsheets(ctx, token)
}

// sheetTitleForForm — имя ВКЛАДКИ в чужой книге. Google запрещает две вкладки с
// одинаковым именем, а форм с одинаковым названием у автора сколько угодно —
// поэтому к названию добавляется slug формы, уникальный по определению.
func sheetTitleForForm(form forms.Form) string {
	name := []rune(spreadsheetTitle(form))
	// Потолок имени листа у Google — 100 символов; оставляем запас под slug.
	if len(name) > 80 {
		name = name[:80]
	}
	return strings.TrimSuffix(string(name), " — ответы") + " · " + form.Slug
}

// RecheckForm перепроверяет, годен ли лист к записи, и снимает поломку, если
// годен. Право — ActionFormWrite, как у прочих операций над связкой.
//
// Нужен затем, что раскладка ломается ПРАВКОЙ ЛИСТА, а лист — чужая территория:
// поправив шапку обратно, человек не имеет никакого способа сказать нам об этом.
// Без этой ручки ему оставалось бы ждать следующего ответа респондента, чтобы
// узнать, помогло ли, — и получить второй потерянный ответ, если нет.
//
// Проверка идёт ТЕМ ЖЕ reconcileColumns, что и доставка, а не своей копией
// правил: две реализации одного вопроса «годится ли лист» разъедутся, и экран
// начнёт обещать то, чего доставка не сделает. Побочно это и приводит лист в
// порядок — дописывает колонки вопросов, появившихся, пока связка стояла.
//
// ⚠ Ответы, пришедшие ЗА ВРЕМЯ поломки, снятие статуса не возвращает: их события
// погашены (§6), и в листе их нет. Лечение для них — перезалив, и экран говорит
// об этом отдельно.
func (s *Service) RecheckForm(ctx context.Context, userID, formID, linkID uuid.UUID) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	link, err := s.linkOfForm(ctx, formID, linkID)
	if err != nil {
		return err
	}
	conn, err := s.accountForLink(ctx, link)
	if err != nil {
		return err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return err
	}
	builder, err := s.columnModel(ctx, userID, formID)
	if err != nil {
		return err
	}

	if _, err := s.reconcileColumns(ctx, token, link, builder.SheetColumns()); err != nil {
		if !errors.Is(err, ErrPermanent) {
			return err
		}
		// Причина могла смениться, пока человек правил лист: показываем то, что
		// мешает СЕЙЧАС, а не то, на чём связка встала в прошлый раз.
		cause := brokenReason(err)
		if markErr := s.repo.MarkBroken(ctx, s.db, link.ID, cause); markErr != nil {
			return markErr
		}
		return fmt.Errorf("%w: %s", domain.ErrValidation, cause)
	}
	if err := s.repo.ClearError(ctx, s.db, link.ID); err != nil {
		return err
	}
	s.noticeFixed(ctx, link.ID)
	return nil
}

// RefillForm перезаливает лист с нуля: чистит значения, пишет свежую шапку и
// заново переносит все ответы.
//
// Кнопка нужна независимо от догрузки и лечит всё, что накопилось между: дубль
// после ретрая, строки, удалённые автором руками, колонки, отставшие от формы,
// и интеграцию, простоявшую сломанной. Формат листа (ширина колонок, закрепление
// шапки) переживает чистку — чистятся значения, а не лист.
func (s *Service) RefillForm(ctx context.Context, userID, formID, linkID uuid.UUID) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	link, err := s.linkOfForm(ctx, formID, linkID)
	if err != nil {
		return err
	}

	conn, err := s.accountForLink(ctx, link)
	if err != nil {
		return err
	}
	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return err
	}

	// Шапка пересобирается по СЕГОДНЯШНЕЙ форме: в ней могли появиться вопросы,
	// а колонки листа отстать. Прежние ключи при этом остаются на своих местах —
	// колонка только добавляется (спека §8).
	builder, err := s.columnModel(ctx, userID, formID)
	if err != nil {
		return err
	}
	columns := mergeColumns(link.Columns, builder.SheetColumns())

	if err := s.google.ClearSheet(ctx, token, spreadsheetOf(link)); err != nil {
		return err
	}
	if err := s.google.WriteHeader(ctx, token, spreadsheetOf(link), columnLabels(columns)); err != nil {
		return err
	}
	if err := s.repo.UpdateLinkColumns(ctx, s.db, link.ID, columns); err != nil {
		return err
	}
	return s.refillQueue(ctx, link.ID, formID)
}

// DeliveryPageSize — сколько попыток отдаётся одной страницей ленты. Потолок,
// а не настройка: страница длиннее экрана всё равно читается прокруткой, а
// курсор у ленты уже есть.
const DeliveryPageSize = 50

// Deliveries — страница журнала доставок связки, новые сверху. Пустой курсор =
// первая страница.
//
// Право — form.write, как у правки связки: журнал раскрывает причины отказов
// провайдера и адреса чужих таблиц, и это не то, что показывают всякому, кто
// умеет открыть форму.
func (s *Service) Deliveries(ctx context.Context, userID, formID, linkID, cursor uuid.UUID) ([]Delivery, error) {
	if !s.Enabled() {
		return nil, domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return nil, err
	}
	link, err := s.linkOfForm(ctx, formID, linkID)
	if err != nil {
		return nil, err
	}
	return s.repo.ListDeliveries(ctx, s.db, link.ID, cursor, DeliveryPageSize)
}

// RetryDelivery ставит доставку ЗАНОВО по тому же ответу — обычным событием
// очереди, через те же проверки членства, тумблера и колонок.
//
// ⚠ Повтор возможен только у неуспешной попытки живого ответа. Успешную не
// повторяют потому, что у values.append нет идемпотентности: строка легла бы в
// лист вторым разом. Пачку переноса — потому что её предмет не строка, а
// диапазон, и лечится он перезаливом целиком.
//
// ⚠ У СЛОМАННОЙ связки повтор отказывает, а не ставит событие: Deliver гасит
// события такой связки первой же проверкой, и кнопка молча ничего не делала бы.
// Сначала лечение (вернуть шапку, сменить цель, перезалить), потом повтор.
func (s *Service) RetryDelivery(ctx context.Context, userID, formID, linkID, deliveryID uuid.UUID) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	link, err := s.linkOfForm(ctx, formID, linkID)
	if err != nil {
		return err
	}
	d, err := s.repo.GetDelivery(ctx, s.db, deliveryID, link.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	if err != nil {
		return err
	}
	if d.Kind != DeliveryKindSubmission || d.SubmissionID == uuid.Nil {
		return fmt.Errorf("%w: повторить можно только доставку одного ответа", domain.ErrValidation)
	}
	// ⚠ Спрашивается судьба ОТВЕТА, а не исход этой записи. Строка журнала = одна
	// попытка, и у ответа, доехавшего со второго раза (503 → бэкофф → успех),
	// первая навсегда остаётся неудачной: гейт по её исходу держал бы живую
	// кнопку «Повторить» под ответом, который в таблице уже лежит, — и клик клал
	// бы туда второй экземпляр. У `values.append` идемпотентности нет.
	delivered, err := s.repo.SubmissionDelivered(ctx, s.db, link.ID, d.SubmissionID)
	if err != nil {
		return err
	}
	if delivered {
		return fmt.Errorf("%w: этот ответ уже в таблице", domain.ErrValidation)
	}
	if link.Status == StatusBroken {
		return fmt.Errorf("%w: сначала устраните причину поломки связки", domain.ErrConflict)
	}
	// Выключенная связка отказывает по тому же основанию, что и сломанная:
	// доставщик её не берёт (DueSheetLinks), и повтор просто лёг бы в очередь,
	// из которой никто не возьмёт, — а экран показывал бы «в очереди 1» без
	// движения. До переезда на очередь этой ветки не было: событие outbox
	// гасилось при доставке, то есть повтор молча уходил в никуда.
	if !link.Enabled {
		return fmt.Errorf("%w: связка выключена — включите её, чтобы повторить", domain.ErrConflict)
	}
	if err := s.repo.EnqueueSheet(ctx, s.db, link.ID, d.SubmissionID); err != nil {
		return err
	}
	// Связка после неудачи спит до конца окна бэкоффа, и без пробуждения человек,
	// устранивший причину, ждал бы до часа, глядя на кнопку, которая «сработала».
	// Нажатие и означает «причину устранил, попробуй сейчас»: расписание
	// начинается заново, как после перепроверки.
	if err := s.repo.ClearError(ctx, s.db, link.ID); err != nil {
		return err
	}
	s.noticeFixed(ctx, link.ID)
	return nil
}

// DeliveryTTL — сколько живёт запись журнала. Константа, а не переменная
// окружения (тот же довод, что у submissions.PartialTTL): журнал
// диагностический, месяца хватает на вопрос «почему вчера не уехало», а ещё
// одна строка конфига дороже пользы.
const DeliveryTTL = 30 * 24 * time.Hour

// CleanupDeliveries убирает записи журнала старше срока хранения и отдаёт их
// число. Зовётся периодической задачей: без срока таблица растёт со скоростью
// потока ответов и не останавливается никогда.
func (s *Service) CleanupDeliveries(ctx context.Context) (int64, error) {
	return s.repo.DeleteOldDeliveries(ctx, s.db, time.Now().UTC().Add(-DeliveryTTL))
}

// mergeColumns дописывает к колонкам листа те, которых в нём ещё нет. Порядок
// прежних не меняется: автор мог свести их формулами справа, и перестановка
// сломала бы его таблицу молча.
func mergeColumns(known, actual []domain.SheetColumn) []domain.SheetColumn {
	seen := make(map[string]bool, len(known))
	for _, c := range known {
		seen[c.Key] = true
	}
	out := known
	for _, c := range actual {
		if !seen[c.Key] {
			out = append(out, c)
		}
	}
	return out
}

// DisconnectForm удаляет ОДНУ связку. Таблица в Диске автора остаётся со всеми
// строками: продукт не удаляет чужие файлы — ни за человека, ни «прибираясь».
func (s *Service) DisconnectForm(ctx context.Context, userID, formID, linkID uuid.UUID) error {
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	// Ноль строк — связки нет либо она чужой формы. Одинаковый ответ на оба
	// случая: существование чужого не раскрывается даже отказом (инвариант 5).
	n, err := s.repo.DeleteLink(ctx, s.db, linkID, formID)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	// Цели больше нет — препятствия тоже: человек сносит сломанную связку именно
	// потому, что она сломана.
	s.noticeFixed(ctx, linkID)
	return nil
}

// ConnectionPatch — правка связки с того же экрана, на котором её подключали.
//
// Тот же экран не прихоть: подключение и правка отвечают на одни и те же
// вопросы («куда лить, под каким именем, переносить ли историю»), и второй
// экран с другой раскладкой заставлял бы человека заново искать, где что.
type ConnectionPatch struct {
	Name    string
	Enabled bool
	// Target — куда лить: АККАУНТ и лист вместе. Совпали с текущими — связка
	// остаётся на месте, и мы не трогаем ни лист, ни колонки. Отличается хоть
	// одно — связка ПЕРЕЕЗЖАЕТ: в новом листе пишется шапка, колонки собираются
	// заново.
	//
	// Аккаунт и лист неразделимы не по прихоти экрана: под scope drive.file
	// таблица видна только создавшему её аккаунту, поэтому «сменить аккаунт,
	// оставив лист» — это запись чужим токеном в невидимый ему файл, то есть 404
	// и красная связка. Человек в окне видит то же самое: сменил аккаунт —
	// список таблиц перечитался под новый.
	Target ConnectOptions
	// RetargetOnly — правка пришла без выбора цели (например, только тумблер из
	// списка). Тогда цель не трогаем вовсе.
	KeepTarget bool
}

// UpdateConnection правит подпись, тумблер и цель связки.
//
// Выключенная связка сохраняет таблицу, колонки и историю: «выключить на время»
// и «удалить навсегда» — разные намерения, и подменять первое вторым нельзя.
func (s *Service) UpdateConnection(ctx context.Context, userID, formID, linkID uuid.UUID, patch ConnectionPatch) error {
	if err := s.canEditForm(ctx, userID, formID); err != nil {
		return err
	}
	name := strings.TrimSpace(patch.Name)
	if utf8.RuneCountInString(name) > MaxConnectionNameLen {
		return fmt.Errorf("%w: название длиннее %d символов", domain.ErrValidation, MaxConnectionNameLen)
	}
	// Цель разбирается ДО первой записи. Иначе правка с недопустимым аккаунтом
	// успевает сохранить подпись и падает уже после — человек видит отказ и
	// изменившееся название разом.
	//
	// Частичность на этом не исчезает совсем: отказ ПРОВАЙДЕРА (Google
	// недоступен, лист занят) по-прежнему приходит после записи подписи. Лечится
	// транзакцией поверх обеих записей и в эту задачу не входит.
	var link FormLink
	var conn Connection
	if !patch.KeepTarget {
		found, err := s.linkOfForm(ctx, formID, linkID)
		if err != nil {
			return err
		}
		account, err := s.targetAccount(ctx, userID, found, patch.Target.AccountID)
		if err != nil {
			return err
		}
		link, conn = found, account
		patch.Target.AccountID = account.ID
	}

	n, err := s.repo.UpdateLinkSettings(ctx, s.db, linkID, formID, name, patch.Enabled)
	if err != nil {
		return err
	}
	if n == 0 {
		return domain.ErrNotFound
	}
	if !patch.Enabled {
		// Тумблер «выключить» — это «не доставлять», а не «доставить позже»:
		// ждущие ответы снимаются тем же движением, иначе включение вывалило бы
		// в лист всё накопленное разом.
		if err := s.repo.ClearSheetQueue(ctx, s.db, linkID); err != nil {
			return err
		}
	}
	if patch.KeepTarget {
		return nil
	}
	return s.retarget(ctx, userID, link, conn, patch.Target)
}

// targetAccount — каким аккаунтом связка поедет после правки.
//
// Два случая, и различать их обязательно. Аккаунт НЕ МЕНЯЕТСЯ (не назван либо
// назван тот же) — связка остаётся на своём, и требовать, чтобы он принадлежал
// правящему, нельзя: иначе участник не смог бы переименовать связку коллеги, ту
// самую, которую экран ему штатно показывает. Аккаунт МЕНЯЕТСЯ — новый обязан
// быть своим: id приезжает в теле запроса и правом доступа не является.
func (s *Service) targetAccount(ctx context.Context, userID uuid.UUID, link FormLink, want uuid.UUID) (Connection, error) {
	if want == uuid.Nil || want == link.AccountID {
		return s.accountForLink(ctx, link)
	}
	return s.accountOf(ctx, userID, want)
}

// retarget переносит связку в другой лист, если человек выбрал другой.
//
// Строки, уже доставленные в прежний лист, остаются там: убирать за человеком в
// его же таблице — не наше дело, и «переехали» не значит «сотрите прошлое».
func (s *Service) retarget(ctx context.Context, userID uuid.UUID, link FormLink, conn Connection, target ConnectOptions) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	if sameTarget(link, target) {
		return nil
	}
	formID := link.FormID

	token, err := s.accessToken(ctx, conn)
	if err != nil {
		return err
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return err
	}

	sheet, err := s.newSheet(ctx, token, form, target)
	if err != nil {
		return err
	}
	builder, err := s.columnModel(ctx, userID, formID)
	if err != nil {
		return err
	}
	columns := builder.SheetColumns()
	if err := s.google.WriteHeader(ctx, token, sheet, columnLabels(columns)); err != nil {
		return err
	}

	// Колонки собираются ЗАНОВО, а не переносятся: новый лист пуст, и держать в
	// нём колонки вопросов, которых в форме уже нет, незачем.
	if _, err := s.repo.UpdateLinkTarget(ctx, s.db, link.ID, formID, conn.ID, sheet, columns); err != nil {
		return err
	}
	// Запись цели снимает поломку (status='live' в самом утверждении) — значит,
	// снимает и повод о ней. Отбой стоит ЗДЕСЬ, а не только в refillQueue ниже:
	// перенос накопленных у существующей связки по умолчанию выключен, то есть
	// самый обычный путь починки «выбрать другую таблицу» проходил мимо него.
	s.noticeFixed(ctx, link.ID)
	if !target.Backfill {
		// Ответы, ждавшие прежнюю цель, остаются в очереди и поедут в новую: они
		// не доставлены никуда, и терять их переезд не повод. «Не переносить
		// накопленные» — про то, что уже лежит в базе, а не про очередь.
		return nil
	}
	return s.refillQueue(ctx, link.ID, formID)
}

// refillQueue ставит в очередь связки все накопленные ответы формы, сняв с неё
// то, что ждало раньше. Одной транзакцией: между чисткой и постановкой связка
// иначе на мгновение остаётся с пустой очередью, и тик доставщика, попавший в
// это окно, увёз бы в лист ничего — а пришедший следом живой ответ лёг бы ПЕРЕД
// накопленными.
//
// ⚠ Мина: пересборка очереди ОБЯЗАНА снимать поломку (`ClearError`), и той же
// транзакцией. Оба вызывающих — явные действия человека «вези заново», а
// доставщик сломанную связку не берёт вовсе (`DueSheetLinks`): без этого
// перезалив оставлял бы вычищенный лист, полную очередь и красную точку
// навсегда. Он к тому же и заводится ИЗ предупреждения о поломке — другого
// входа в него на экране нет. У переезда на другую цель поломка снимается ещё и
// записью самой цели, и второй раз она ничего не портит.
func (s *Service) refillQueue(ctx context.Context, linkID, formID uuid.UUID) error {
	err := s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.repo.ClearError(ctx, tx, linkID); err != nil {
			return err
		}
		if err := s.repo.ClearSheetQueue(ctx, tx, linkID); err != nil {
			return err
		}
		_, err := s.repo.EnqueueSheetBackfill(ctx, tx, linkID, formID)
		return err
	})
	if err != nil {
		return err
	}
	// Отбой — ПОСЛЕ коммита, а не внутри транзакции: откат унёс бы снятие поломки,
	// но не унёс бы погашенное уведомление.
	s.noticeFixed(ctx, linkID)
	return nil
}

// sameTarget отвечает, указывает ли правка на ту же пару «аккаунт + лист», что
// уже привязана. Пустой SpreadsheetID означает «завести новую книгу» — это
// всегда переезд.
//
// Аккаунт участвует в сравнении наравне с листом: тот же id таблицы у ДРУГОГО
// аккаунта — это другой файл в другом Диске (человек мог выбрать через окно
// Google расшаренную копию), и «ничего не изменилось» здесь было бы неправдой.
func sameTarget(link FormLink, target ConnectOptions) bool {
	if target.AccountID != link.AccountID {
		return false
	}
	if target.SpreadsheetID == "" || target.SpreadsheetID != link.SpreadsheetID {
		return false
	}
	return target.SheetID != nil && *target.SheetID == link.SheetID
}

// canEditForm — общее начало операций над связками: форма видна спрашивающему
// (иначе 404) и он вправе её править.
func (s *Service) canEditForm(ctx context.Context, userID, formID uuid.UUID) error {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return err
	}
	return s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite)
}

// linkOfForm читает связку, убеждаясь, что она принадлежит названной форме: id
// связки приезжает из адреса, и правом доступа сам по себе не является.
func (s *Service) linkOfForm(ctx context.Context, formID, linkID uuid.UUID) (FormLink, error) {
	link, err := s.repo.GetLinkByID(ctx, s.db, linkID)
	if errors.Is(err, pgx.ErrNoRows) {
		return FormLink{}, domain.ErrNotFound
	}
	if err != nil {
		return FormLink{}, err
	}
	if link.FormID != formID {
		return FormLink{}, domain.ErrNotFound
	}
	return link, nil
}

// columnLabels — подписи колонок в порядке листа (шапка).
func columnLabels(columns []domain.SheetColumn) []string {
	out := make([]string, len(columns))
	for i, c := range columns {
		out[i] = c.Label
	}
	return out
}

// spreadsheetTitle — имя файла в Диске автора. Внутреннее имя формы (если задано)
// человеку роднее публичного заголовка: в Диске он ищет глазами то же, что видит
// в дашборде.
func spreadsheetTitle(form forms.Form) string {
	name := form.Title
	if form.Name != nil && *form.Name != "" {
		name = *form.Name
	}
	if strings.TrimSpace(name) == "" {
		name = "Форма"
	}
	return name + " — ответы"
}

// columnModel строит модель колонок формы — ту же, что у выгрузки CSV, сводки и
// воронки (domain.QuestionOrder). Колонки таблицы обязаны совпадать с колонками
// выгрузки: иначе два ответа на вопрос «какие у формы вопросы».
//
// Близнец — versionedSchemas в internal/submissions: там она приватная, и
// вытаскивать её в общий пакет ради одного второго потребителя рано.
func (s *Service) columnModel(ctx context.Context, userID, formID uuid.UUID) (*domain.CSVBuilder, error) {
	versions, err := s.forms.Versions(ctx, userID, formID)
	if err != nil {
		return nil, err
	}
	vs := make([]domain.VersionedSchema, 0, len(versions))
	for _, v := range versions {
		schema, e := domain.ValidateSchema(v.Schema)
		if e != nil {
			// Опубликованный снапшот обязан быть валиден (проверен при
			// публикации). %v, а не %w: сентинел ErrValidation в цепочке дал бы
			// 422 с внутренним текстом вместо честной 500.
			return nil, fmt.Errorf("parse version %d schema of form %s: %v", v.Number, formID, e)
		}
		vs = append(vs, domain.VersionedSchema{Version: int(v.Number), Schema: schema})
	}
	return domain.NewCSVBuilder(vs), nil
}

// accessToken отдаёт свежий access-токен подключения: расшифровать refresh и
// обменять его. ЕДИНСТВЕННОЕ место расшифровки — всё, что ходит к провайдеру от
// имени человека, идёт через него.
func (s *Service) accessToken(ctx context.Context, conn Connection) (string, error) {
	refresh, err := openToken(s.key, conn.RefreshSealed)
	if err != nil {
		return "", err
	}
	// Токен обновляет провайдер САМОЙ строки: аккаунт Яндекса обменивается у
	// Яндекса, как бы его ни достали. Ключи провайдера сняли с контура — ходить не
	// к кому, и это отказ, а не паника на nil.
	p := s.accountProvider(conn.Provider)
	if p == nil {
		return "", fmt.Errorf("%w: провайдер %s не настроен на контуре", domain.ErrNotFound, conn.Provider)
	}
	tokens, err := p.Refresh(ctx, refresh)
	if err != nil {
		// Умер не лист, а ПОДКЛЮЧЕНИЕ: не работает ни одна его связка, во всех
		// формах и пространствах. Пометка стоит ЗДЕСЬ, а не на разборе отказа
		// доставки, потому что сюда сходятся ВСЕ походы к провайдеру: перезалив,
		// перепроверка, список таблиц, окно выбора файла. Знание о смерти
		// аккаунта не должно зависеть от того, каким путём мы за ним пошли, —
		// тем более что снимается пометка тоже здесь (ниже), и односторонняя
		// симметрия однажды оставила бы аккаунт красным навсегда.
		//
		// Неудача пометки не роняет операцию: у вызывающего своя беда, а пометка
		// догонит следующим походом (запись идемпотентна — держит ПЕРВЫЙ момент).
		if errors.Is(err, ErrAccessLost) {
			if markErr := s.repo.MarkAccessLost(ctx, s.db, conn.ID, time.Now()); markErr != nil {
				httpserver.LoggerFrom(ctx).Warn("access-lost mark not stored",
					slog.String("account_id", conn.ID.String()),
					slog.String("error", markErr.Error()))
			}
		}
		return "", err
	}
	// Согласие вернули (или мы ошиблись, пометив) — гасим пометку здесь, а не
	// только при переподключении: доступ возвращают и в самом Google, и тогда
	// чинить человеку нечего, а красный аккаунт в кабинете остался бы навсегда.
	if !conn.AccessLostAt.IsZero() {
		if err := s.repo.ClearAccessLost(ctx, s.db, conn.ID); err != nil {
			httpserver.LoggerFrom(ctx).Warn("access-lost mark not cleared",
				slog.String("account_id", conn.ID.String()),
				slog.String("error", err.Error()))
		}
	}
	s.keepRotatedToken(ctx, conn, refresh, tokens.Refresh)
	return tokens.Access, nil
}

// keepRotatedToken сохраняет refresh-токен, если провайдер прислал новый взамен
// использованного. Google так не делает, но поле в ответе есть у всех, а
// выброшенный новый токен означает подключение, которое перестанет работать в
// момент, когда провайдер погасит старый.
//
// Неудача записи НЕ роняет операцию: access-токен на руках и действителен, а
// цена несохранённой ротации — один поход к провайдеру заново.
func (s *Service) keepRotatedToken(ctx context.Context, conn Connection, used, fresh string) {
	if fresh == "" || fresh == used {
		return
	}
	sealed, err := sealToken(s.key, fresh)
	if err == nil {
		err = s.repo.UpdateToken(ctx, s.db, conn.ID, sealed)
	}
	if err != nil {
		httpserver.LoggerFrom(ctx).Warn("rotated refresh token not stored",
			slog.String("account_id", conn.ID.String()),
			slog.String("error", err.Error()))
	}
}
