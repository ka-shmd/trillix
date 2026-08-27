package integrations_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/postgres"
)

var (
	testKey  = []byte("form-token-secret-of-decent-length")
	testUser = uuid.MustParse("00000000-0000-7000-8000-000000000001")
	testWS   = uuid.MustParse("00000000-0000-7000-8000-000000000002")
	testForm = uuid.MustParse("00000000-0000-7000-8000-000000000003")
	// testStranger — второй человек. Нужен ровно для одного вопроса, который
	// появился вместе с личными аккаунтами: «а если аккаунт не мой».
	testStranger = uuid.MustParse("00000000-0000-7000-8000-000000000004")
)

// fakeAccess — права как ответ на ДЕЙСТВИЕ: ровно то, что спрашивает сервис.
type fakeAccess struct {
	deny map[domain.Action]error
	// gone — человек ушёл из пространства. Нулевое значение = «на месте»: так
	// подавляющее большинство тестов не обязано знать про сторож доставки.
	gone bool
}

func (f fakeAccess) Can(_ context.Context, _, _ uuid.UUID, a domain.Action) error {
	return f.deny[a]
}

func (f fakeAccess) IsMember(_ context.Context, _, _ uuid.UUID) (bool, error) {
	return !f.gone, nil
}

// readerAccess — участник без права править формы. Связку он завести не может,
// а собственные аккаунты Google у него свои и от роли не зависят вовсе.
func readerAccess() fakeAccess {
	return fakeAccess{deny: map[domain.Action]error{domain.ActionFormWrite: domain.ErrForbidden}}
}

type fakeStore struct {
	conn      integrations.Connection
	getErr    error
	upserted  *integrations.NewConnection
	deleted   []byte
	deleteErr error
	// tokenUpdated — шифротекст, перезаписанный после ротации у провайдера.
	tokenUpdated []byte

	link        integrations.FormLink
	linkErr     error
	insertedLnk *integrations.NewFormLink
	unlinked    bool

	columnsSet     []domain.SheetColumn
	delivered      bool
	brokenWith     string
	settings       *linkSettings
	retargeted     *integrations.Spreadsheet
	retargetStatus string
	backfillFrom   *time.Time
	backfillDone   bool
	sheetCleared   bool
}

func (f *fakeStore) Upsert(_ context.Context, _ postgres.DBTX, c integrations.NewConnection) (uuid.UUID, error) {
	f.upserted = &c
	return c.ID, nil
}

func (f *fakeStore) ListByUser(_ context.Context, _ postgres.DBTX, _ uuid.UUID, _ string) ([]integrations.Connection, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	if f.conn.ID == uuid.Nil {
		return nil, nil
	}
	return []integrations.Connection{f.conn}, nil
}

func (f *fakeStore) UpdateToken(_ context.Context, _ postgres.DBTX, _ uuid.UUID, sealed []byte) error {
	f.tokenUpdated = sealed
	return nil
}

func (f *fakeStore) Delete(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) ([]byte, error) {
	if f.deleteErr != nil {
		return nil, f.deleteErr
	}
	return f.deleted, nil
}

func (f *fakeStore) InsertLink(_ context.Context, _ postgres.DBTX, l integrations.NewFormLink) error {
	f.insertedLnk = &l
	return nil
}

func (f *fakeStore) ListLinks(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]integrations.FormLink, error) {
	if f.linkErr != nil {
		return nil, f.linkErr
	}
	if f.link.ID == uuid.Nil {
		return nil, nil
	}
	return []integrations.FormLink{f.link}, nil
}

func (f *fakeStore) EnabledLinkIDs(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]uuid.UUID, error) {
	if f.linkErr != nil {
		return nil, f.linkErr
	}
	if f.link.ID == uuid.Nil || !f.link.Enabled {
		return nil, nil
	}
	return []uuid.UUID{f.link.ID}, nil
}

func (f *fakeStore) DeleteLink(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (int64, error) {
	f.unlinked = true
	return 1, nil
}

func (f *fakeStore) UpdateLinkTarget(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID, sheet integrations.Spreadsheet, columns []domain.SheetColumn, status string) (int64, error) {
	f.retargeted = &sheet
	f.columnsSet = columns
	f.retargetStatus = status
	return 1, nil
}

func (f *fakeStore) UpdateLinkSettings(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID, name string, enabled bool) (int64, error) {
	f.settings = &linkSettings{name: name, enabled: enabled}
	return 1, nil
}

func (f *fakeStore) GetAccountByID(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (integrations.Connection, error) {
	if f.getErr != nil {
		return integrations.Connection{}, f.getErr
	}
	return f.conn, nil
}

func (f *fakeStore) GetLinkByID(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (integrations.FormLink, error) {
	if f.linkErr != nil {
		return integrations.FormLink{}, f.linkErr
	}
	return f.link, nil
}

func (f *fakeStore) UpdateLinkColumns(_ context.Context, _ postgres.DBTX, _ uuid.UUID, columns []domain.SheetColumn) error {
	f.columnsSet = columns
	return nil
}

func (f *fakeStore) MarkDelivered(_ context.Context, _ postgres.DBTX, _ uuid.UUID) error {
	f.delivered = true
	return nil
}

func (f *fakeStore) StartBackfill(_ context.Context, _ postgres.DBTX, _ uuid.UUID, before time.Time) error {
	f.backfillFrom = &before
	return nil
}

func (f *fakeStore) FinishBackfill(_ context.Context, _ postgres.DBTX, _ uuid.UUID) error {
	f.backfillDone = true
	return nil
}

func (f *fakeStore) MarkBroken(_ context.Context, _ postgres.DBTX, _ uuid.UUID, cause string) error {
	f.brokenWith = cause
	return nil
}

// fakeForms — коллаборатор forms: авторизует доступ к форме и отдаёт версии.
// directTx — «транзакция», исполняющая функцию как есть: юнит-тестам нужна
// последовательность вызовов, а не изоляция (её проверяют интеграционные).
type directTx struct{}

func (directTx) WithTx(ctx context.Context, fn func(pgx.Tx) error) error { return fn(nil) }

// linkSettings — то, что записали правкой связки.
type linkSettings struct {
	name    string
	enabled bool
}

type fakeForms struct {
	form    forms.Form
	getErr  error
	version json.RawMessage
}

func (f fakeForms) Get(_ context.Context, _, _ uuid.UUID) (forms.Form, error) {
	if f.getErr != nil {
		return forms.Form{}, f.getErr
	}
	return f.form, nil
}

func (f fakeForms) Versions(_ context.Context, _, _ uuid.UUID) ([]forms.Version, error) {
	if f.version == nil {
		return nil, nil
	}
	return []forms.Version{{Number: 1, Schema: f.version}}, nil
}

type fakeProvider struct {
	exchanged    bool
	revoked      string
	createdTitle string
	addedTo      string
	addedTitle   string
	header       []string
	appended     [][]string
	appendCalls  int
	cleared      string
	appendErr    error
	firstRowBusy bool
	// rotated — refresh-токен, который провайдер отдаёт взамен использованного.
	// Пусто — как у Google: тот старый токен не меняет.
	rotated    string
	exchangeFn func() (integrations.Tokens, error)
	// accounts — какие аккаунты Google отдавать по очереди. Пусто = всегда один
	// и тот же, то есть «переподключился тем же». Нужен, чтобы проверить второй
	// аккаунт: до 0037 он затирал первый, и связки начинали писать чужим токеном.
	accounts   []integrations.Account
	accountIdx int
}

func (f *fakeProvider) Provider() string { return "google" }

func (f *fakeProvider) AppID() string { return "442272803444" }

func (f *fakeProvider) AuthURL(state, _ string) string {
	return "https://provider.example/auth?state=" + state
}

func (f *fakeProvider) Exchange(_ context.Context, _, _ string) (integrations.Tokens, error) {
	f.exchanged = true
	if f.exchangeFn != nil {
		return f.exchangeFn()
	}
	return integrations.Tokens{Access: "at", Refresh: "rt", Scopes: integrations.ScopeDriveFile}, nil
}

func (f *fakeProvider) Refresh(_ context.Context, _ string) (integrations.Tokens, error) {
	return integrations.Tokens{Access: "at", Refresh: f.rotated}, nil
}

func (f *fakeProvider) Account(_ context.Context, _ string) (integrations.Account, error) {
	if len(f.accounts) == 0 {
		return integrations.Account{ID: "sub-1", Email: "author@gmail.com"}, nil
	}
	a := f.accounts[min(f.accountIdx, len(f.accounts)-1)]
	f.accountIdx++
	return a, nil
}

func (f *fakeProvider) Revoke(_ context.Context, refresh string) error {
	f.revoked = refresh
	return nil
}

func (f *fakeProvider) CreateSpreadsheet(_ context.Context, _, title, sheetTitle string) (integrations.Spreadsheet, error) {
	f.createdTitle = title
	return integrations.Spreadsheet{
		ID:      "sheet-id",
		URL:     "https://docs.google.com/spreadsheets/d/sheet-id/edit",
		SheetID: 7,
		Title:   sheetTitle,
	}, nil
}

func (f *fakeProvider) WriteHeader(_ context.Context, _ string, _ integrations.Spreadsheet, header []string) error {
	f.header = header
	return nil
}

func (f *fakeProvider) AppendRow(ctx context.Context, token string, s integrations.Spreadsheet, row []string) error {
	return f.AppendRows(ctx, token, s, [][]string{row})
}

func (f *fakeProvider) AppendRows(_ context.Context, _ string, _ integrations.Spreadsheet, rows [][]string) error {
	if f.appendErr != nil {
		return f.appendErr
	}
	f.appendCalls++
	f.appended = append(f.appended, rows...)
	return nil
}

func (f *fakeProvider) AddSheet(_ context.Context, _, spreadsheetID, title string) (integrations.Spreadsheet, error) {
	f.addedTo, f.addedTitle = spreadsheetID, title
	return integrations.Spreadsheet{
		ID:      spreadsheetID,
		URL:     "https://docs.google.com/spreadsheets/d/" + spreadsheetID + "/edit",
		SheetID: 12,
		Title:   title,
	}, nil
}

func (f *fakeProvider) ListSpreadsheets(_ context.Context, _ string) ([]integrations.SpreadsheetRef, error) {
	return []integrations.SpreadsheetRef{{ID: "ss-old", Name: "Прошлая форма"}}, nil
}

func (f *fakeProvider) ListSheets(_ context.Context, _, _ string) ([]integrations.SheetRef, error) {
	return []integrations.SheetRef{{ID: 0, Title: "Лист1"}, {ID: 5, Title: "Заметки"}}, nil
}

func (f *fakeProvider) SpreadsheetURL(_ context.Context, _, spreadsheetID string) (string, error) {
	return "https://docs.google.com/spreadsheets/d/" + spreadsheetID + "/edit", nil
}

func (f *fakeProvider) FirstRowEmpty(_ context.Context, _ string, _ integrations.Spreadsheet) (bool, error) {
	return !f.firstRowBusy, nil
}

func (f *fakeProvider) ClearSheet(_ context.Context, _ string, s integrations.Spreadsheet) error {
	f.cleared = s.ID
	return nil
}

func newService(access integrations.Access, store integrations.Store, p integrations.Provider) *integrations.Service {
	return newFormService(access, store, fakeForms{}, p)
}

func newFormService(access integrations.Access, store integrations.Store, f integrations.Forms, p integrations.Provider) *integrations.Service {
	return integrations.NewService(nil, directTx{}, store, access, f, p, testKey)
}

// Экран получает СПИСОК подключений спрашивающего. Список, а не одно
// подключение: аккаунтов у человека сколько угодно (ADR §10, 2026-08-27), и
// селект в окне связки строится по нему.
func TestStatus_ListsAccountsOfAsker(t *testing.T) {
	conn := sealedConn(t)
	svc := newService(fakeAccess{}, &fakeStore{conn: conn}, &fakeProvider{})

	st, err := svc.Status(context.Background(), testUser)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !st.Enabled {
		t.Fatal("провайдер настроен, а состояние говорит обратное")
	}
	if len(st.Accounts) != 1 || st.Accounts[0].ID != conn.ID {
		t.Fatalf("аккаунты = %+v, ожидался ровно подключённый", st.Accounts)
	}
	if st.Accounts[0].NeedsReconnect {
		t.Error("свежее подключение помечено как требующее переподключения")
	}
}

// Ничего не подключено — пустой список, а не ошибка: это штатное состояние
// экрана до первого подключения.
func TestStatus_NothingConnected(t *testing.T) {
	svc := newService(fakeAccess{}, &fakeStore{}, &fakeProvider{})

	st, err := svc.Status(context.Background(), testUser)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !st.Enabled || len(st.Accounts) != 0 {
		t.Errorf("состояние = %+v, ожидалось «настроено, но пусто»", st)
	}
}

// Подключение — действие над СОБОЙ, и роль в пространстве его не гейтит: гейт
// был бы пуст (личное пространство есть у каждого, и в нём каждый владелец).
// Сторожит решение 2026-08-27: прежде здесь стоял отказ редактору.
func TestConnect_NeedsNoWorkspaceRole(t *testing.T) {
	store := &fakeStore{}
	svc := newService(readerAccess(), store, &fakeProvider{})

	if _, err := svc.Connect(context.Background(), testUser, "code", "verifier"); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if store.upserted == nil {
		t.Fatal("подключение не записано")
	}
}

// Владелец подключает: в базу уезжает ШИФРОТЕКСТ, а не токен провайдера.
func TestConnect_StoresSealedToken(t *testing.T) {
	store := &fakeStore{}
	svc := newService(fakeAccess{}, store, &fakeProvider{})

	if _, err := svc.Connect(context.Background(), testUser, "code", "verifier"); err != nil {
		t.Fatalf("connect: %v", err)
	}
	if store.upserted == nil {
		t.Fatal("подключение не записано")
	}
	got := *store.upserted
	if bytes.Contains(got.RefreshSealed, []byte("rt")) {
		t.Error("refresh-токен лёг в базу открытым текстом")
	}
	if got.ExternalID != "sub-1" || got.Email != "author@gmail.com" {
		t.Errorf("аккаунт записан как %q/%q", got.ExternalID, got.Email)
	}
	if got.UserID != testUser {
		t.Errorf("подключение записано не тому: user=%s", got.UserID)
	}
}

// Отключение идемпотентно: второй запрос из соседней вкладки не должен краснеть.
func TestDisconnect_Idempotent(t *testing.T) {
	provider := &fakeProvider{}
	svc := newService(fakeAccess{}, &fakeStore{deleteErr: pgx.ErrNoRows}, provider)

	if err := svc.Disconnect(context.Background(), testUser, uuid.New()); err != nil {
		t.Fatalf("повторное отключение вернуло ошибку: %v", err)
	}
	if provider.revoked != "" {
		t.Error("отзыв дёрнут при пустом отключении")
	}
}

// Отключение отзывает согласие у провайдера — расшифрованным токеном.
func TestDisconnect_RevokesAtProvider(t *testing.T) {
	// Кладём в «базу» настоящий шифротекст (через Connect), чтобы путь
	// расшифровки при отключении проверялся целиком, а не с подставным байтом.
	store := &fakeStore{}
	if _, err := newService(fakeAccess{}, store, &fakeProvider{}).
		Connect(context.Background(), testUser, "code", "verifier"); err != nil {
		t.Fatalf("подготовка: %v", err)
	}

	provider := &fakeProvider{}
	svc := newService(fakeAccess{}, &fakeStore{deleted: store.upserted.RefreshSealed}, provider)
	if err := svc.Disconnect(context.Background(), testUser, store.upserted.ID); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if provider.revoked != "rt" {
		t.Errorf("отозван токен %q, ожидался «rt»", provider.revoked)
	}
}

// Провайдер не настроен на контуре: управляющие ручки не существуют (404), а
// состояние честно говорит «интеграции здесь нет» — это другой экран, чем
// «есть, но не подключена».
func TestDisabledProvider(t *testing.T) {
	svc := newService(fakeAccess{}, &fakeStore{}, nil)

	st, err := svc.Status(context.Background(), testUser)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.Enabled || len(st.Accounts) != 0 {
		t.Errorf("состояние = %+v, ожидалось «не настроено»", st)
	}

	if _, err := svc.StartURL(context.Background(), "s", "v"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("StartURL = %v, ожидалась ErrNotFound", err)
	}
	if _, err := svc.Connect(context.Background(), testUser, "c", "v"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("Connect = %v, ожидалась ErrNotFound", err)
	}
	if err := svc.Disconnect(context.Background(), testUser, uuid.New()); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("Disconnect = %v, ожидалась ErrNotFound", err)
	}
}

// defaultOptions — то, с чем окно настроек приходит по умолчанию: новая книга и
// перенос накопленных ответов включён. Аккаунт называется явно и умолчания не
// имеет: их у человека сколько угодно.
func defaultOptions(account uuid.UUID) integrations.ConnectOptions {
	return integrations.ConnectOptions{AccountID: account, Backfill: true}
}

// схема одной версии с одним вопросом — минимум, на котором видно колонки.
const oneQuestionSchema = `{"schemaVersion":1,"blocks":[
	{"id":"t1","groupId":"g1","type":"title","text":[{"t":"=опасная подпись"}],"settings":{}},
	{"id":"b1","groupId":"g1","type":"short_text","settings":{}}
]}`

func linkedForm() forms.Form {
	return forms.Form{ID: testForm, WorkspaceID: testWS, Title: "Опрос"}
}

// Привязка формы заводит таблицу, пишет шапку и запоминает КЛЮЧИ колонок.
// Ключи, а не подписи: по подписи сопоставление разъехалось бы при первом
// переименовании вопроса.
func TestConnectForm_CreatesSheetAndStoresColumns(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, provider)

	link, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions(store.conn.ID))
	if err != nil {
		t.Fatalf("connect form: %v", err)
	}
	// Сразу после привязки идёт перенос накопленных ответов: таблица создана
	// нами и пуста, а пустая таблица читается как «не заработало».
	if link.SpreadsheetURL == "" || link.Status != integrations.StatusBackfilling {
		t.Fatalf("привязка = %+v, ожидался статус переноса", link)
	}
	if store.backfillFrom == nil {
		t.Error("перенос не начат")
	}
	if provider.createdTitle != "Опрос — ответы" {
		t.Errorf("имя таблицы = %q", provider.createdTitle)
	}
	if store.insertedLnk == nil {
		t.Fatal("привязка не записана")
	}
	cols := store.insertedLnk.Columns
	if len(cols) != 4 || cols[0].Key != "_id" || cols[3].Key != "b1" {
		t.Fatalf("колонки = %+v, ожидались метаколонки + id вопроса", cols)
	}
	if cols[3].Label != "=опасная подпись" {
		t.Errorf("подпись колонки = %q — подпись вопроса потеряна", cols[3].Label)
	}
	// Шапка уезжает БЕЗ CSV-заглушки: в таблицу значения кладутся режимом,
	// который их не разбирает, и апостроф был бы виден в ячейке.
	if len(provider.header) != 4 || provider.header[3] != "=опасная подпись" {
		t.Fatalf("шапка = %v, ожидалась без апострофа", provider.header)
	}
}

// Аккаунт не подключён — просить таблицу рано: 422 с человеческим текстом,
// а не 500 и не молчаливое «создали, но не привязали».
func TestConnectForm_WithoutAccount(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, getErr: pgx.ErrNoRows}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{})

	_, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions(uuid.New()))
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.insertedLnk != nil {
		t.Error("привязка записана без подключённого аккаунта")
	}
}

// ЧУЖИМ аккаунтом связку не завести, и отказ неотличим от «аккаунта нет»:
// иначе перебором id можно было бы узнать, какие подключения есть у соседа.
//
// Это главный новый сторож личной модели: аккаунт приезжает в ТЕЛЕ запроса, и
// без проверки принадлежности участник командного пространства лил бы ответы
// через чужое подключение (инвариант 1).
func TestConnectForm_ForeignAccountRefused(t *testing.T) {
	foreign := sealedConn(t)
	foreign.UserID = testStranger
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: foreign}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, provider)

	_, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions(foreign.ID))
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if provider.createdTitle != "" {
		t.Error("таблица создана в чужом Диске")
	}
	if store.insertedLnk != nil {
		t.Error("связка записана на чужой аккаунт")
	}
}

// Вторая связка для той же формы — законна, в том числе в ту же книгу.
// Интеграция это ПРАВИЛО ДОСТАВКИ, а не состояние формы: одну форму льют и в
// рабочую таблицу, и в архивную.
func TestConnectForm_SecondConnectionAllowed(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t)}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, &fakeProvider{})

	link, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions(store.conn.ID))
	if err != nil {
		t.Fatalf("вторая связка отклонена: %v", err)
	}
	if store.insertedLnk == nil || link.SpreadsheetURL == "" {
		t.Fatal("вторая связка не записана")
	}
}

// Правка связки: подпись и тумблер. Выключенная связка сохраняет таблицу и
// колонки — «выключить на время» и «удалить навсегда» разные намерения.
func TestUpdateConnection(t *testing.T) {
	store := &fakeStore{link: linkedSheet()}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{})

	err := svc.UpdateConnection(context.Background(), testUser, testForm, store.link.ID,
		integrations.ConnectionPatch{Name: "  Архив  ", Enabled: false, KeepTarget: true})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if store.settings == nil || store.settings.name != "Архив" || store.settings.enabled {
		t.Fatalf("настройки = %+v", store.settings)
	}
	if store.unlinked {
		t.Error("выключение удалило связку")
	}
}

// Чужая форма не раскрывается даже отказом: forms.Get отвечает 404, и до
// провайдера дело не доходит.
func TestConnectForm_StrangerGetsNotFound(t *testing.T) {
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, &fakeStore{}, fakeForms{getErr: domain.ErrNotFound}, provider)

	if _, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions(uuid.New())); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
	}
	if provider.createdTitle != "" {
		t.Error("таблица создана для чужой формы")
	}
}

// Отвязка формы НЕ трогает таблицу в Диске автора: продукт не удаляет чужие
// файлы. Проверяется тем, что провайдера не дёргали вовсе.
func TestDisconnectForm_KeepsSpreadsheet(t *testing.T) {
	store := &fakeStore{link: integrations.FormLink{ID: uuid.New(), SpreadsheetID: "sheet-id"}}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, provider)

	if err := svc.DisconnectForm(context.Background(), testUser, testForm, store.link.ID); err != nil {
		t.Fatalf("disconnect form: %v", err)
	}
	if !store.unlinked {
		t.Error("привязка не удалена")
	}
	if provider.revoked != "" || provider.createdTitle != "" {
		t.Error("отвязка формы полезла к провайдеру")
	}
}

// sealedConn — подключение с настоящим шифротекстом токена: путь расшифровки
// при обращении к провайдеру должен проверяться целиком.
func sealedConn(t *testing.T) integrations.Connection {
	t.Helper()
	store := &fakeStore{}
	if _, err := newService(fakeAccess{}, store, &fakeProvider{}).
		Connect(context.Background(), testUser, "code", "verifier"); err != nil {
		t.Fatalf("подготовка подключения: %v", err)
	}
	return integrations.Connection{
		ID:            store.upserted.ID,
		UserID:        testUser,
		Email:         store.upserted.Email,
		RefreshSealed: store.upserted.RefreshSealed,
	}
}

// «Перезалить всё» чистит лист, пишет свежую шапку и запускает перенос заново.
// Это лечение всего, что накопилось: дубль после ретрая, удалённые руками
// строки, отставшие колонки, простоявшая сломанной интеграция.
func TestRefillForm(t *testing.T) {
	link := integrations.FormLink{
		ID:            uuid.New(),
		FormID:        testForm,
		SpreadsheetID: "sheet-id",
		SheetTitle:    "Ответы",
		Status:        integrations.StatusBroken,
		Columns:       []domain.SheetColumn{{Key: "_id", Label: "ID ответа"}},
	}
	store := &fakeStore{link: link, conn: sealedConn(t)}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, provider)

	if err := svc.RefillForm(context.Background(), testUser, testForm, link.ID); err != nil {
		t.Fatalf("refill: %v", err)
	}
	if provider.cleared != "sheet-id" {
		t.Error("лист не вычищен перед перезаливом")
	}
	if len(provider.header) == 0 {
		t.Error("шапка не переписана")
	}
	if store.backfillFrom == nil {
		t.Fatal("перенос не начат")
	}
	// Колонка, которой в листе ещё не было, дописана; прежняя осталась первой —
	// автор мог свести таблицу формулами справа.
	if len(store.columnsSet) < 2 || store.columnsSet[0].Key != "_id" {
		t.Fatalf("колонки = %+v", store.columnsSet)
	}
}

// Связки с таким id у формы нет — 404, и одинаково для «нет вовсе» и «чужая»
// (инвариант 5).
func TestRefillForm_UnknownConnection(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{})

	err := svc.RefillForm(context.Background(), testUser, testForm, uuid.New())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
	}
}

// Тумблер «перенести накопленные ответы» выключен: связка сразу живая, перенос
// не начинается. Это выбор человека — у формы может быть двадцать тысяч
// ответов, которые ему в новой таблице не нужны.
func TestConnectForm_WithoutBackfill(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, &fakeProvider{})

	link, err := svc.ConnectForm(context.Background(), testUser, testForm,
		integrations.ConnectOptions{AccountID: store.conn.ID, Backfill: false})
	if err != nil {
		t.Fatalf("connect form: %v", err)
	}
	if link.Status != integrations.StatusLive {
		t.Fatalf("статус = %q, ожидался живой", link.Status)
	}
	if store.backfillFrom != nil {
		t.Error("перенос начат вопреки выключенному тумблеру")
	}
}

// Выбрана уже созданная нами книга: заводим в ней НОВЫЙ ЛИСТ, а не новую книгу.
// Имя листа несёт slug формы — Google запрещает две вкладки с одинаковым именем,
// а форм с одинаковым названием у автора сколько угодно.
func TestConnectForm_IntoExistingSpreadsheet(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	provider := &fakeProvider{}
	form := linkedForm()
	form.Slug = "abc123"
	svc := newFormService(fakeAccess{}, store, fakeForms{form: form, version: json.RawMessage(oneQuestionSchema)}, provider)

	link, err := svc.ConnectForm(context.Background(), testUser, testForm,
		integrations.ConnectOptions{AccountID: store.conn.ID, Name: "Заявки с лендинга", SpreadsheetID: "ss-old", Backfill: true})
	if err != nil {
		t.Fatalf("connect form: %v", err)
	}
	if provider.createdTitle != "" {
		t.Error("заведена новая книга вместо листа в существующей")
	}
	if provider.addedTo != "ss-old" {
		t.Fatalf("лист заведён в %q", provider.addedTo)
	}
	if !strings.Contains(provider.addedTitle, "abc123") {
		t.Errorf("имя листа = %q, ожидался slug формы в нём", provider.addedTitle)
	}
	if link.Name != "Заявки с лендинга" || store.insertedLnk.Name != "Заявки с лендинга" {
		t.Errorf("подпись связки потеряна: %q / %q", link.Name, store.insertedLnk.Name)
	}
}

// Слишком длинная подпись отбивается на бэке независимо от фронта (инвариант 3).
func TestConnectForm_NameTooLong(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{})

	_, err := svc.ConnectForm(context.Background(), testUser, testForm,
		integrations.ConnectOptions{Name: strings.Repeat("я", integrations.MaxConnectionNameLen+1)})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.insertedLnk != nil {
		t.Error("связка записана с недопустимой подписью")
	}
}

// Окно выбора файла на Диске: браузер получает живой токен Google — и только по
// нажатию кнопки, только при подключённом аккаунте и только с правом на правку
// формы. Номер проекта берётся из client_id, а не из отдельной переменной.
func TestPicker(t *testing.T) {
	store := &fakeStore{conn: sealedConn(t)}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{}).
		WithPicker("browser-api-key")

	cred, err := svc.Picker(context.Background(), testUser, store.conn.ID)
	if err != nil {
		t.Fatalf("picker: %v", err)
	}
	if cred.AccessToken != "at" || cred.DeveloperKey != "browser-api-key" {
		t.Fatalf("credentials = %+v", cred)
	}
	if cred.AppID != "442272803444" {
		t.Errorf("номер проекта = %q", cred.AppID)
	}
}

// Ключ окна выбора не задан на контуре — ручки нет вовсе, и экран кнопку не
// рисует: обещать выбор, который не откроется, нельзя.
func TestPicker_NotConfigured(t *testing.T) {
	conn := sealedConn(t)
	svc := newFormService(fakeAccess{}, &fakeStore{conn: conn}, fakeForms{form: linkedForm()}, &fakeProvider{})

	if _, err := svc.Picker(context.Background(), testUser, conn.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
	}
	st, err := svc.Status(context.Background(), testUser)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.PickerEnabled {
		t.Error("экран обещает выбор файла без ключа")
	}
}

// Без подключённого аккаунта выбирать нечем — 422 с человеческим текстом, а не
// пустой токен.
func TestPicker_WithoutAccount(t *testing.T) {
	svc := newFormService(fakeAccess{}, &fakeStore{getErr: pgx.ErrNoRows}, fakeForms{form: linkedForm()}, &fakeProvider{}).
		WithPicker("browser-api-key")

	if _, err := svc.Picker(context.Background(), testUser, uuid.New()); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
}

// ЧУЖОЙ аккаунт не выдаёт ни токена окна выбора, ни списка файлов, ни листов.
//
// Это и есть новая защита взамен снятого гейта по роли, и она сильнее: токен
// drive.file открывает ВСЕ файлы приложения в аккаунте Google, но получить его
// теперь можно только на своё подключение — открывать им нечего.
func TestAccountOperations_ForeignAccountRefused(t *testing.T) {
	foreign := sealedConn(t)
	foreign.UserID = testStranger
	svc := newFormService(fakeAccess{}, &fakeStore{conn: foreign}, fakeForms{form: linkedForm()}, &fakeProvider{}).
		WithPicker("browser-api-key")

	if _, err := svc.Picker(context.Background(), testUser, foreign.ID); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("токен окна выбора выдан на чужой аккаунт: %v", err)
	}
	if _, err := svc.Spreadsheets(context.Background(), testUser, foreign.ID); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("список файлов выдан по чужому аккаунту: %v", err)
	}
	if _, err := svc.Sheets(context.Background(), testUser, foreign.ID, "ss-old"); !errors.Is(err, domain.ErrValidation) {
		t.Errorf("листы книги выданы по чужому аккаунту: %v", err)
	}
}

// Выбран существующий лист книги: новый не заводим, шапку пишем в него.
func TestConnectForm_IntoExistingSheet(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, provider)

	sheetID := int32(5)
	link, err := svc.ConnectForm(context.Background(), testUser, testForm,
		integrations.ConnectOptions{AccountID: store.conn.ID, SpreadsheetID: "ss-old", SheetID: &sheetID})
	if err != nil {
		t.Fatalf("connect form: %v", err)
	}
	if provider.addedTo != "" || provider.createdTitle != "" {
		t.Error("заведён новый лист вместо выбранного")
	}
	if link.SheetID != 5 || link.SheetTitle != "Заметки" {
		t.Fatalf("привязка = gid %d, лист %q", link.SheetID, link.SheetTitle)
	}
	if len(provider.header) == 0 {
		t.Error("шапка в выбранный лист не написана")
	}
}

// Первая строка выбранного листа занята — отказываемся, а не затираем чужую
// работу: шапка ложится в A1, и молча стереть её содержимое нельзя.
func TestConnectForm_ExistingSheetNotEmpty(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	provider := &fakeProvider{firstRowBusy: true}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, provider)

	sheetID := int32(5)
	_, err := svc.ConnectForm(context.Background(), testUser, testForm,
		integrations.ConnectOptions{AccountID: store.conn.ID, SpreadsheetID: "ss-old", SheetID: &sheetID})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if len(provider.header) != 0 {
		t.Error("шапка записана поверх чужих данных")
	}
	if store.insertedLnk != nil {
		t.Error("привязка записана вопреки отказу")
	}
}

// Листа с таким gid в книге нет — отказ, а не запись «в никуда».
func TestConnectForm_UnknownSheet(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, &fakeProvider{})

	sheetID := int32(999)
	_, err := svc.ConnectForm(context.Background(), testUser, testForm,
		integrations.ConnectOptions{AccountID: store.conn.ID, SpreadsheetID: "ss-old", SheetID: &sheetID})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
}

// Правка с тем же листом ничего не переносит: человек поменял только подпись, и
// трогать чужую таблицу из-за этого нельзя.
func TestUpdateConnection_SameTargetKeepsSheet(t *testing.T) {
	link := linkedSheet()
	link.SpreadsheetID, link.SheetID = "ss-old", 5
	store := &fakeStore{link: link}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, provider)

	sheetID := int32(5)
	err := svc.UpdateConnection(context.Background(), testUser, testForm, link.ID,
		integrations.ConnectionPatch{
			Name:   "Архив",
			Target: integrations.ConnectOptions{SpreadsheetID: "ss-old", SheetID: &sheetID},
		})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if store.retargeted != nil {
		t.Fatalf("связка переехала без нужды: %+v", store.retargeted)
	}
	if provider.header != nil {
		t.Error("шапка переписана без переезда")
	}
}

// Выбран другой лист — связка переезжает: в новом листе пишется шапка, колонки
// собираются заново, статус зависит от тумблера переноса.
func TestUpdateConnection_Retarget(t *testing.T) {
	link := linkedSheet()
	link.SpreadsheetID, link.SheetID = "ss-old", 5
	store := &fakeStore{link: link, conn: sealedConn(t)}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store,
		fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, provider)

	err := svc.UpdateConnection(context.Background(), testUser, testForm, link.ID,
		integrations.ConnectionPatch{
			Name:   "Новый лист",
			Target: integrations.ConnectOptions{SpreadsheetID: "", Backfill: true},
		})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if store.retargeted == nil {
		t.Fatal("связка не переехала")
	}
	if len(provider.header) == 0 {
		t.Error("шапка в новом листе не написана")
	}
	if store.retargetStatus != integrations.StatusBackfilling || store.backfillFrom == nil {
		t.Errorf("перенос не начат: статус %q", store.retargetStatus)
	}
}

// Операции над СВОИМ аккаунтом ролью в пространстве не гейтятся вовсе: аккаунт
// личный, и человек без права править формы всё равно вправе смотреть свой Диск
// и подключать свои таблицы. Сторожит решение 2026-08-27 — прежде здесь стоял
// отказ редактору по ActionIntegrationManage.
func TestAccountOperations_IgnoreWorkspaceRole(t *testing.T) {
	store := &fakeStore{conn: sealedConn(t)}
	svc := newFormService(readerAccess(), store, fakeForms{form: linkedForm()}, &fakeProvider{}).
		WithPicker("browser-api-key")

	if _, err := svc.Picker(context.Background(), testUser, store.conn.ID); err != nil {
		t.Errorf("токен окна выбора закрыт ролью: %v", err)
	}
	if _, err := svc.Spreadsheets(context.Background(), testUser, store.conn.ID); err != nil {
		t.Errorf("список своих файлов закрыт ролью: %v", err)
	}
	if _, err := svc.Sheets(context.Background(), testUser, store.conn.ID, "ss-old"); err != nil {
		t.Errorf("листы своей книги закрыты ролью: %v", err)
	}

	// А вот завести СВЯЗКУ он не может: это правка формы.
	_, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions(store.conn.ID))
	if !errors.Is(err, domain.ErrForbidden) {
		t.Errorf("связку завёл тот, кому нельзя править форму: %v", err)
	}
}

// Ключ контура сменился (ротация FORM_TOKEN_SECRET): строка подключения на
// месте, но шифротекст ею больше не открывается. Экран обязан сказать
// «подключите заново», а не рисовать зелёное «подключено» — иначе человек
// узнаёт о беде из потерянного ответа респондента.
func TestStatus_TokenFromAnotherKeyAsksToReconnect(t *testing.T) {
	sealed := sealedRefreshToken(t)
	account := uuid.New()

	live := newService(fakeAccess{}, &fakeStore{
		conn: integrations.Connection{ID: account, UserID: testUser, Email: "author@gmail.com", RefreshSealed: sealed},
	}, &fakeProvider{})
	st, err := live.Status(context.Background(), testUser)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if len(st.Accounts) != 1 || st.Accounts[0].NeedsReconnect {
		t.Errorf("рабочее подключение = %+v, ожидалось без переподключения", st.Accounts)
	}

	// Тот же шифротекст, но открывать его нечем: так выглядит строка, пережившая
	// смену секрета.
	stale := newService(fakeAccess{}, &fakeStore{
		conn: integrations.Connection{ID: account, UserID: testUser, Email: "author@gmail.com", RefreshSealed: append([]byte{0}, sealed...)},
	}, &fakeProvider{})
	st, err = stale.Status(context.Background(), testUser)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if len(st.Accounts) != 1 {
		t.Fatalf("аккаунты = %+v — строка подключения обязана остаться в списке", st.Accounts)
	}
	if !st.Accounts[0].NeedsReconnect {
		t.Error("нерасшифровываемый токен не потребовал переподключения")
	}
}

// Провайдер вправе прислать новый refresh взамен использованного. Выброшенный
// новый токен означает подключение, которое умрёт, когда провайдер погасит
// старый.
func TestAccessToken_RotatedRefreshIsStored(t *testing.T) {
	account := uuid.New()
	store := &fakeStore{conn: integrations.Connection{ID: account, UserID: testUser, RefreshSealed: sealedRefreshToken(t)}}
	store.link = integrations.FormLink{ID: uuid.New(), FormID: testForm, SpreadsheetID: "ss-1"}
	svc := newService(fakeAccess{}, store, &fakeProvider{rotated: "rt-2"})

	if _, err := svc.Spreadsheets(context.Background(), testUser, account); err != nil {
		t.Fatalf("spreadsheets: %v", err)
	}
	if store.tokenUpdated == nil {
		t.Fatal("новый refresh-токен провайдера не сохранён")
	}
	if bytes.Contains(store.tokenUpdated, []byte("rt-2")) {
		t.Error("новый токен записан открытым текстом")
	}
}

// Google новый refresh не присылает — лишней записи в базу быть не должно.
func TestAccessToken_UnchangedRefreshIsNotRewritten(t *testing.T) {
	account := uuid.New()
	store := &fakeStore{conn: integrations.Connection{ID: account, UserID: testUser, RefreshSealed: sealedRefreshToken(t)}}
	svc := newService(fakeAccess{}, store, &fakeProvider{})

	if _, err := svc.Spreadsheets(context.Background(), testUser, account); err != nil {
		t.Fatalf("spreadsheets: %v", err)
	}
	if store.tokenUpdated != nil {
		t.Error("токен переписан, хотя провайдер прислал тот же самый")
	}
}

// sealedRefreshToken — шифротекст, запечатанный ТЕМ ЖЕ ключом, что у сервиса:
// собрать его руками нельзя (sealToken приватен), поэтому берём из подключения.
func sealedRefreshToken(t *testing.T) []byte {
	t.Helper()
	store := &fakeStore{}
	svc := newService(fakeAccess{}, store, &fakeProvider{})
	if _, err := svc.Connect(context.Background(), testUser, "code", "verifier"); err != nil {
		t.Fatalf("connect: %v", err)
	}
	return store.upserted.RefreshSealed
}
