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
	Delete(ctx context.Context, db postgres.DBTX, id, userID uuid.UUID) ([]byte, error)
	UpdateToken(ctx context.Context, db postgres.DBTX, id uuid.UUID, sealed []byte) error
	GetAccountByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Connection, error)
	InsertLink(ctx context.Context, db postgres.DBTX, l NewFormLink) error
	ListLinks(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]FormLink, error)
	EnabledLinkIDs(ctx context.Context, db postgres.DBTX, formID uuid.UUID) ([]uuid.UUID, error)
	DeleteLink(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error)
	UpdateLinkSettings(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID, name string, enabled bool) (int64, error)
	UpdateLinkTarget(ctx context.Context, db postgres.DBTX, id, formID, accountID uuid.UUID, sheet Spreadsheet, columns []domain.SheetColumn, status string) (int64, error)
	GetLinkByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (FormLink, error)
	StartBackfill(ctx context.Context, db postgres.DBTX, id uuid.UUID, before time.Time) error
	FinishBackfill(ctx context.Context, db postgres.DBTX, id uuid.UUID) error
	UpdateLinkColumns(ctx context.Context, db postgres.DBTX, id uuid.UUID, columns []domain.SheetColumn) error
	MarkDelivered(ctx context.Context, db postgres.DBTX, id uuid.UUID) error
	MarkBroken(ctx context.Context, db postgres.DBTX, id uuid.UUID, cause string) error
}

var _ Store = Repo{}

// Provider — внешний сервис, к которому подключаются. Интерфейс, а не *Google:
// на его место в тестах встаёт httptest-сервер, а вторым провайдером (Excel
// Online, Airtable) станет вторая реализация без правки сервиса.
type Provider interface {
	Provider() string
	AuthURL(state, verifier, loginHint string) string
	Exchange(ctx context.Context, code, verifier string) (Tokens, error)
	Refresh(ctx context.Context, refresh string) (Tokens, error)
	Account(ctx context.Context, accessToken string) (Account, error)
	Revoke(ctx context.Context, refresh string) error

	// Операции с таблицами живут в том же интерфейсе, а не в отдельном:
	// провайдер сегодня один, и делить его надвое стоит тогда, когда появится
	// второй, у которого таблиц нет (YAGNI, PROCESS §2).
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
	AppendRow(ctx context.Context, accessToken string, s Spreadsheet, row []string) error
	AppendRows(ctx context.Context, accessToken string, s Spreadsheet, rows [][]string) error
	ClearSheet(ctx context.Context, accessToken string, s Spreadsheet) error
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
	// outbox и submissions — доставка ответов (слайс C). Подключаются сеттером
	// WithDelivery; nil означает «сборка без доставки» (её нет в тестах привязки).
	outbox      Outbox
	submissions Submissions
	// pickerKey — браузерный ключ для окна выбора файла (см. WithPicker).
	pickerKey string
	google    Provider
	// key — общий секрет приложения (FORM_TOKEN_SECRET). Из него HKDF выводит
	// ключ шифрования refresh-токенов; сам он здесь не используется ни для чего
	// другого и наружу не отдаётся.
	key []byte
}

func NewService(db postgres.DBTX, tx Transactor, repo Store, access Access, f Forms, google Provider, key []byte) *Service {
	return &Service{db: db, tx: tx, repo: repo, access: access, forms: f, google: google, key: key}
}

// WithPicker включает окно выбора файла на Google Диске. Ключ — браузерный
// API-key из того же проекта Google Cloud; пусто = кнопки выбора нет, и
// интеграция работает как раньше (создать новую или взять созданную нами).
func (s *Service) WithPicker(apiKey string) *Service {
	s.pickerKey = apiKey
	return s
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
	// NeedsReconnect — строка подключения есть, но refresh-токен ею больше не
	// расшифровывается: ключ шифрования выведен из FORM_TOKEN_SECRET, и его
	// ротация оставляет за собой шифротекст, которым нельзя пользоваться
	// (secretbox.go). Лечение другое, чем у «нет аккаунта»: не «подключите», а
	// «подключите ЗАНОВО», и до этого ни одна связка этого аккаунта работать не
	// будет. Без этого поля экран показывал бы зелёное «подключено», а падало бы
	// всё подряд — молча, до первого ответа респондента.
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
func (s *Service) Status(ctx context.Context, userID uuid.UUID) (Status, error) {
	if !s.Enabled() {
		return Status{}, nil
	}
	conns, err := s.repo.ListByUser(ctx, s.db, userID, s.google.Provider())
	if err != nil {
		return Status{}, fmt.Errorf("integration status: %w", err)
	}
	out := Status{Enabled: true, PickerEnabled: s.PickerAvailable(), Accounts: make([]ConnectedAccount, 0, len(conns))}
	for _, c := range conns {
		// Расшифровка — не поход к провайдеру, а AES-GCM над сотней байт: платить
		// за неё показом таба дешевле, чем врать про рабочее подключение.
		_, tokenErr := openToken(s.key, c.RefreshSealed)
		out.Accounts = append(out.Accounts, ConnectedAccount{
			ID:             c.ID,
			Email:          c.Email,
			NeedsReconnect: tokenErr != nil,
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
	conn, err := s.repo.GetAccountByID(ctx, s.db, accountID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && conn.UserID != userID) {
		return Connection{}, fmt.Errorf("%w: аккаунт Google не подключён", domain.ErrValidation)
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
func (s *Service) StartURL(ctx context.Context, userID, reconnect uuid.UUID, state, verifier string) (string, error) {
	if !s.Enabled() {
		return "", domain.ErrNotFound
	}
	hint := ""
	if reconnect != uuid.Nil {
		conn, err := s.accountOf(ctx, userID, reconnect)
		if err != nil {
			return "", err
		}
		hint = conn.Email
	}
	return s.google.AuthURL(state, verifier, hint), nil
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
func (s *Service) Connect(ctx context.Context, userID uuid.UUID, code, verifier string) (uuid.UUID, error) {
	if !s.Enabled() {
		return uuid.Nil, domain.ErrNotFound
	}

	tokens, err := s.google.Exchange(ctx, code, verifier)
	if err != nil {
		return uuid.Nil, err
	}
	account, err := s.google.Account(ctx, tokens.Access)
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
		Provider:      s.google.Provider(),
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
func (s *Service) Disconnect(ctx context.Context, userID, accountID uuid.UUID) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}

	sealed, err := s.repo.Delete(ctx, s.db, accountID, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Отключать нечего — уже отключено (или аккаунт чужой, что снаружи
		// неотличимо). Идемпотентно: повторный запрос из второй вкладки не
		// должен краснеть.
		return nil
	}
	if err != nil {
		return fmt.Errorf("disconnect integration: %w", err)
	}

	refresh, err := openToken(s.key, sealed)
	if err != nil {
		// Токен не расшифровался (ротация ключа) — отзывать нечего, но строки
		// уже нет, и это правильный исход: человек отключился.
		httpserver.LoggerFrom(ctx).Warn("integration token not decrypted on disconnect",
			slog.String("account_id", accountID.String()))
		return nil
	}
	if err := s.google.Revoke(ctx, refresh); err != nil {
		httpserver.LoggerFrom(ctx).Warn("integration token not revoked at provider",
			slog.String("account_id", accountID.String()),
			slog.String("error", err.Error()))
	}
	return nil
}

// Статусы привязки формы (колонка form_integrations.status).
const (
	// StatusBackfilling — идёт перенос накопленных ответов (слайс D): живые
	// строки ждут в outbox, чтобы не лечь поверх старых.
	StatusBackfilling = "backfilling"
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
}

// FormStatus читает состояние интеграций формы. Право — ActionFormRead внутри
// forms.Get: кто видит форму и её ответы, тот вправе знать, куда они уезжают.
func (s *Service) FormStatus(ctx context.Context, userID, formID uuid.UUID) (FormStatus, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return FormStatus{}, err
	}

	account, err := s.Status(ctx, userID)
	if err != nil {
		return FormStatus{}, err
	}
	links, err := s.repo.ListLinks(ctx, s.db, formID)
	if err != nil {
		return FormStatus{}, fmt.Errorf("form integration status: %w", err)
	}
	// Пустой список — штатное состояние экрана: у формы просто нет связок.
	return FormStatus{WorkspaceID: form.WorkspaceID, Account: account, Connections: links}, nil
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
	// Связка и старт переноса ложатся ОДНОЙ транзакцией.
	//
	// Иначе сбой между ними (обрыв к БД, отменённый контекст запроса) отдаёт
	// человеку ошибку при уже созданной связке: он жмёт «Подключить» второй раз,
	// в Диске появляется вторая книга, и каждый ответ с этого момента уезжает в
	// две таблицы — обе выглядят рабочими. Таблица в Диске, впрочем, останется
	// висеть в любом случае: её создание чужому откату не подлежит.
	status := StatusLive
	if opts.Backfill {
		status = StatusBackfilling
	}
	err = s.tx.WithTx(ctx, func(tx pgx.Tx) error {
		if err := s.repo.InsertLink(ctx, tx, link); err != nil {
			return err
		}
		if !opts.Backfill {
			return nil
		}
		return s.startBackfill(ctx, tx, link.ID)
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
		Status:         status,
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
			"%w: в первой строке листа «%s» уже есть данные — выберите пустой лист или создайте новый",
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
	return s.startBackfill(ctx, s.db, link.ID)
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
	status := StatusLive
	if target.Backfill {
		status = StatusBackfilling
	}
	if _, err := s.repo.UpdateLinkTarget(ctx, s.db, link.ID, formID, conn.ID, sheet, columns, status); err != nil {
		return err
	}
	if target.Backfill {
		return s.startBackfill(ctx, s.db, link.ID)
	}
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
	tokens, err := s.google.Refresh(ctx, refresh)
	if err != nil {
		return "", err
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
