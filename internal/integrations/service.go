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
}

// Store — доступ к данным, объявленный потребителем. Реализация — Repo.
type Store interface {
	Upsert(ctx context.Context, db postgres.DBTX, c NewConnection) error
	Get(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, provider string) (Connection, error)
	Delete(ctx context.Context, db postgres.DBTX, workspaceID uuid.UUID, provider string) ([]byte, error)
	GetAccountByID(ctx context.Context, db postgres.DBTX, id uuid.UUID) (Connection, error)
	InsertLink(ctx context.Context, db postgres.DBTX, l NewFormLink) error
	GetLink(ctx context.Context, db postgres.DBTX, formID uuid.UUID) (FormLink, error)
	DeleteLink(ctx context.Context, db postgres.DBTX, formID uuid.UUID) error
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
	AuthURL(state, verifier string) string
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
	WriteHeader(ctx context.Context, accessToken string, s Spreadsheet, header []string) error
	AppendRow(ctx context.Context, accessToken string, s Spreadsheet, row []string) error
	AppendRows(ctx context.Context, accessToken string, s Spreadsheet, rows [][]string) error
	ClearSheet(ctx context.Context, accessToken string, s Spreadsheet) error
}

// Service — подключение внешних аккаунтов к пространству.
type Service struct {
	db     postgres.DBTX
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

func NewService(db postgres.DBTX, repo Store, access Access, f Forms, google Provider, key []byte) *Service {
	return &Service{db: db, repo: repo, access: access, forms: f, google: google, key: key}
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

// Status — состояние подключения пространства.
type Status struct {
	// Enabled — настроен ли провайдер на этом контуре (ключи в env). Отдельно
	// от Connected: «интеграции здесь нет вовсе» и «есть, но не подключена» —
	// разные экраны, и путать их значит советовать человеку нажать кнопку,
	// которой у него не появится.
	Enabled bool
	// PickerEnabled — настроено ли окно выбора файла на Диске (WithPicker).
	PickerEnabled bool
	Connected     bool
	Email         string
	ConnectedBy   uuid.UUID
	ConnectedAt   time.Time
	// CanManage — может ли спрашивающий подключать и отключать. Экран рисует
	// кнопку по нему, а не по роли: роль вне internal/workspaces не спрашивают.
	CanManage bool
}

// Status читает состояние. Право на чтение — ActionIntegrationRead: видеть,
// подключён ли аккаунт, вправе любой участник (иначе редактор не поймёт, почему
// ответы куда-то едут), а менять — нет.
func (s *Service) Status(ctx context.Context, userID, workspaceID uuid.UUID) (Status, error) {
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationRead); err != nil {
		return Status{}, err
	}

	canManage, err := s.canManage(ctx, workspaceID, userID)
	if err != nil {
		return Status{}, err
	}
	if !s.Enabled() {
		return Status{CanManage: canManage}, nil
	}
	picker := s.PickerAvailable()

	conn, err := s.repo.Get(ctx, s.db, workspaceID, s.google.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		// Нет подключения — штатное состояние экрана, а не ошибка.
		return Status{Enabled: true, PickerEnabled: picker, CanManage: canManage}, nil
	}
	if err != nil {
		return Status{}, fmt.Errorf("integration status: %w", err)
	}
	return Status{
		Enabled:       true,
		PickerEnabled: picker,
		Connected:     true,
		Email:         conn.Email,
		ConnectedBy:   conn.ConnectedBy,
		ConnectedAt:   conn.ConnectedAt,
		CanManage:     canManage,
	}, nil
}

// canManage отвечает на «можно ли управлять» без отказа наружу: для экрана это
// не ошибка, а состояние кнопки. Отличать отказ в праве от сбоя БД обязательно —
// иначе упавший запрос показал бы редактору чужие возможности как свои.
func (s *Service) canManage(ctx context.Context, workspaceID, userID uuid.UUID) (bool, error) {
	err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationManage)
	switch {
	case err == nil:
		return true, nil
	case errors.Is(err, domain.ErrForbidden):
		return false, nil
	default:
		return false, err
	}
}

// StartURL — ссылка на экран согласия провайдера. Право спрашивается ДО ухода к
// провайдеру: иначе редактор проходил бы согласие Google, чтобы получить отказ
// на возврате, уже отдав приложению доступ к своему Диску.
func (s *Service) StartURL(ctx context.Context, userID, workspaceID uuid.UUID, state, verifier string) (string, error) {
	if !s.Enabled() {
		return "", domain.ErrNotFound
	}
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationManage); err != nil {
		return "", err
	}
	return s.google.AuthURL(state, verifier), nil
}

// Connect завершает подключение: меняет код на токены, узнаёт аккаунт и кладёт
// refresh шифротекстом.
//
// Право проверяется ПОВТОРНО, а не считается доказанным подписанной cookie
// похода: между началом и возвратом человека могли лишить роли, и cookie об этом
// не знает (инвариант 1 — id из запроса правом доступа не является).
func (s *Service) Connect(ctx context.Context, userID, workspaceID uuid.UUID, code, verifier string) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationManage); err != nil {
		return err
	}

	tokens, err := s.google.Exchange(ctx, code, verifier)
	if err != nil {
		return err
	}
	account, err := s.google.Account(ctx, tokens.Access)
	if err != nil {
		return err
	}
	sealed, err := sealToken(s.key, tokens.Refresh)
	if err != nil {
		return err
	}

	return s.repo.Upsert(ctx, s.db, NewConnection{
		ID:            domain.NewID(),
		WorkspaceID:   workspaceID,
		Provider:      s.google.Provider(),
		ExternalID:    account.ID,
		Email:         account.Email,
		RefreshSealed: sealed,
		Scopes:        tokens.Scopes,
		ConnectedBy:   userID,
	})
}

// Disconnect отключает аккаунт от пространства. Привязки форм уносит каскад БД.
//
// Отзыв согласия у провайдера — best effort и НЕ гейтит удаление: недоступный
// Google не должен запирать человека в подключении, которое он разрывает.
// Неудача уходит в лог — там же, где её увидит человек за логом.
func (s *Service) Disconnect(ctx context.Context, userID, workspaceID uuid.UUID) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	if err := s.access.Can(ctx, workspaceID, userID, domain.ActionIntegrationManage); err != nil {
		return err
	}

	sealed, err := s.repo.Delete(ctx, s.db, workspaceID, s.google.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		// Отключать нечего — уже отключено. Идемпотентно: повторный запрос из
		// второй вкладки не должен краснеть.
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
			slog.String("workspace_id", workspaceID.String()))
		return nil
	}
	if err := s.google.Revoke(ctx, refresh); err != nil {
		httpserver.LoggerFrom(ctx).Warn("integration token not revoked at provider",
			slog.String("workspace_id", workspaceID.String()),
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

// FormStatus — всё, что нужно табу «Интеграции» одной поездкой: состояние
// аккаунта пространства и привязка этой формы.
type FormStatus struct {
	WorkspaceID uuid.UUID
	Account     Status
	Linked      bool
	Link        FormLink
}

// FormStatus читает состояние интеграций формы. Право — ActionFormRead внутри
// forms.Get: кто видит форму и её ответы, тот вправе знать, куда они уезжают.
func (s *Service) FormStatus(ctx context.Context, userID, formID uuid.UUID) (FormStatus, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return FormStatus{}, err
	}

	account, err := s.Status(ctx, userID, form.WorkspaceID)
	if err != nil {
		return FormStatus{}, err
	}
	out := FormStatus{WorkspaceID: form.WorkspaceID, Account: account}

	link, err := s.repo.GetLink(ctx, s.db, formID)
	if errors.Is(err, pgx.ErrNoRows) {
		// Форма не привязана — штатное состояние экрана.
		return out, nil
	}
	if err != nil {
		return FormStatus{}, fmt.Errorf("form integration status: %w", err)
	}
	out.Linked, out.Link = true, link
	return out, nil
}

// ConnectOptions — то, что человек назвал в окне подключения. Настройки
// спрашиваются ДО первой записи в чужие данные и приезжают одним объектом:
// подключение — одно осознанное действие, а не цепочка кнопок, каждая из
// которых уже что-то поменяла.
type ConnectOptions struct {
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
// Право — ActionFormWrite, а не ActionIntegrationManage: решение «вывозить ли
// ответы наружу» уже принято владельцем при подключении аккаунта, а выбрать, для
// какой формы завести таблицу, вправе тот, кто эти формы и правит.
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

	// Уже привязана — это не «перепривязать молча»: у формы одна таблица, и
	// вторая кнопка должна сначала отвязать первую (иначе созданная таблица
	// осталась бы висеть в Диске сиротой).
	if _, err := s.repo.GetLink(ctx, s.db, formID); err == nil {
		return FormLink{}, fmt.Errorf("%w: форма уже привязана к таблице", domain.ErrConflict)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return FormLink{}, fmt.Errorf("connect form: %w", err)
	}

	conn, err := s.repo.Get(ctx, s.db, form.WorkspaceID, s.google.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		return FormLink{}, fmt.Errorf("%w: аккаунт Google не подключён к пространству", domain.ErrValidation)
	}
	if err != nil {
		return FormLink{}, fmt.Errorf("connect form: %w", err)
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
	if err := s.repo.InsertLink(ctx, s.db, link); err != nil {
		return FormLink{}, err
	}
	// Перенос накопленных ответов — по выбору человека (тумблер в окне). Лист
	// заведён нами и пуст, поэтому затирать и дублировать нечего; но у формы
	// может быть двадцать тысяч ответов, которые ему в новой таблице не нужны.
	status := StatusLive
	if opts.Backfill {
		if err := s.startBackfill(ctx, link.ID); err != nil {
			return FormLink{}, err
		}
		status = StatusBackfilling
	}

	return FormLink{
		FormID:         formID,
		AccountID:      conn.ID,
		WorkspaceID:    form.WorkspaceID,
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
func (s *Service) Sheets(ctx context.Context, userID, formID uuid.UUID, spreadsheetID string) ([]SheetRef, error) {
	if !s.Enabled() {
		return nil, domain.ErrNotFound
	}
	if spreadsheetID == "" {
		return nil, fmt.Errorf("%w: таблица не выбрана", domain.ErrValidation)
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return nil, err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return nil, err
	}

	conn, err := s.repo.Get(ctx, s.db, form.WorkspaceID, s.google.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: аккаунт Google не подключён к пространству", domain.ErrValidation)
	}
	if err != nil {
		return nil, fmt.Errorf("list sheets: %w", err)
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

// Picker выдаёт браузеру credentials окна выбора. Право — ActionFormWrite: тот
// же порог, что у привязки формы к таблице, ради которой окно и открывают.
func (s *Service) Picker(ctx context.Context, userID, formID uuid.UUID) (PickerCredentials, error) {
	if !s.PickerAvailable() {
		return PickerCredentials{}, domain.ErrNotFound
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return PickerCredentials{}, err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return PickerCredentials{}, err
	}

	conn, err := s.repo.Get(ctx, s.db, form.WorkspaceID, s.google.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		return PickerCredentials{}, fmt.Errorf("%w: аккаунт Google не подключён к пространству", domain.ErrValidation)
	}
	if err != nil {
		return PickerCredentials{}, fmt.Errorf("picker credentials: %w", err)
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

// Spreadsheets — таблицы, куда можно положить ответы этой формы: те, что мы уже
// создавали для этого пространства. Чужих файлов Диска здесь нет и быть не
// может (scope drive.file), поэтому список безопасно показывать целиком.
func (s *Service) Spreadsheets(ctx context.Context, userID, formID uuid.UUID) ([]SpreadsheetRef, error) {
	if !s.Enabled() {
		return nil, domain.ErrNotFound
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return nil, err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return nil, err
	}

	conn, err := s.repo.Get(ctx, s.db, form.WorkspaceID, s.google.Provider())
	if errors.Is(err, pgx.ErrNoRows) {
		// Аккаунт не подключён — выбирать не из чего. Пустой список, а не
		// ошибка: окно настроек открывается и до подключения.
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("list spreadsheets: %w", err)
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
func (s *Service) RefillForm(ctx context.Context, userID, formID uuid.UUID) error {
	if !s.Enabled() {
		return domain.ErrNotFound
	}
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return err
	}

	link, err := s.repo.GetLink(ctx, s.db, formID)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: форма не привязана к таблице", domain.ErrValidation)
	}
	if err != nil {
		return fmt.Errorf("refill form: %w", err)
	}

	conn, err := s.repo.GetAccountByID(ctx, s.db, link.AccountID)
	if err != nil {
		return fmt.Errorf("refill form: %w", err)
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
	return s.startBackfill(ctx, link.ID)
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

// DisconnectForm отвязывает форму. Таблица в Диске автора остаётся со всеми
// строками: продукт не удаляет чужие файлы — ни за человека, ни «прибираясь».
func (s *Service) DisconnectForm(ctx context.Context, userID, formID uuid.UUID) error {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return err
	}
	if err := s.access.Can(ctx, form.WorkspaceID, userID, domain.ActionFormWrite); err != nil {
		return err
	}
	// Идемпотентно: отвязывать нечего — тоже успех (вторая вкладка не краснеет).
	return s.repo.DeleteLink(ctx, s.db, formID)
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
	return tokens.Access, nil
}
