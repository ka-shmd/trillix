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
)

// fakeAccess — права как ответ на ДЕЙСТВИЕ: ровно то, что спрашивает сервис.
type fakeAccess struct {
	deny map[domain.Action]error
}

func (f fakeAccess) Can(_ context.Context, _, _ uuid.UUID, a domain.Action) error {
	return f.deny[a]
}

// editorAccess — редактор: читать интеграции можно, управлять нельзя.
func editorAccess() fakeAccess {
	return fakeAccess{deny: map[domain.Action]error{domain.ActionIntegrationManage: domain.ErrForbidden}}
}

// strangerAccess — не участник: обоим вопросам 404, существование чужого
// пространства не раскрывается.
func strangerAccess() fakeAccess {
	return fakeAccess{deny: map[domain.Action]error{
		domain.ActionIntegrationRead:   domain.ErrNotFound,
		domain.ActionIntegrationManage: domain.ErrNotFound,
	}}
}

type fakeStore struct {
	conn      integrations.Connection
	getErr    error
	upserted  *integrations.NewConnection
	deleted   []byte
	deleteErr error

	link        integrations.FormLink
	linkErr     error
	insertedLnk *integrations.NewFormLink
	unlinked    bool

	columnsSet   []domain.SheetColumn
	delivered    bool
	brokenWith   string
	backfillFrom *time.Time
	backfillDone bool
	sheetCleared bool
}

func (f *fakeStore) Upsert(_ context.Context, _ postgres.DBTX, c integrations.NewConnection) error {
	f.upserted = &c
	return nil
}

func (f *fakeStore) Get(_ context.Context, _ postgres.DBTX, _ uuid.UUID, _ string) (integrations.Connection, error) {
	if f.getErr != nil {
		return integrations.Connection{}, f.getErr
	}
	return f.conn, nil
}

func (f *fakeStore) Delete(_ context.Context, _ postgres.DBTX, _ uuid.UUID, _ string) ([]byte, error) {
	if f.deleteErr != nil {
		return nil, f.deleteErr
	}
	return f.deleted, nil
}

func (f *fakeStore) InsertLink(_ context.Context, _ postgres.DBTX, l integrations.NewFormLink) error {
	f.insertedLnk = &l
	return nil
}

func (f *fakeStore) GetLink(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (integrations.FormLink, error) {
	if f.linkErr != nil {
		return integrations.FormLink{}, f.linkErr
	}
	return f.link, nil
}

func (f *fakeStore) DeleteLink(_ context.Context, _ postgres.DBTX, _ uuid.UUID) error {
	f.unlinked = true
	return nil
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
	exchangeFn   func() (integrations.Tokens, error)
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
	return integrations.Tokens{Access: "at"}, nil
}

func (f *fakeProvider) Account(_ context.Context, _ string) (integrations.Account, error) {
	return integrations.Account{ID: "sub-1", Email: "author@gmail.com"}, nil
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
	return integrations.NewService(nil, store, access, f, p, testKey)
}

// Редактор видит состояние, но кнопки управления не получает. Проверяется
// именно ЭТО поле, а не роль: экран рисует кнопку по нему.
func TestStatus_EditorCannotManage(t *testing.T) {
	svc := newService(editorAccess(), &fakeStore{getErr: pgx.ErrNoRows}, &fakeProvider{})

	st, err := svc.Status(context.Background(), testUser, testWS)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.CanManage {
		t.Error("редактор получил право управлять интеграцией")
	}
	if !st.Enabled || st.Connected {
		t.Errorf("состояние = %+v, ожидалось «настроено, но не подключено»", st)
	}
}

// Не участник не получает даже состояния — и получает 404, а не 403
// (существование чужого пространства не раскрывается, инвариант 5).
func TestStatus_StrangerGetsNotFound(t *testing.T) {
	svc := newService(strangerAccess(), &fakeStore{}, &fakeProvider{})

	_, err := svc.Status(context.Background(), testUser, testWS)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
	}
}

// Право проверяется ДО похода к провайдеру: иначе редактор проходил бы согласие
// Google и отдавал приложению доступ к своему Диску, чтобы получить отказ.
func TestConnect_EditorRefusedBeforeProvider(t *testing.T) {
	store := &fakeStore{}
	provider := &fakeProvider{}
	svc := newService(editorAccess(), store, provider)

	err := svc.Connect(context.Background(), testUser, testWS, "code", "verifier")
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ошибка = %v, ожидалась ErrForbidden", err)
	}
	if provider.exchanged {
		t.Error("код обменян до проверки права")
	}
	if store.upserted != nil {
		t.Error("подключение записано редактору")
	}
}

// Владелец подключает: в базу уезжает ШИФРОТЕКСТ, а не токен провайдера.
func TestConnect_StoresSealedToken(t *testing.T) {
	store := &fakeStore{}
	svc := newService(fakeAccess{}, store, &fakeProvider{})

	if err := svc.Connect(context.Background(), testUser, testWS, "code", "verifier"); err != nil {
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
	if got.ConnectedBy != testUser || got.WorkspaceID != testWS {
		t.Errorf("подключение записано не тому: by=%s ws=%s", got.ConnectedBy, got.WorkspaceID)
	}
}

// Отключение идемпотентно: второй запрос из соседней вкладки не должен краснеть.
func TestDisconnect_Idempotent(t *testing.T) {
	provider := &fakeProvider{}
	svc := newService(fakeAccess{}, &fakeStore{deleteErr: pgx.ErrNoRows}, provider)

	if err := svc.Disconnect(context.Background(), testUser, testWS); err != nil {
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
	if err := newService(fakeAccess{}, store, &fakeProvider{}).
		Connect(context.Background(), testUser, testWS, "code", "verifier"); err != nil {
		t.Fatalf("подготовка: %v", err)
	}

	provider := &fakeProvider{}
	svc := newService(fakeAccess{}, &fakeStore{deleted: store.upserted.RefreshSealed}, provider)
	if err := svc.Disconnect(context.Background(), testUser, testWS); err != nil {
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

	st, err := svc.Status(context.Background(), testUser, testWS)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if st.Enabled || st.Connected {
		t.Errorf("состояние = %+v, ожидалось «не настроено»", st)
	}
	if !st.CanManage {
		t.Error("владелец потерял право управлять из-за ненастроенного провайдера")
	}

	if _, err := svc.StartURL(context.Background(), testUser, testWS, "s", "v"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("StartURL = %v, ожидалась ErrNotFound", err)
	}
	if err := svc.Connect(context.Background(), testUser, testWS, "c", "v"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("Connect = %v, ожидалась ErrNotFound", err)
	}
	if err := svc.Disconnect(context.Background(), testUser, testWS); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("Disconnect = %v, ожидалась ErrNotFound", err)
	}
}

// defaultOptions — то, с чем окно настроек приходит по умолчанию: новая книга и
// перенос накопленных ответов включён.
func defaultOptions() integrations.ConnectOptions {
	return integrations.ConnectOptions{Backfill: true}
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

	link, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions())
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

	_, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions())
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
	if store.insertedLnk != nil {
		t.Error("привязка записана без подключённого аккаунта")
	}
}

// Вторая привязка — конфликт, а не молчаливая перезапись: иначе первая таблица
// осталась бы висеть в Диске автора сиротой, и он бы про неё не узнал.
func TestConnectForm_AlreadyLinked(t *testing.T) {
	store := &fakeStore{conn: sealedConn(t)}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{})

	_, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions())
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ошибка = %v, ожидалась ErrConflict", err)
	}
}

// Чужая форма не раскрывается даже отказом: forms.Get отвечает 404, и до
// провайдера дело не доходит.
func TestConnectForm_StrangerGetsNotFound(t *testing.T) {
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, &fakeStore{}, fakeForms{getErr: domain.ErrNotFound}, provider)

	if _, err := svc.ConnectForm(context.Background(), testUser, testForm, defaultOptions()); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
	}
	if provider.createdTitle != "" {
		t.Error("таблица создана для чужой формы")
	}
}

// Отвязка формы НЕ трогает таблицу в Диске автора: продукт не удаляет чужие
// файлы. Проверяется тем, что провайдера не дёргали вовсе.
func TestDisconnectForm_KeepsSpreadsheet(t *testing.T) {
	store := &fakeStore{link: integrations.FormLink{SpreadsheetID: "sheet-id"}}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, provider)

	if err := svc.DisconnectForm(context.Background(), testUser, testForm); err != nil {
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
	if err := newService(fakeAccess{}, store, &fakeProvider{}).
		Connect(context.Background(), testUser, testWS, "code", "verifier"); err != nil {
		t.Fatalf("подготовка подключения: %v", err)
	}
	return integrations.Connection{
		ID:            store.upserted.ID,
		WorkspaceID:   testWS,
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

	if err := svc.RefillForm(context.Background(), testUser, testForm); err != nil {
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

// Непривязанной форме перезаливать нечего — 422 с человеческим текстом, а не 500.
func TestRefillForm_NotLinked(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{})

	err := svc.RefillForm(context.Background(), testUser, testForm)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
}

// Тумблер «перенести накопленные ответы» выключен: связка сразу живая, перенос
// не начинается. Это выбор человека — у формы может быть двадцать тысяч
// ответов, которые ему в новой таблице не нужны.
func TestConnectForm_WithoutBackfill(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, &fakeProvider{})

	link, err := svc.ConnectForm(context.Background(), testUser, testForm,
		integrations.ConnectOptions{Backfill: false})
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
		integrations.ConnectOptions{Name: "Заявки с лендинга", SpreadsheetID: "ss-old", Backfill: true})
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

	cred, err := svc.Picker(context.Background(), testUser, testForm)
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
	svc := newFormService(fakeAccess{}, &fakeStore{conn: sealedConn(t)}, fakeForms{form: linkedForm()}, &fakeProvider{})

	if _, err := svc.Picker(context.Background(), testUser, testForm); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
	}
	st, err := svc.Status(context.Background(), testUser, testWS)
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

	if _, err := svc.Picker(context.Background(), testUser, testForm); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
}

// Чужая форма не раскрывается: 404 и никакого токена.
func TestPicker_StrangerGetsNotFound(t *testing.T) {
	svc := newFormService(fakeAccess{}, &fakeStore{}, fakeForms{getErr: domain.ErrNotFound}, &fakeProvider{}).
		WithPicker("browser-api-key")

	if _, err := svc.Picker(context.Background(), testUser, testForm); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидалась ErrNotFound", err)
	}
}

// Выбран существующий лист книги: новый не заводим, шапку пишем в него.
func TestConnectForm_IntoExistingSheet(t *testing.T) {
	store := &fakeStore{linkErr: pgx.ErrNoRows, conn: sealedConn(t)}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, provider)

	sheetID := int32(5)
	link, err := svc.ConnectForm(context.Background(), testUser, testForm,
		integrations.ConnectOptions{SpreadsheetID: "ss-old", SheetID: &sheetID})
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
		integrations.ConnectOptions{SpreadsheetID: "ss-old", SheetID: &sheetID})
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
		integrations.ConnectOptions{SpreadsheetID: "ss-old", SheetID: &sheetID})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась ErrValidation", err)
	}
}
