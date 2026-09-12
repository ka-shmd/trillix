package integrations_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/safehttp"
)

// fakeWebhookStore — вебхуки в памяти. writes считает записи: «негодная правка
// не записала ничего» проверяется по нему.
type fakeWebhookStore struct {
	// mu — доставщик разбирает цели параллельно, и фейк обязан это переживать.
	mu      sync.Mutex
	hooks   map[uuid.UUID]integrations.Webhook
	full    bool // потолок на форму достигнут
	cleared []uuid.UUID
	writes  int

	// Очередь и журнал (доставка, webhook_delivery_test.go).
	queue   []queuedItem
	journal []integrations.Delivery
	// now — часы очереди: по ним считается «ждёт дольше срока хранения».
	now func() time.Time
}

// queuedItem — строка очереди фейка.
type queuedItem struct {
	webhookID    uuid.UUID
	submissionID uuid.UUID
	at           time.Time
}

func newFakeWebhookStore() *fakeWebhookStore {
	return &fakeWebhookStore{hooks: map[uuid.UUID]integrations.Webhook{}, now: time.Now}
}

func (f *fakeWebhookStore) InsertWebhook(_ context.Context, _ postgres.DBTX, w integrations.NewWebhook, _ int32) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.full {
		return false, nil
	}
	f.writes++
	f.hooks[w.ID] = integrations.Webhook{
		ID: w.ID, FormID: w.FormID, Name: w.Name, URL: w.URL, Host: hostOf(w.URL),
		SecretSealed: w.SecretSealed, SetBy: w.SetBy, Enabled: true, Status: integrations.StatusLive,
	}
	return true, nil
}

// hostOf — хост адреса, как его выводит настоящий репозиторий при чтении.
func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

func (f *fakeWebhookStore) ListWebhooks(_ context.Context, _ postgres.DBTX, formID uuid.UUID) ([]integrations.Webhook, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []integrations.Webhook
	for _, w := range f.hooks {
		if w.FormID == formID {
			out = append(out, w)
		}
	}
	return out, nil
}

func (f *fakeWebhookStore) GetWebhook(_ context.Context, _ postgres.DBTX, id, formID uuid.UUID) (integrations.Webhook, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.hooks[id]
	if !ok || w.FormID != formID {
		return integrations.Webhook{}, pgx.ErrNoRows
	}
	return w, nil
}

// edit — правка цели под мьютексом. Зовущие его методы блокировку не берут.
func (f *fakeWebhookStore) edit(id, formID uuid.UUID, fn func(*integrations.Webhook)) int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.hooks[id]
	if !ok || w.FormID != formID {
		return 0
	}
	f.writes++
	fn(&w)
	f.hooks[id] = w
	return 1
}

func (f *fakeWebhookStore) UpdateWebhookSettings(_ context.Context, _ postgres.DBTX, id, formID uuid.UUID, name string, enabled bool) (int64, error) {
	return f.edit(id, formID, func(w *integrations.Webhook) { w.Name, w.Enabled = name, enabled }), nil
}

func (f *fakeWebhookStore) UpdateWebhookURL(_ context.Context, _ postgres.DBTX, id, formID uuid.UUID, rawURL string, setBy uuid.UUID) (int64, error) {
	return f.edit(id, formID, func(w *integrations.Webhook) {
		w.URL, w.Host, w.SetBy, w.Status, w.LastError = rawURL, hostOf(rawURL), setBy, integrations.StatusLive, ""
	}), nil
}

func (f *fakeWebhookStore) UpdateWebhookSecret(_ context.Context, _ postgres.DBTX, id, formID uuid.UUID, sealed []byte) (int64, error) {
	return f.edit(id, formID, func(w *integrations.Webhook) { w.SecretSealed = sealed }), nil
}

func (f *fakeWebhookStore) ClearWebhookSecret(_ context.Context, _ postgres.DBTX, id, formID uuid.UUID) (int64, error) {
	return f.edit(id, formID, func(w *integrations.Webhook) { w.SecretSealed = nil }), nil
}

func (f *fakeWebhookStore) DeleteWebhook(_ context.Context, _ postgres.DBTX, id, formID uuid.UUID) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w, ok := f.hooks[id]
	if !ok || w.FormID != formID {
		return 0, nil
	}
	delete(f.hooks, id)
	return 1, nil
}

func (f *fakeWebhookStore) ClearWebhookQueue(_ context.Context, _ postgres.DBTX, id uuid.UUID) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cleared = append(f.cleared, id)
	f.queue = slices.DeleteFunc(f.queue, func(q queuedItem) bool { return q.webhookID == id })
	return nil
}

// fakeEgress — проверка адреса без сети. calls считает вызовы: проверка резолвит
// имя, и постороннему пользоваться этим нельзя.
type fakeEgress struct {
	err   error
	calls int
}

func (f *fakeEgress) Validate(_ context.Context, raw string) (*url.URL, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return url.Parse(raw)
}

// Post здесь не зовут: доставку проверяет webhook_delivery_test.go со своим
// получателем. Реализация нужна, чтобы фейк годился как Egress.
func (f *fakeEgress) Post(context.Context, string, http.Header, []byte) (safehttp.Response, error) {
	return safehttp.Response{}, errors.New("fakeEgress: Post не задан")
}

// newWebhookService — сервис без провайдера Google: вебхуки от его ключей не
// зависят, и dev-контур без проекта в Google Cloud обязан их иметь.
func newWebhookService(access integrations.Access, store *fakeWebhookStore, egress *fakeEgress) *integrations.Service {
	f := fakeForms{form: forms.Form{ID: testForm, WorkspaceID: testWS}}
	return integrations.NewService(nil, directTx{}, &fakeStore{}, access, f, nil, testKey).
		WithWebhooks(store, egress, nil)
}

const testHookURL = "https://hooks.zapier.com/hooks/catch/123/abcSECRET/"

// createHook заводит вебхук БЕЗ подписи (умолчание продукта) и сразу включает
// её нашим секретом — большинству проверок нужен вебхук с секретом.
func createHook(t *testing.T, svc *integrations.Service) (integrations.Webhook, string) {
	t.Helper()
	w, _, err := svc.CreateWebhook(context.Background(), testUser, testForm,
		integrations.WebhookInput{Name: " CRM ", URL: "  " + testHookURL + "  "})
	if err != nil {
		t.Fatalf("create webhook: %v", err)
	}
	secret, err := svc.ReissueWebhookSecret(context.Background(), testUser, testForm, w.ID, "")
	if err != nil {
		t.Fatalf("включение подписи: %v", err)
	}
	return w, secret
}

func TestCreateWebhook_StoresSealedSecretAndAuthor(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})

	w, secret := createHook(t, svc)

	if !strings.HasPrefix(secret, "whsec_") || len(secret) < 40 {
		t.Fatalf("секрет %q — ожидался префикс и 32 случайных байта", secret)
	}
	stored := store.hooks[w.ID]
	if bytes.Contains(stored.SecretSealed, []byte(secret)) {
		t.Fatal("секрет лёг в базу открытым текстом")
	}
	if stored.URL != testHookURL || stored.Name != "CRM" {
		t.Fatalf("сохранено url=%q name=%q — пробелы по краям не обрезаны", stored.URL, stored.Name)
	}
	if stored.SetBy != testUser {
		t.Fatalf("set_by = %s — ответственным за адрес обязан стать заведший", stored.SetBy)
	}
	if w.Host != "hooks.zapier.com" {
		t.Fatalf("хост = %q", w.Host)
	}
}

// Отказ проверки адреса доезжает до человека русским текстом и кодом 422, а не
// внутренним «safehttp: …». Незнакомая ошибка — не отказ адреса, а сбой (500).
func TestCreateWebhook_URLRefusalsAreHuman(t *testing.T) {
	for _, cause := range []error{
		safehttp.ErrScheme, safehttp.ErrUserInfo, safehttp.ErrMalformed,
		safehttp.ErrOwnHost, fmt.Errorf("%w: 10.0.0.5", safehttp.ErrForbiddenAddress), safehttp.ErrNotFound,
	} {
		svc := newWebhookService(fakeAccess{}, newFakeWebhookStore(), &fakeEgress{err: cause})
		_, _, err := svc.CreateWebhook(context.Background(), testUser, testForm, integrations.WebhookInput{URL: testHookURL})
		if !errors.Is(err, domain.ErrValidation) {
			t.Errorf("%v: ошибка %v, ожидался ErrValidation", cause, err)
			continue
		}
		if msg := err.Error(); strings.Contains(msg, "safehttp") || !strings.ContainsAny(msg, "абвгдеёжзийклмнопрстуфхцчшщъыьэюя") {
			t.Errorf("%v: текст %q — ожидался человеческий русский", cause, msg)
		}
	}

	boom := errors.New("resolver exploded")
	svc := newWebhookService(fakeAccess{}, newFakeWebhookStore(), &fakeEgress{err: boom})
	_, _, err := svc.CreateWebhook(context.Background(), testUser, testForm, integrations.WebhookInput{URL: testHookURL})
	if errors.Is(err, domain.ErrValidation) || !errors.Is(err, boom) {
		t.Fatalf("незнакомая ошибка = %v — выдана за отказ адреса", err)
	}
}

func TestCreateWebhook_EmptyURL(t *testing.T) {
	egress := &fakeEgress{}
	svc := newWebhookService(fakeAccess{}, newFakeWebhookStore(), egress)
	_, _, err := svc.CreateWebhook(context.Background(), testUser, testForm, integrations.WebhookInput{URL: "   "})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка %v, ожидался ErrValidation", err)
	}
	if egress.calls != 0 {
		t.Fatal("пустой адрес ушёл на проверку")
	}
}

// Проверка адреса резолвит имя. Кто не вправе править форму — до неё не
// доходит: иначе сервис работал бы DNS-оракулом для постороннего.
func TestCreateWebhook_NoResolveWithoutRight(t *testing.T) {
	egress := &fakeEgress{}
	svc := newWebhookService(readerAccess(), newFakeWebhookStore(), egress)
	if _, _, err := svc.CreateWebhook(context.Background(), testUser, testForm, integrations.WebhookInput{URL: testHookURL}); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("без права на запись: %v, ожидался ErrForbidden", err)
	}

	stranger := integrations.NewService(nil, directTx{}, &fakeStore{}, fakeAccess{},
		fakeForms{getErr: domain.ErrNotFound}, nil, testKey).WithWebhooks(newFakeWebhookStore(), egress, nil)
	if _, _, err := stranger.CreateWebhook(context.Background(), testUser, testForm, integrations.WebhookInput{URL: testHookURL}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("чужая форма: %v, ожидался ErrNotFound", err)
	}
	if egress.calls != 0 {
		t.Fatalf("адрес проверен %d раз для того, кто не вправе", egress.calls)
	}
}

func TestCreateWebhook_Cap(t *testing.T) {
	store := newFakeWebhookStore()
	store.full = true
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	_, _, err := svc.CreateWebhook(context.Background(), testUser, testForm, integrations.WebhookInput{URL: testHookURL})
	if !errors.Is(err, domain.ErrValidation) || !strings.Contains(err.Error(), "5") {
		t.Fatalf("ошибка %v, ожидался отказ с потолком", err)
	}
}

func TestCreateWebhook_LongName(t *testing.T) {
	svc := newWebhookService(fakeAccess{}, newFakeWebhookStore(), &fakeEgress{})
	_, _, err := svc.CreateWebhook(context.Background(), testUser, testForm,
		integrations.WebhookInput{Name: strings.Repeat("я", integrations.MaxConnectionNameLen+1), URL: testHookURL})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка %v, ожидался ErrValidation", err)
	}
}

// Выключение — «не доставлять», а не «доставить позже»: ждущие ответы снимаются
// тем же движением. Включение очередь не трогает.
func TestUpdateWebhook_DisableClearsQueue(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	w, _ := createHook(t, svc)

	on, off := true, false
	if err := svc.UpdateWebhook(context.Background(), testUser, testForm, w.ID, integrations.WebhookPatch{Enabled: &on}); err != nil {
		t.Fatalf("включение: %v", err)
	}
	if len(store.cleared) != 0 {
		t.Fatal("включение сняло очередь")
	}
	if err := svc.UpdateWebhook(context.Background(), testUser, testForm, w.ID, integrations.WebhookPatch{Enabled: &off}); err != nil {
		t.Fatalf("выключение: %v", err)
	}
	if len(store.cleared) != 1 || store.cleared[0] != w.ID {
		t.Fatalf("очередь снята у %v, ожидался ровно выключенный", store.cleared)
	}
	if store.hooks[w.ID].Enabled || store.hooks[w.ID].Name != "CRM" {
		t.Fatalf("после выключения %+v — подпись обязана остаться прежней", store.hooks[w.ID])
	}
}

// Адрес, заданный коллегой, делает ответственным его: сторож членства перед
// доставкой спрашивает про того, кто ПОСЛЕДНИМ решил, куда едут ответы.
func TestUpdateWebhook_URLMakesEditorResponsible(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	w, _ := createHook(t, svc)

	next := "https://hook.eu1.make.com/other"
	if err := svc.UpdateWebhook(context.Background(), testStranger, testForm, w.ID, integrations.WebhookPatch{URL: &next}); err != nil {
		t.Fatalf("правка адреса: %v", err)
	}
	if got := store.hooks[w.ID]; got.URL != next || got.SetBy != testStranger {
		t.Fatalf("после правки url=%q set_by=%s, ожидались новый адрес и правящий", got.URL, got.SetBy)
	}

	// Подпись без адреса ответственного не меняет.
	name := "Архив"
	if err := svc.UpdateWebhook(context.Background(), testUser, testForm, w.ID, integrations.WebhookPatch{Name: &name}); err != nil {
		t.Fatalf("правка подписи: %v", err)
	}
	if store.hooks[w.ID].SetBy != testStranger {
		t.Fatal("правка подписи переписала ответственного за адрес")
	}
}

// Негодный адрес разбирается ДО первой записи: человек не должен увидеть отказ и
// изменившуюся подпись разом.
func TestUpdateWebhook_BadURLWritesNothing(t *testing.T) {
	store := newFakeWebhookStore()
	egress := &fakeEgress{}
	svc := newWebhookService(fakeAccess{}, store, egress)
	w, _ := createHook(t, svc)
	writes := store.writes

	egress.err = safehttp.ErrForbiddenAddress
	name, bad := "Новое имя", "https://internal.example/"
	err := svc.UpdateWebhook(context.Background(), testUser, testForm, w.ID, integrations.WebhookPatch{Name: &name, URL: &bad})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка %v, ожидался ErrValidation", err)
	}
	if store.writes != writes || store.hooks[w.ID].Name != "CRM" {
		t.Fatalf("негодная правка успела записать: %+v", store.hooks[w.ID])
	}
}

// Вебхук другой формы не правится через эту: id из адреса правом не является.
func TestUpdateWebhook_OtherFormNotFound(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	foreign := uuid.New()
	store.hooks[foreign] = integrations.Webhook{ID: foreign, FormID: uuid.New(), URL: testHookURL}

	name := "x"
	if err := svc.UpdateWebhook(context.Background(), testUser, testForm, foreign, integrations.WebhookPatch{Name: &name}); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("правка чужого: %v, ожидался ErrNotFound", err)
	}
	if err := svc.DeleteWebhook(context.Background(), testUser, testForm, foreign); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("удаление чужого: %v, ожидался ErrNotFound", err)
	}
	if _, err := svc.WebhookSecret(context.Background(), testUser, testForm, foreign); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("секрет чужого: %v, ожидался ErrNotFound", err)
	}
	if _, err := svc.ReissueWebhookSecret(context.Background(), testUser, testForm, foreign, ""); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("перевыпуск чужого: %v, ожидался ErrNotFound", err)
	}
	if _, ok := store.hooks[foreign]; !ok {
		t.Fatal("чужой вебхук удалён")
	}
}

func TestWebhookSecret_ShowAndReissue(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	w, secret := createHook(t, svc)

	got, err := svc.WebhookSecret(context.Background(), testUser, testForm, w.ID)
	if err != nil || got != secret {
		t.Fatalf("показ секрета = %q, %v; ожидался выданный при заведении", got, err)
	}
	fresh, err := svc.ReissueWebhookSecret(context.Background(), testUser, testForm, w.ID, "")
	if err != nil {
		t.Fatalf("перевыпуск: %v", err)
	}
	if fresh == secret {
		t.Fatal("перевыпуск вернул прежний секрет")
	}
	if got, _ := svc.WebhookSecret(context.Background(), testUser, testForm, w.ID); got != fresh {
		t.Fatalf("после перевыпуска показан %q, ожидался новый", got)
	}
}

// Шифротекст, переживший ротацию FORM_TOKEN_SECRET, не открывается — человеку
// нужен ответ «перевыпустите», а не пятисотка.
func TestWebhookSecret_UnreadableAsksReissue(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	w, _ := createHook(t, svc)
	stale := store.hooks[w.ID]
	stale.SecretSealed = []byte("шифротекст от прошлого ключа приложения")
	store.hooks[w.ID] = stale

	_, err := svc.WebhookSecret(context.Background(), testUser, testForm, w.ID)
	if !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "перевыпустите") {
		t.Fatalf("ошибка %v, ожидался конфликт с советом перевыпустить", err)
	}
}

// Адрес вебхука — секрет (токен Zapier и Make в пути): в состоянии таба он есть
// только у того, кто вправе править форму. Хост видят все, кто видит форму.
func TestFormStatus_WebhookURLOnlyForEditors(t *testing.T) {
	store := newFakeWebhookStore()
	editor := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	createHook(t, editor)

	st, err := editor.FormStatus(context.Background(), testUser, testForm)
	if err != nil {
		t.Fatalf("состояние: %v", err)
	}
	if len(st.Webhooks) != 1 || st.Webhooks[0].URL != testHookURL {
		t.Fatalf("редактору: %+v, ожидался полный адрес", st.Webhooks)
	}

	reader := newWebhookService(readerAccess(), store, &fakeEgress{})
	st, err = reader.FormStatus(context.Background(), testUser, testForm)
	if err != nil {
		t.Fatalf("состояние читателя: %v", err)
	}
	if len(st.Webhooks) != 1 {
		t.Fatalf("читателю вебхуков %d — сам вебхук он видеть обязан", len(st.Webhooks))
	}
	if st.Webhooks[0].URL != "" {
		t.Fatalf("читателю ушёл адрес %q", st.Webhooks[0].URL)
	}
	if st.Webhooks[0].Host != "hooks.zapier.com" {
		t.Fatalf("читателю хост = %q", st.Webhooks[0].Host)
	}
	if store.hooks[st.Webhooks[0].ID].URL != testHookURL {
		t.Fatal("сокрытие адреса задело хранилище")
	}
}

// Секрет, заданный АВТОРОМ: у человека с двадцатью формами иначе двадцать разных
// секретов и двадцать записей в конфиге получателя (ADR §10, второй круг).
func TestWebhookSecret_CustomAccepted(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	w, generated := createHook(t, svc)

	const mine = "  общий-секрет-на-все-формы  "
	got, err := svc.ReissueWebhookSecret(context.Background(), testUser, testForm, w.ID, mine)
	if err != nil {
		t.Fatalf("свой секрет: %v", err)
	}
	if got != strings.TrimSpace(mine) {
		t.Fatalf("секрет = %q — пробелы по краям не обрезаны", got)
	}
	if got == generated {
		t.Fatal("свой секрет не заменил наш")
	}
	// Лёг шифротекстом, как и наш собственный.
	if bytes.Contains(store.hooks[w.ID].SecretSealed, []byte(strings.TrimSpace(mine))) {
		t.Fatal("свой секрет лёг в базу открытым текстом")
	}
	shown, err := svc.WebhookSecret(context.Background(), testUser, testForm, w.ID)
	if err != nil || shown != strings.TrimSpace(mine) {
		t.Fatalf("показан %q, %v — ожидался секрет автора", shown, err)
	}
}

// Слабый секрет обесценивает подпись целиком, поэтому у авторского есть планка.
// Нашего собственного она не касается — он длиннее вчетверо.
func TestWebhookSecret_CustomRejected(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})
	w, before := createHook(t, svc)

	for _, bad := range []string{
		"123456",
		strings.Repeat("я", integrations.MinWebhookSecretLen-1),
		strings.Repeat("x", integrations.MaxWebhookSecretLen+1),
		"секрет-с-переносом\nстроки-и-длиной",
	} {
		_, err := svc.ReissueWebhookSecret(context.Background(), testUser, testForm, w.ID, bad)
		if !errors.Is(err, domain.ErrValidation) {
			t.Errorf("секрет %q: ошибка %v, ожидался ErrValidation", bad, err)
		}
	}
	// Ни одна негодная попытка не заменила действующий секрет.
	if got, _ := svc.WebhookSecret(context.Background(), testUser, testForm, w.ID); got != before {
		t.Fatalf("секрет подменён на %q", got)
	}
}

// Секрет автора принимается СРАЗУ при заведении: про него человек думает в тот
// же заход, когда настраивает проверку у получателя.
func TestCreateWebhook_WithAuthorSecret(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})

	const mine = "общий-секрет-на-все-формы"
	w, secret, err := svc.CreateWebhook(context.Background(), testUser, testForm,
		integrations.WebhookInput{URL: testHookURL, Secret: mine})
	if err != nil {
		t.Fatalf("заведение со своим секретом: %v", err)
	}
	if secret != mine {
		t.Fatalf("секрет = %q, ожидался заданный автором", secret)
	}
	if shown, _ := svc.WebhookSecret(context.Background(), testUser, testForm, w.ID); shown != mine {
		t.Fatalf("показан %q", shown)
	}

	// Короткий отвергается, и вебхук при этом не заводится.
	before := len(store.hooks)
	_, _, err = svc.CreateWebhook(context.Background(), testUser, testForm,
		integrations.WebhookInput{URL: testHookURL, Secret: "123456"})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("короткий секрет: %v, ожидался ErrValidation", err)
	}
	if len(store.hooks) != before {
		t.Fatal("вебхук завёлся вопреки отказу по секрету")
	}
}

// Подключение — это адрес и всё: подписи по умолчанию нет, секрета не заводится.
// Включается она отдельно, тумблером в настройках, и так же выключается.
func TestWebhookSignature_OffByDefault(t *testing.T) {
	store := newFakeWebhookStore()
	svc := newWebhookService(fakeAccess{}, store, &fakeEgress{})

	w, secret, err := svc.CreateWebhook(context.Background(), testUser, testForm,
		integrations.WebhookInput{URL: testHookURL})
	if err != nil {
		t.Fatalf("подключение: %v", err)
	}
	if secret != "" || len(store.hooks[w.ID].SecretSealed) != 0 {
		t.Fatalf("у свежего вебхука завёлся секрет %q — подписи по умолчанию нет", secret)
	}
	// Показывать нечего: секрета нет, и это состояние, а не сбой.
	if _, err := svc.WebhookSecret(context.Background(), testUser, testForm, w.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("показ секрета выключенной подписи: %v, ожидался ErrNotFound", err)
	}

	fresh, err := svc.ReissueWebhookSecret(context.Background(), testUser, testForm, w.ID, "")
	if err != nil {
		t.Fatalf("включение подписи: %v", err)
	}
	if fresh == "" || len(store.hooks[w.ID].SecretSealed) == 0 {
		t.Fatal("включение подписи не завело секрет")
	}

	if err := svc.DisableWebhookSignature(context.Background(), testUser, testForm, w.ID); err != nil {
		t.Fatalf("выключение подписи: %v", err)
	}
	if len(store.hooks[w.ID].SecretSealed) != 0 {
		t.Fatal("после выключения секрет остался")
	}
	// Чужой вебхук выключением подписи не тронуть.
	if err := svc.DisableWebhookSignature(context.Background(), testUser, testForm, uuid.New()); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("выключение чужого: %v, ожидался ErrNotFound", err)
	}
}
