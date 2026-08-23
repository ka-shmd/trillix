package integrations_test

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/postgres"
)

var (
	testKey  = []byte("form-token-secret-of-decent-length")
	testUser = uuid.MustParse("00000000-0000-7000-8000-000000000001")
	testWS   = uuid.MustParse("00000000-0000-7000-8000-000000000002")
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

type fakeProvider struct {
	exchanged  bool
	revoked    string
	exchangeFn func() (integrations.Tokens, error)
}

func (f *fakeProvider) Provider() string { return "google" }

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

func newService(access integrations.Access, store integrations.Store, p integrations.Provider) *integrations.Service {
	return integrations.NewService(nil, store, access, p, testKey)
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
