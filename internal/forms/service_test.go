package forms

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// fakeStore — управляемая реализация Store для юнитов сервиса (без БД).
type fakeStore struct {
	personalWS  uuid.UUID
	personalErr error

	// Расписание записи (фаза 27): что вернёт проверка принадлежности и что унесла
	// последняя привязка.
	scheduleInWorkspace bool
	lastScheduleID      *uuid.UUID

	form   Form
	getErr error

	listRows []ListRow
	listErr  error

	created bool
	updated bool
	deleted bool
	deleteN int64

	// Управление путём публикации.
	nextVersion     int32
	versionInserted bool
	published       bool
	closed          bool
	lastVersion     int32
	lastSnapshot    json.RawMessage

	// Управление публичной выдачей по slug.
	publicForm PublicForm
	publicErr  error

	// Управление паролем формы (0047): что лежит в колонке и что туда записали.
	sealedPassword []byte
	passwordErr    error
	lastSealed     []byte
	passwordSet    bool

	// Управление чтением версий (CSV-экспорт).
	versions []Version

	// Согласие (0069): ревизии формы по id, текущая и число вставок.
	consentRevs     map[uuid.UUID]ConsentRevision
	consentCurrent  *uuid.UUID
	consentInserted int
	// consentRemembered — наборы, положенные в список реквизитов пространства.
	consentRemembered []domain.ConsentOperator
	versionSchemas    map[int32]json.RawMessage

	// Управление путём автосейва схемы.
	schemaSaved     bool
	schemaErr       error // если задана — UpdateFormDraftSchema вернёт её (напр. pgx.ErrNoRows)
	lastSchema      json.RawMessage
	lastMirrorTitle *string
	lastExpected    time.Time

	// Захват настроек закрытия последнего UpdateCloseSettings.
	lastCloseSettings domain.CloseSettings

	// Захват карточки ссылки последнего UpdateLinkPreview.
	lastLinkPreview *domain.LinkPreview

	// Тумблер уведомлений (слайс D) и адресат уведомления.
	lastNotifyEnabled  bool
	lastCollectPartial bool
	lastBranding       bool
	lastProgress       bool
	lastNotifyEmail    *domain.NotifyEmail
	lastRespondent     *domain.RespondentEmail
	lastRespondentOn   bool
	owner              Owner
	ownerErr           error

	// Захват аргументов последнего вызова — для проверок «куда положили».
	lastCreateWS     uuid.UUID
	lastListWS       uuid.UUID
	lastCreateTitle  string
	lastCreateSlug   string
	lastCreateName   *string
	lastCreateSchema json.RawMessage

	// Управление нумерацией копий (ListFormNames).
	formNames      []FormName
	formNamesErr   error
	lastListLimit  int32
	lastListAfter  bool
	lastListSort   string
	lastListSearch string
	lastListStatus string

	searchHits      []SearchHit
	searchErr       error
	lastSearchUser  uuid.UUID
	lastSearchQuery string
	lastSearchLimit int32
}

func (f *fakeStore) GetPersonalWorkspace(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (uuid.UUID, error) {
	return f.personalWS, f.personalErr
}

func (f *fakeStore) CreateForm(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, title, slug string) (Form, error) {
	f.created = true
	f.lastCreateWS = workspaceID
	f.lastCreateTitle = title
	f.lastCreateSlug = slug
	return Form{ID: id, WorkspaceID: workspaceID, Title: title, Slug: slug, Status: "draft"}, nil
}

func (f *fakeStore) CreateFormWithSchema(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, title, slug string, name *string, schema json.RawMessage) (Form, error) {
	f.created = true
	f.lastCreateWS = workspaceID
	f.lastCreateTitle = title
	f.lastCreateSlug = slug
	f.lastCreateName = name
	f.lastCreateSchema = schema
	return Form{ID: id, WorkspaceID: workspaceID, Name: name, Title: title, Slug: slug, Status: "draft", DraftSchema: schema}, nil
}

func (f *fakeStore) UpdateFormName(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, name *string) (Form, error) {
	f.updated = true
	return Form{ID: id, WorkspaceID: workspaceID, Name: name}, nil
}

func (f *fakeStore) UpdateFormCloseSettings(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, s domain.CloseSettings) (Form, error) {
	f.updated = true
	f.lastCloseSettings = s
	return Form{ID: id, WorkspaceID: workspaceID, CloseAt: s.CloseAt, ResponseLimit: s.ResponseLimit}, nil
}

func (f *fakeStore) UpdateFormNotifyOnSubmission(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error) {
	f.updated = true
	f.lastNotifyEnabled = enabled
	return Form{ID: id, WorkspaceID: workspaceID, NotifyOnSubmission: enabled}, nil
}

func (f *fakeStore) UpdateBranding(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, show bool) (Form, error) {
	f.updated = true
	f.lastBranding = show
	return Form{ID: id, WorkspaceID: workspaceID, Branding: show}, nil
}

func (f *fakeStore) UpdateFormBehavior(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, autoJump, saveLocally, allowBack bool) (Form, error) {
	f.updated = true
	return Form{ID: id, WorkspaceID: workspaceID, AutoJump: autoJump, SaveLocally: saveLocally, AllowBack: allowBack}, nil
}

func (f *fakeStore) SetFormReopened(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID) (Form, error) {
	f.updated = true
	return Form{ID: id, WorkspaceID: workspaceID, Status: domain.FormStatusPublished}, nil
}

func (f *fakeStore) UpdateFormNotifyEmail(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, n *domain.NotifyEmail) (Form, error) {
	f.updated = true
	f.lastNotifyEmail = n
	return Form{ID: id, WorkspaceID: workspaceID, NotifyEmail: n}, nil
}

func (f *fakeStore) UpdateFormNotifyRespondent(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error) {
	f.updated = true
	f.lastRespondentOn = enabled
	return Form{ID: id, WorkspaceID: workspaceID, NotifyRespondent: enabled}, nil
}

// Расписание записи (фаза 27): фейк принимает любое из «того же» пространства —
// проверку членства проверяют интеграционные тесты против настоящей базы.
func (f *fakeStore) UpdateFormSchedule(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, scheduleID *uuid.UUID) (Form, error) {
	f.updated = true
	f.lastScheduleID = scheduleID
	return Form{ID: id, WorkspaceID: workspaceID, ScheduleID: scheduleID}, nil
}

func (f *fakeStore) ScheduleInWorkspace(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (bool, error) {
	return f.scheduleInWorkspace, nil
}

func (f *fakeStore) UpdateFormPassword(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, sealed []byte) (Form, error) {
	f.updated = true
	f.passwordSet = true
	f.lastSealed = sealed
	return Form{ID: id, WorkspaceID: workspaceID, PasswordSealed: sealed}, nil
}

func (f *fakeStore) GetFormPasswordBySlug(_ context.Context, _ postgres.DBTX, _ string) (uuid.UUID, []byte, error) {
	if f.passwordErr != nil {
		return uuid.Nil, nil, f.passwordErr
	}
	return f.form.ID, f.sealedPassword, nil
}

func (f *fakeStore) UpdateFormRespondentEmail(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, r *domain.RespondentEmail) (Form, error) {
	f.updated = true
	f.lastRespondent = r
	return Form{ID: id, WorkspaceID: workspaceID, RespondentEmail: r}, nil
}

func (f *fakeStore) UpdateProgress(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, show bool) (Form, error) {
	f.updated = true
	f.lastProgress = show
	return Form{ID: id, WorkspaceID: workspaceID, Progress: show}, nil
}

func (f *fakeStore) UpdateCollectPartial(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, enabled bool) (Form, error) {
	f.updated = true
	f.lastCollectPartial = enabled
	return Form{ID: id, WorkspaceID: workspaceID, CollectPartial: enabled}, nil
}

func (f *fakeStore) UpdateFormLinkPreview(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, p *domain.LinkPreview) (Form, error) {
	f.updated = true
	f.lastLinkPreview = p
	return Form{ID: id, WorkspaceID: workspaceID, LinkPreview: p}, nil
}

func (f *fakeStore) GetSubmissionOwner(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (Owner, error) {
	return f.owner, f.ownerErr
}

func (f *fakeStore) ListFormNames(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]FormName, error) {
	return f.formNames, f.formNamesErr
}

func (f *fakeStore) GetForm(_ context.Context, _ postgres.DBTX, id uuid.UUID) (Form, error) {
	if f.getErr != nil {
		return Form{}, f.getErr
	}
	form := f.form
	form.ID = id
	return form, nil
}

func (f *fakeStore) GetFormBySlug(_ context.Context, _ postgres.DBTX, slug string) (Form, error) {
	if f.getErr != nil {
		return Form{}, f.getErr
	}
	form := f.form
	form.Slug = slug
	return form, nil
}

func (f *fakeStore) SearchForms(_ context.Context, _ postgres.DBTX, userID uuid.UUID, search string, limit int32) ([]SearchHit, error) {
	f.lastSearchUser = userID
	f.lastSearchQuery = search
	f.lastSearchLimit = limit
	return f.searchHits, f.searchErr
}

func (f *fakeStore) ListFormsPage(_ context.Context, _ postgres.DBTX, q ListPageQuery) ([]ListRow, error) {
	f.lastListWS = q.WorkspaceID
	f.lastListLimit = q.Limit
	f.lastListAfter = q.After != nil
	f.lastListSort = q.Sort
	f.lastListSearch = q.Search
	f.lastListStatus = q.Status
	return f.listRows, f.listErr
}

func (f *fakeStore) UpdateFormDraftSchema(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID, schema json.RawMessage, mirrorTitle *string, expectedUpdatedAt time.Time) (Form, error) {
	f.lastSchema = schema
	f.lastMirrorTitle = mirrorTitle
	f.lastExpected = expectedUpdatedAt
	if f.schemaErr != nil {
		return Form{}, f.schemaErr
	}
	f.schemaSaved = true
	return Form{ID: id, WorkspaceID: workspaceID, DraftSchema: schema}, nil
}

func (f *fakeStore) DeleteForm(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (int64, error) {
	f.deleted = true
	return f.deleteN, nil
}

func (f *fakeStore) NextFormVersion(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (int32, error) {
	return f.nextVersion, nil
}

func (f *fakeStore) ListFormVersions(_ context.Context, _ postgres.DBTX, _ uuid.UUID) ([]Version, error) {
	return f.versions, nil
}

func (f *fakeStore) GetFormVersionSchema(_ context.Context, _ postgres.DBTX, _ uuid.UUID, version int32) (json.RawMessage, error) {
	raw, ok := f.versionSchemas[version]
	if !ok {
		return nil, pgx.ErrNoRows
	}
	return raw, nil
}

func (f *fakeStore) GetFormConsent(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (ConsentRevision, error) {
	if f.consentCurrent == nil {
		return ConsentRevision{}, pgx.ErrNoRows
	}
	return f.consentRevs[*f.consentCurrent], nil
}

func (f *fakeStore) GetConsentRevision(_ context.Context, _ postgres.DBTX, _, revisionID uuid.UUID) (ConsentRevision, error) {
	rev, ok := f.consentRevs[revisionID]
	if !ok {
		return ConsentRevision{}, pgx.ErrNoRows
	}
	return rev, nil
}

func (f *fakeStore) InsertConsentRevision(_ context.Context, _ postgres.DBTX, in NewConsentRevision) (ConsentRevision, error) {
	if f.consentRevs == nil {
		f.consentRevs = map[uuid.UUID]ConsentRevision{}
	}
	rev := ConsentRevision{ID: in.ID, Enabled: in.Enabled, Settings: in.Settings, Template: in.Template, CreatedAt: time.Now()}
	f.consentRevs[in.ID] = rev
	f.consentInserted++
	return rev, nil
}

func (f *fakeStore) SetFormConsentRevision(_ context.Context, _ postgres.DBTX, _, _, revisionID uuid.UUID) (int64, error) {
	f.consentCurrent = &revisionID
	return 1, nil
}

func (f *fakeStore) RememberConsentOperator(_ context.Context, _ postgres.DBTX, _ uuid.UUID, o domain.ConsentOperator) error {
	f.consentRemembered = append(f.consentRemembered, o)
	return nil
}

func (f *fakeStore) ListConsentOperators(context.Context, postgres.DBTX, uuid.UUID, int32) ([]ConsentOperatorItem, error) {
	return nil, nil
}

func (f *fakeStore) GetConsentOperatorWorkspace(context.Context, postgres.DBTX, uuid.UUID) (uuid.UUID, error) {
	return uuid.Nil, pgx.ErrNoRows
}

func (f *fakeStore) DeleteConsentOperator(context.Context, postgres.DBTX, uuid.UUID, uuid.UUID) (int64, error) {
	return 0, nil
}

func (f *fakeStore) InsertFormVersion(_ context.Context, _ postgres.DBTX, id, _ uuid.UUID, version int32, schema json.RawMessage) (uuid.UUID, error) {
	f.versionInserted = true
	f.lastVersion = version
	f.lastSnapshot = schema
	return id, nil
}

func (f *fakeStore) SetFormPublished(_ context.Context, _ postgres.DBTX, id, workspaceID, versionID uuid.UUID) (Form, error) {
	f.published = true
	vid := versionID
	return Form{ID: id, WorkspaceID: workspaceID, Status: "published", PublishedVersionID: &vid}, nil
}

func (f *fakeStore) SetFormClosed(_ context.Context, _ postgres.DBTX, id, workspaceID uuid.UUID) (Form, error) {
	f.closed = true
	return Form{ID: id, WorkspaceID: workspaceID, Status: "closed"}, nil
}

func (f *fakeStore) GetPublicFormRefBySlug(_ context.Context, _ postgres.DBTX, _ string) (PublicFormRef, error) {
	if f.publicErr != nil {
		return PublicFormRef{}, f.publicErr
	}
	return f.publicForm.PublicFormRef, nil
}

func (f *fakeStore) GetPublicFormBySlug(_ context.Context, _ postgres.DBTX, _ string) (PublicForm, error) {
	if f.publicErr != nil {
		return PublicForm{}, f.publicErr
	}
	return f.publicForm, nil
}

// fakeTx выполняет fn без реальной транзакции (nil-tx: fakeStore игнорирует db).
type fakeTx struct{}

func (fakeTx) WithTx(_ context.Context, fn func(pgx.Tx) error) error {
	return fn(nil)
}

// fakeAccess — права, подменённые вердиктом: юниты forms проверяют СВОЮ логику,
// а матрица прав живёт и тестируется в workspaces.
type fakeAccess struct {
	err        error
	gotActions []domain.Action
}

func (a *fakeAccess) Can(_ context.Context, _, _ uuid.UUID, action domain.Action) error {
	a.gotActions = append(a.gotActions, action)
	return a.err
}

// fakePlans — тариф в юнитах. Разрешающий по умолчанию: гейт оформления проверяется
// СВОИМИ тестами (ниже), а остальным сотне сценариев тариф безразличен, и молчаливо
// запрещающий фейк красил бы их все.
type fakePlans struct {
	allowed bool
	// period — расчётный период, который возвращает проверка. Списание обязано
	// попасть в него же (фаза 26).
	period time.Time
	// consumed — периоды состоявшихся списаний генерации; consumeErr — отказ
	// счётчика.
	consumed   []time.Time
	consumeErr error
	// deny — точечный запрет по ключу поверх allowed: без него тест не может
	// отличить два ключа друг от друга (разрешено всё, кроме одного).
	deny    map[entitlements.Key]bool
	err     error
	gotKeys []entitlements.Key
}

func (p *fakePlans) CheckWorkspace(_ context.Context, _ uuid.UUID, key entitlements.Key) (entitlements.Decision, error) {
	p.gotKeys = append(p.gotKeys, key)
	return entitlements.Decision{Allowed: p.allowed && !p.deny[key], Period: p.period}, p.err
}

func (p *fakePlans) ConsumeAIGeneration(_ context.Context, _ uuid.UUID, period time.Time) error {
	p.consumed = append(p.consumed, period)
	return p.consumeErr
}

func newTestService(store *fakeStore) *Service {
	return NewService(nil, fakeTx{}, store, &fakeAccess{}, &fakePlans{allowed: true})
}

// newDeniedService — сервис, у которого проверка прав отвечает «нельзя».
// Отказ берётся ErrNotFound: так Can отвечает НЕ УЧАСТНИКУ, а именно это
// проверяют анти-IDOR-тесты ниже (участник без нужной роли получает 403 — это
// проверяется в workspaces, где живёт матрица).
func newDeniedService(store *fakeStore) *Service {
	return NewService(nil, fakeTx{}, store, &fakeAccess{err: domain.ErrNotFound}, &fakePlans{allowed: true})
}

func strptr(s string) *string { return &s }

// --- Анти-IDOR: доступ к чужой форме неотличим от отсутствующей (404) ---

func TestGet_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	_, err := svc.Get(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound (чужая форма не должна раскрываться)", err)
	}
}

func TestGet_FormMissing_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{getErr: pgx.ErrNoRows}
	svc := newTestService(store)

	_, err := svc.Get(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestGet_Member_Success(t *testing.T) {
	wsID := domain.NewID()
	store := &fakeStore{form: Form{WorkspaceID: wsID, Title: "My form"}}
	svc := newTestService(store)

	form, err := svc.Get(context.Background(), domain.NewID(), domain.NewID())
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if form.Title != "My form" {
		t.Fatalf("title = %q, ожидалось \"My form\"", form.Title)
	}
}

func TestGetBySlug_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	_, err := svc.GetBySlug(context.Background(), domain.NewID(), "abc123")
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound (чужая форма не должна раскрываться по slug)", err)
	}
}

func TestGetBySlug_FormMissing_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{getErr: pgx.ErrNoRows}
	svc := newTestService(store)

	_, err := svc.GetBySlug(context.Background(), domain.NewID(), "nope")
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestGetBySlug_Member_Success(t *testing.T) {
	wsID := domain.NewID()
	store := &fakeStore{form: Form{WorkspaceID: wsID, Title: "My form"}}
	svc := newTestService(store)

	form, err := svc.GetBySlug(context.Background(), domain.NewID(), "abc123")
	if err != nil {
		t.Fatalf("GetBySlug: %v", err)
	}
	if form.Title != "My form" {
		t.Fatalf("title = %q, ожидалось \"My form\"", form.Title)
	}
	if form.Slug != "abc123" {
		t.Fatalf("slug = %q, ожидалось \"abc123\"", form.Slug)
	}
}

// --- Настройки закрытия формы (фаза 8.5 шаг 4) ---

func TestUpdateCloseSettings_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	_, err := svc.UpdateCloseSettings(context.Background(), domain.NewID(), domain.NewID(), domain.CloseSettings{})
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound (чужая форма не раскрывается)", err)
	}
	if store.updated {
		t.Fatal("чужая форма не должна обновляться")
	}
}

func TestUpdateCloseSettings_InvalidLimit_ReturnsValidationBeforeStore(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newTestService(store)

	bad := int32(0)
	_, err := svc.UpdateCloseSettings(context.Background(), domain.NewID(), domain.NewID(),
		domain.CloseSettings{ResponseLimit: &bad})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, want ErrValidation (лимит 0)", err)
	}
	if store.updated {
		t.Fatal("невалидные настройки не должны доходить до записи")
	}
}

func TestUpdateCloseSettings_Member_PassesSettingsThrough(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newTestService(store)

	limit := int32(100)
	if _, err := svc.UpdateCloseSettings(context.Background(), domain.NewID(), domain.NewID(),
		domain.CloseSettings{ResponseLimit: &limit, ClosedMessage: "Мест больше нет"}); err != nil {
		t.Fatalf("UpdateCloseSettings: %v", err)
	}
	if !store.updated {
		t.Fatal("настройки должны были записаться")
	}
	if store.lastCloseSettings.ResponseLimit == nil || *store.lastCloseSettings.ResponseLimit != 100 {
		t.Fatalf("лимит не долетел до стора: %+v", store.lastCloseSettings)
	}
	if store.lastCloseSettings.ClosedMessage != "Мест больше нет" {
		t.Fatalf("текст не долетел до стора: %q", store.lastCloseSettings.ClosedMessage)
	}
}

func TestDelete_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	err := svc.Delete(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if store.deleted {
		t.Fatal("чужая форма не должна удаляться")
	}
}

// --- Дубликация формы ---

func TestDuplicate_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	_, err := svc.Duplicate(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound (чужая форма не должна дублироваться)", err)
	}
	if store.created {
		t.Fatal("чужая форма не должна дублироваться")
	}
}

func TestDuplicate_CleanTitle_SuffixInName(t *testing.T) {
	wsID := domain.NewID()
	schema := json.RawMessage(`{"schemaVersion":1,"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text"}]}`)
	store := &fakeStore{
		// У оригинала имя не задано (name=nil) — база берётся из title.
		form: Form{WorkspaceID: wsID, Title: "Анкета", Slug: "old-slug", Status: "published", DraftSchema: schema},
	}
	svc := newTestService(store)

	dup, err := svc.Duplicate(context.Background(), domain.NewID(), domain.NewID())
	if err != nil {
		t.Fatalf("Duplicate: %v", err)
	}
	// Публичный заголовок копируется ДОСЛОВНО — суффикса в нём нет.
	if dup.Title != "Анкета" {
		t.Fatalf("title = %q, ожидался чистый \"Анкета\"", dup.Title)
	}
	// Суффикс «(копия)» уходит во ВНУТРЕННЕЕ имя.
	if dup.Name == nil || *dup.Name != "Анкета (копия)" {
		t.Fatalf("name = %v, ожидалось \"Анкета (копия)\"", dup.Name)
	}
	if dup.WorkspaceID != wsID {
		t.Fatalf("копия попала в чужой воркспейс: %v != %v", dup.WorkspaceID, wsID)
	}
	if dup.Status != "draft" {
		t.Fatalf("status = %q, копия должна начинаться черновиком", dup.Status)
	}
	if string(store.lastCreateSchema) != string(schema) {
		t.Fatalf("схема не скопирована: %q", store.lastCreateSchema)
	}
	if store.lastCreateSlug == "old-slug" || store.lastCreateSlug == "" {
		t.Fatalf("slug должен быть новым, а не %q", store.lastCreateSlug)
	}
}

func TestDuplicate_NumbersBySiblings(t *testing.T) {
	wsID := domain.NewID()
	name := "Анкета (копия)"
	store := &fakeStore{
		form: Form{WorkspaceID: wsID, Name: &name, Title: "Анкета", DraftSchema: json.RawMessage(`{"blocks":[]}`)},
		// В воркспейсе уже есть оригинал и первая копия → следующая должна стать «(копия 2)».
		formNames: []FormName{{Title: "Анкета"}, {Name: strptr("Анкета (копия)"), Title: "Анкета"}},
	}
	svc := newTestService(store)

	dup, err := svc.Duplicate(context.Background(), domain.NewID(), domain.NewID())
	if err != nil {
		t.Fatalf("Duplicate: %v", err)
	}
	// База — «Анкета» (хвост «(копия)» у источника отрезан, не стекается).
	if dup.Name == nil || *dup.Name != "Анкета (копия 2)" {
		t.Fatalf("name = %v, ожидалось \"Анкета (копия 2)\"", dup.Name)
	}
	if dup.Title != "Анкета" {
		t.Fatalf("title = %q, ожидался чистый \"Анкета\"", dup.Title)
	}
}

func TestNextCopyName(t *testing.T) {
	cases := []struct {
		name     string
		src      string
		siblings []FormName
		want     string
	}{
		{"первая копия", "Анкета", nil, "Анкета (копия)"},
		{"копия копии не стекает", "Анкета (копия)", nil, "Анкета (копия)"},
		{
			"нумерация по соседям",
			"Анкета",
			[]FormName{{Title: "Анкета"}, {Name: strptr("Анкета (копия)"), Title: "x"}},
			"Анкета (копия 2)",
		},
		{
			"дыра в нумерации — берём max+1",
			"Анкета",
			[]FormName{{Name: strptr("Анкета (копия 5)"), Title: "x"}},
			"Анкета (копия 6)",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nextCopyName(tc.src, tc.siblings); got != tc.want {
				t.Fatalf("nextCopyName(%q) = %q, want %q", tc.src, got, tc.want)
			}
		})
	}
}

func TestCopyName_TruncatesToFitLimit(t *testing.T) {
	// База впритык к лимиту: суффикс обязан сохраниться, итог — влезть в maxTitleLen.
	// Лимит считается в РУНАХ (фаза 15): до неё он был в байтах, и кириллическое имя
	// обрезалось вдвое раньше латинского — ровно этот кейс на кириллице и краснел бы,
	// проверяй он байты.
	base := strings.Repeat("я", maxTitleLen)
	got := copyName(base, 1)
	if n := utf8.RuneCountInString(got); n > maxTitleLen {
		t.Fatalf("итог %d рун > лимита %d", n, maxTitleLen)
	}
	if !strings.HasSuffix(got, " (копия)") {
		t.Fatalf("суффикс потерян: %q", got)
	}
}

// --- Внутреннее имя (переименование на дашборде) ---

func TestUpdateName_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	_, err := svc.UpdateName(context.Background(), domain.NewID(), domain.NewID(), "новое имя")
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if store.updated {
		t.Fatal("чужую форму не должно переименовывать")
	}
}

func TestUpdateName_Empty_ResetsToNil(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newTestService(store)

	form, err := svc.UpdateName(context.Background(), domain.NewID(), domain.NewID(), "   ")
	if err != nil {
		t.Fatalf("UpdateName: %v", err)
	}
	// Пустое имя → NULL (кабинет вернётся к показу публичного заголовка).
	if form.Name != nil {
		t.Fatalf("name = %v, ожидался nil при пустом вводе", form.Name)
	}
}

// --- Публикация ---

func TestPublish_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	_, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound (чужая форма не раскрывается)", err)
	}
	if store.versionInserted || store.published {
		t.Fatal("чужая форма не должна публиковаться")
	}
}

func TestPublish_InvalidDraft_Rejected(t *testing.T) {
	// Черновик с неизвестным типом блока — ValidateSchema отвергает до снапшота.
	bad := json.RawMessage(`{"blocks":[{"id":"b","groupId":"g_b","type":"slider"}]}`)
	store := &fakeStore{form: Form{DraftSchema: bad}}
	svc := newTestService(store)

	_, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, want ErrValidation", err)
	}
	if store.versionInserted {
		t.Fatal("невалидный черновик не должен снапшотиться")
	}
}

func TestPublish_Success_SnapshotsAndSetsVersion(t *testing.T) {
	draft := json.RawMessage(`{"blocks":[]}`)
	store := &fakeStore{
		form:        Form{WorkspaceID: domain.NewID(), DraftSchema: draft},
		nextVersion: 1,
	}
	svc := newTestService(store)

	form, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID())
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if !store.versionInserted || !store.published {
		t.Fatal("публикация должна вставить версию и перевести форму в published")
	}
	if store.lastVersion != 1 {
		t.Fatalf("вставлена версия %d, ожидалась 1", store.lastVersion)
	}
	if form.Status != "published" {
		t.Fatalf("status = %q, ожидался published", form.Status)
	}
	if form.PublishedVersion == nil || *form.PublishedVersion != 1 {
		t.Fatalf("publishedVersion = %v, ожидалась 1", form.PublishedVersion)
	}
}

// --- Гейт своего оформления (фаза 22, слайс 6) ---
//
// Гейт стоит на ПУБЛИКАЦИИ, а не на сохранении: автосейв не имеет права вернуть 402
// посреди набора. Из этого три проверяемых утверждения — платное без тарифа не
// публикуется, тема без тарифа публикуется, и тариф спрашивается только после
// авторизации.

// designDraft — черновик с заданным оформлением.
func designDraft(design string) json.RawMessage {
	return json.RawMessage(`{"schemaVersion":1,"blocks":[],"design":` + design + `}`)
}

// ПЕРВАЯ ПОЛОВИНА УТВЕРЖДЕНИЯ «сохраняется 200, публикуется 402» — и та, которую
// забыть легче: вторая половина краснеет сама, если гейт сломался, а эта краснеет
// только если гейт переехал НЕ ТУДА. Переезд на сохранение выглядел бы как 402
// посреди набора текста, и тест здесь именно затем, чтобы такой переезд не прошёл
// молча. Тариф на этом пути не спрашивается вовсе — не «спрашивается и разрешает».
func TestUpdateDraftSchema_PaidDesign_SavesAndDoesNotAskPlans(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	in := designDraft(`{"palette":{"accent":"#12ab34"},"font":"inter","css":".rf-page{padding:0}"}`)
	if _, err := svc.UpdateDraftSchema(context.Background(), domain.NewID(), domain.NewID(), in, time.Now()); err != nil {
		t.Fatalf("автосейв обязан проходить на любом тарифе: %v", err)
	}
	if !store.schemaSaved {
		t.Fatal("черновик с платным оформлением должен сохраниться")
	}
	var saved domain.FormSchema
	if err := json.Unmarshal(store.lastSchema, &saved); err != nil {
		t.Fatalf("сохранённая схема не парсится: %v", err)
	}
	// Не просто «прошло», а «доехало»: канонизация не имеет права вычистить платные
	// поля по дороге — иначе автосейв тихо стирал бы работу автора.
	if saved.Design == nil || saved.Design.Font != "inter" || saved.Design.CSS == "" {
		t.Fatalf("оформление не доехало до БД: %+v", saved.Design)
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен на сохранении черновика: %v", plans.gotKeys)
	}
}

func TestPublish_PaidDesignWithoutPlan_Returns402(t *testing.T) {
	store := &fakeStore{
		form:        Form{WorkspaceID: domain.NewID(), DraftSchema: designDraft(`{"palette":{"accent":"#12ab34"},"font":"inter"}`)},
		nextVersion: 1,
	}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	_, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("err = %v, want ErrPlanRequired", err)
	}
	// В теле — что именно мешает: «своё оформление недоступно» без перечня
	// заставляет автора гадать, что снять.
	if !strings.Contains(err.Error(), "цвета") || !strings.Contains(err.Error(), "шрифт") {
		t.Fatalf("в отказе нет списка мешающего: %v", err)
	}
	if store.versionInserted || store.published {
		t.Fatal("отказ по тарифу не должен снапшотить версию")
	}
	if len(plans.gotKeys) != 1 || plans.gotKeys[0] != entitlements.FormDesignCustom {
		t.Fatalf("спрошены ключи %v, ожидался только form_design_custom", plans.gotKeys)
	}
}

func TestPublish_ThemeOnly_PublishesOnAnyPlan(t *testing.T) {
	// Обе темы бесплатны намеренно (спека §9.1): гейт ставится на созданную
	// ценность, а не на настройку. Тариф при этом не спрашивается вовсе — платить
	// нечем, и лишняя поездка в БД не нужна.
	store := &fakeStore{
		form:        Form{WorkspaceID: domain.NewID(), DraftSchema: designDraft(`{"theme":"dark"}`)},
		nextVersion: 1,
	}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	if _, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID()); err != nil {
		t.Fatalf("тёмная тема обязана публиковаться на любом тарифе: %v", err)
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен без единой платной настройки: %v", plans.gotKeys)
	}
}

// Бейдж публикацию не трогает вовсе: намерение живёт колонкой формы (ADR §10), в
// документе его нет, и спрашивать тариф на публикации не из-за чего.
func TestUpdateBranding_NeedsNoPlan(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	form, err := svc.UpdateBranding(context.Background(), uuid.New(), store.form.ID, false)
	if err != nil {
		t.Fatalf("снять бейдж вправе любой тариф — право спрашивается при отдаче: %v", err)
	}
	if form.Branding {
		t.Fatal("намерение не доехало до колонки")
	}
	if store.lastBranding {
		t.Fatal("в стор ушло не то значение")
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен на смене тумблера: %v", plans.gotKeys)
	}
}

// Шкала прогресса тарифа не знает вовсе: гейта у неё нет ни в кабинете, ни при
// отдаче формы. Тест сторожит именно это — что настройка не обросла правом «заодно»
// с соседями по странице, у которых оно есть.
func TestUpdateProgress_NeedsNoPlan(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	form, err := svc.UpdateProgress(context.Background(), uuid.New(), store.form.ID, false)
	if err != nil {
		t.Fatalf("снять шкалу вправе любой тариф: %v", err)
	}
	if form.Progress {
		t.Fatal("намерение не доехало до колонки")
	}
	if store.lastProgress {
		t.Fatal("в стор ушло не то значение")
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен на смене тумблера: %v", plans.gotKeys)
	}
}

// Повторное открытие НЕ публикует новой версии: номер версии значит «что видели
// респонденты», и накручивать его тумблером нельзя. Черновик и уже открытую форму
// открывать нечем — 422, а не молчаливый успех.
func TestReopen_OnlyClosedForm(t *testing.T) {
	closed := &fakeStore{form: Form{
		WorkspaceID:        domain.NewID(),
		Status:             domain.FormStatusClosed,
		PublishedVersionID: &[]uuid.UUID{uuid.New()}[0],
	}}
	svc := NewService(nil, fakeTx{}, closed, &fakeAccess{}, &fakePlans{allowed: true})
	form, err := svc.Reopen(context.Background(), uuid.New(), closed.form.ID)
	if err != nil {
		t.Fatalf("открыть закрытую форму: %v", err)
	}
	if form.Status != domain.FormStatusPublished {
		t.Fatalf("статус = %q, ожидался published", form.Status)
	}

	draft := &fakeStore{form: Form{WorkspaceID: domain.NewID(), Status: domain.FormStatusDraft}}
	svc = NewService(nil, fakeTx{}, draft, &fakeAccess{}, &fakePlans{allowed: true})
	if _, err := svc.Reopen(context.Background(), uuid.New(), draft.form.ID); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("черновик: err = %v, want ErrValidation", err)
	}
	if draft.updated {
		t.Fatal("черновик открыт тумблером — публикация обязана оставаться отдельным действием")
	}
}

// Свой текст письма — платная настройка (0042): её сохранение спрашивает тариф, в
// отличие от карточки ссылки, где право стоит только на отдаче. Контрол держит сам
// кабинет, и правка, которую интерфейс не даёт сделать, обязана быть отвергнута и
// на бэке — иначе 402 не увидит никто, кроме чужого клиента.
func TestUpdateNotifyEmail_NeedsPlan(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	_, err := svc.UpdateNotifyEmail(context.Background(), uuid.New(), store.form.ID,
		&domain.NotifyEmail{Subject: domain.TextFromString("Новая заявка")})
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("err = %v, want ErrPlanRequired", err)
	}
	if store.updated {
		t.Fatal("настройка ушла в стор мимо гейта")
	}
}

// СНЯТИЕ настройки тариф не спрашивает: вернуться к дефолтному письму вправе любой
// план — иначе даунгрейд запирал бы автора в настройке, которую он уже не может
// менять.
func TestUpdateNotifyEmail_ResetNeedsNoPlan(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	if _, err := svc.UpdateNotifyEmail(context.Background(), uuid.New(), store.form.ID,
		&domain.NotifyEmail{}); err != nil {
		t.Fatalf("сброс настройки: %v", err)
	}
	if !store.updated {
		t.Fatal("сброс не доехал до стора")
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен на сбросе: %v", plans.gotKeys)
	}
}

// Даунгрейд возвращает дефолтное письмо, ничего не стирая: сохранённая настройка
// остаётся в колонке и оживает после апгрейда — тот же приём, что у бейджа.
func TestNotifyEmailFor_GateAtSend(t *testing.T) {
	saved := &domain.NotifyEmail{Subject: domain.TextFromString("Новая заявка")}
	ws := domain.NewID()

	svc := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, &fakePlans{allowed: false})
	got, err := svc.NotifyEmailFor(context.Background(), ws, saved)
	if err != nil {
		t.Fatalf("NotifyEmailFor: %v", err)
	}
	if got != nil {
		t.Fatal("на закрытом тарифе письмо обязано уйти дефолтным шаблоном")
	}

	svc = NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, &fakePlans{allowed: true})
	got, err = svc.NotifyEmailFor(context.Background(), ws, saved)
	if err != nil {
		t.Fatalf("NotifyEmailFor: %v", err)
	}
	if got == nil || domain.PlainText(got.Subject) != "Новая заявка" {
		t.Fatalf("на платном тарифе обязана вернуться настройка автора: %+v", got)
	}
}

// Письмо респонденту гейтится ЦЕЛИКОМ, а не своим текстом: включение тумблера уже
// требует платного тарифа, потому что платной здесь является сама отправка на адрес,
// который ввёл кто угодно (docs/design/respondent-email.md §6).
func TestUpdateNotifyRespondent_NeedsPlan(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	_, err := svc.UpdateNotifyRespondent(context.Background(), uuid.New(), store.form.ID, true)
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("err = %v, want ErrPlanRequired", err)
	}
	if store.updated {
		t.Fatal("тумблер ушёл в стор мимо гейта")
	}
}

// ВЫКЛЮЧЕНИЕ тариф не спрашивает: даунгрейд не имеет права запирать автора в
// рассылке, которую он уже не может остановить.
func TestUpdateNotifyRespondent_OffNeedsNoPlan(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	if _, err := svc.UpdateNotifyRespondent(context.Background(), uuid.New(), store.form.ID, false); err != nil {
		t.Fatalf("выключение тумблера: %v", err)
	}
	if !store.updated {
		t.Fatal("выключение не доехало до стора")
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен на выключении: %v", plans.gotKeys)
	}
}

// Бланк письма респонденту — тот же порядок, что у письма владельцу: настройка за
// тарифом, сброс бесплатен.
func TestUpdateRespondentEmail_GateAndReset(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	_, err := svc.UpdateRespondentEmail(context.Background(), uuid.New(), store.form.ID,
		&domain.RespondentEmail{SourceBlockID: "b1"})
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("err = %v, want ErrPlanRequired", err)
	}
	if store.updated {
		t.Fatal("бланк ушёл в стор мимо гейта")
	}

	if _, err := svc.UpdateRespondentEmail(context.Background(), uuid.New(), store.form.ID,
		&domain.RespondentEmail{}); err != nil {
		t.Fatalf("сброс бланка: %v", err)
	}
	if !store.updated {
		t.Fatal("сброс не доехал до стора")
	}
}

// Негодный бланк отвергается ДО тарифа и до стора: 422 про формат не имеет права
// превращаться в 402 про деньги.
func TestUpdateRespondentEmail_ValidationBeforeGate(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	_, err := svc.UpdateRespondentEmail(context.Background(), uuid.New(), store.form.ID,
		&domain.RespondentEmail{SourceBlockID: "b1", ReplyTo: "не адрес"})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, want ErrValidation", err)
	}
	if store.updated {
		t.Fatal("негодный бланк доехал до стора")
	}
}

// ПОРЯДОК ПРОВЕРОК: чужая форма — 404, и тариф не спрашивается вовсе. Иначе код
// ответа рассказывал бы постороннему о существовании формы и о плане чужого
// воркспейса (BILLING.md §8).
func TestPublish_ForeignForm_404BeforePlanGate(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID(), DraftSchema: designDraft(`{"palette":{"accent":"#12ab34"}}`)}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{err: domain.ErrNotFound}, plans)

	_, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен до авторизации: %v", plans.gotKeys)
	}
}

func TestUnpublish_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	_, err := svc.Unpublish(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if store.closed {
		t.Fatal("чужая форма не должна закрываться")
	}
}

func TestUnpublish_Success_CarriesVersion(t *testing.T) {
	v := int32(2)
	store := &fakeStore{
		form: Form{WorkspaceID: domain.NewID(), Status: "published", PublishedVersion: &v},
	}
	svc := newTestService(store)

	form, err := svc.Unpublish(context.Background(), domain.NewID(), domain.NewID())
	if err != nil {
		t.Fatalf("Unpublish: %v", err)
	}
	if form.Status != "closed" {
		t.Fatalf("status = %q, ожидался closed", form.Status)
	}
	// Номер последней опубликованной версии сохраняется («была версия N»).
	if form.PublishedVersion == nil || *form.PublishedVersion != 2 {
		t.Fatalf("publishedVersion = %v, ожидалась 2", form.PublishedVersion)
	}
}

// --- Валидация ---

// --- Автосейв схемы: валидация, доступ, оптимистичная блокировка ---

func TestUpdateDraftSchema_InvalidSchema_Rejected(t *testing.T) {
	store := &fakeStore{form: Form{}}
	svc := newTestService(store)

	// Неизвестный тип блока — ValidateSchema отвергает до всякого доступа к БД.
	bad := json.RawMessage(`{"blocks":[{"id":"b","groupId":"g_b","type":"slider"}]}`)
	_, err := svc.UpdateDraftSchema(context.Background(), domain.NewID(), domain.NewID(), bad, time.Now())
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, want ErrValidation", err)
	}
	if store.schemaSaved {
		t.Fatal("невалидная схема не должна доходить до БД")
	}
}

func TestUpdateDraftSchema_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newDeniedService(store)

	ok := json.RawMessage(`{"blocks":[]}`)
	_, err := svc.UpdateDraftSchema(context.Background(), domain.NewID(), domain.NewID(), ok, time.Now())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound (чужая форма не раскрывается)", err)
	}
	if store.schemaSaved {
		t.Fatal("чужая форма не должна обновляться")
	}
}

func TestUpdateDraftSchema_StaleUpdatedAt_ReturnsConflict(t *testing.T) {
	// Доступ есть, но условный UPDATE не нашёл строки (updated_at сдвинут) → ErrNoRows.
	store := &fakeStore{form: Form{}, schemaErr: pgx.ErrNoRows}
	svc := newTestService(store)

	ok := json.RawMessage(`{"blocks":[]}`)
	_, err := svc.UpdateDraftSchema(context.Background(), domain.NewID(), domain.NewID(), ok, time.Now())
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}

func TestUpdateDraftSchema_Valid_CanonicalizesAndPassesExpected(t *testing.T) {
	store := &fakeStore{form: Form{}}
	svc := newTestService(store)

	expected := time.Now().Truncate(time.Microsecond)
	// Без schemaVersion — канонизация должна её проставить (=1).
	in := json.RawMessage(`{"blocks":[{"id":"t_b","groupId":"g_b","type":"title","text":[{"t":"Имя"}]},{"id":"b","groupId":"g_b","type":"short_text"}]}`)
	if _, err := svc.UpdateDraftSchema(context.Background(), domain.NewID(), domain.NewID(), in, expected); err != nil {
		t.Fatalf("UpdateDraftSchema: %v", err)
	}
	if !store.schemaSaved {
		t.Fatal("валидная схема должна сохраниться")
	}
	if !store.lastExpected.Equal(expected) {
		t.Fatalf("expectedUpdatedAt = %v, ожидалось %v", store.lastExpected, expected)
	}
	var saved domain.FormSchema
	if err := json.Unmarshal(store.lastSchema, &saved); err != nil {
		t.Fatalf("сохранённая схема не парсится: %v", err)
	}
	if saved.SchemaVersion != domain.SchemaVersion {
		t.Fatalf("schemaVersion не канонизирован: %d", saved.SchemaVersion)
	}
}

// --- Create ---

func TestCreate_UsesPersonalWorkspaceAndDefaultsTitle(t *testing.T) {
	wsID := domain.NewID()
	store := &fakeStore{personalWS: wsID}
	svc := newTestService(store)

	form, err := svc.Create(context.Background(), domain.NewID(), "  ", nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if store.lastCreateWS != wsID {
		t.Fatalf("форма создана в воркспейсе %v, ожидался личный %v", store.lastCreateWS, wsID)
	}
	if form.Title != defaultFormTitle {
		t.Fatalf("title = %q, ожидался дефолт %q", form.Title, defaultFormTitle)
	}
	if len(store.lastCreateSlug) != domain.SlugLen {
		t.Fatalf("slug %q неверной длины", store.lastCreateSlug)
	}
}

// Явно названное пространство используется вместо личного — но только после
// проверки членства: id из запроса правом доступа не является.
func TestCreate_ExplicitWorkspaceRequiresMembership(t *testing.T) {
	personal, explicit := domain.NewID(), domain.NewID()

	store := &fakeStore{personalWS: personal}
	svc := newTestService(store)
	if _, err := svc.Create(context.Background(), domain.NewID(), "Форма", &explicit); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if store.lastCreateWS != explicit {
		t.Fatalf("форма создана в %v, ожидалось названное пространство %v", store.lastCreateWS, explicit)
	}

	// Не член — 404 (не 403): существование чужого пространства не раскрываем.
	denied := &fakeStore{personalWS: personal}
	svcDenied := newDeniedService(denied)
	_, err := svcDenied.Create(context.Background(), domain.NewID(), "Форма", &explicit)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, ожидался domain.ErrNotFound", err)
	}
	if denied.created {
		t.Error("форма создана в пространстве, членом которого пользователь не является")
	}
}

// Список без параметра идёт в личное пространство — так работают ссылки,
// не знающие про workspaceId.
func TestList_DefaultsToPersonalWorkspace(t *testing.T) {
	personal := domain.NewID()
	store := &fakeStore{personalWS: personal}
	svc := newTestService(store)

	if _, err := svc.List(context.Background(), domain.NewID(), ListOptions{Limit: 10}); err != nil {
		t.Fatalf("List: %v", err)
	}
	if store.lastListWS != personal {
		t.Fatalf("список прочитан из %v, ожидалось личное %v", store.lastListWS, personal)
	}
}

// --- Пагинация: limit+1 строк превращаются в NextCursor ---

func TestList_HasNextPage_SetsCursor(t *testing.T) {
	// Запрошен limit=2, репозиторий вернул 3 (limit+1) → есть следующая страница.
	base := time.Now()
	rows := []ListRow{
		{Form: Form{ID: domain.NewID(), UpdatedAt: base}, SortKey: base.UnixNano()},
		{Form: Form{ID: domain.NewID(), UpdatedAt: base.Add(-time.Minute)}, SortKey: base.Add(-time.Minute).UnixNano()},
		{Form: Form{ID: domain.NewID(), UpdatedAt: base.Add(-2 * time.Minute)}, SortKey: base.Add(-2 * time.Minute).UnixNano()},
	}
	store := &fakeStore{personalWS: domain.NewID(), listRows: rows}
	svc := newTestService(store)

	page, err := svc.List(context.Background(), domain.NewID(), ListOptions{Limit: 2})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if store.lastListLimit != 3 {
		t.Fatalf("репозиторий запрошен с limit=%d, ожидалось limit+1=3", store.lastListLimit)
	}
	if len(page.Forms) != 2 {
		t.Fatalf("в страницу попало %d форм, ожидалось 2", len(page.Forms))
	}
	if page.NextCursor == nil {
		t.Fatal("NextCursor не выставлен, хотя есть следующая страница")
	}
	if page.NextCursor.ID != rows[1].ID {
		t.Fatalf("курсор указывает на %v, ожидалась последняя показанная форма %v", page.NextCursor.ID, rows[1].ID)
	}
	// Ключ курсора — тот, что выдала БД, а не пересчитанный сервисом.
	if page.NextCursor.SortKey != rows[1].SortKey {
		t.Fatalf("ключ курсора %d, ожидался ключ строки %d", page.NextCursor.SortKey, rows[1].SortKey)
	}
	// Порядок запечатан в курсоре: следующая страница обязана прийти в том же.
	if page.NextCursor.Sort != SortUpdated {
		t.Fatalf("в курсоре сортировка %q, ожидалась %q", page.NextCursor.Sort, SortUpdated)
	}
}

func TestList_LastPage_NoCursor(t *testing.T) {
	rows := []ListRow{{Form: Form{ID: domain.NewID(), UpdatedAt: time.Now()}}}
	store := &fakeStore{personalWS: domain.NewID(), listRows: rows}
	svc := newTestService(store)

	page, err := svc.List(context.Background(), domain.NewID(), ListOptions{Limit: 50})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if page.NextCursor != nil {
		t.Fatal("на последней странице курсора быть не должно")
	}
	if len(page.Forms) != 1 {
		t.Fatalf("форм = %d, ожидалась 1", len(page.Forms))
	}
}

func TestList_WithCursor_PassesCursorToStore(t *testing.T) {
	store := &fakeStore{personalWS: domain.NewID(), listRows: nil}
	svc := newTestService(store)

	after := &Cursor{SortKey: time.Now().UnixNano(), ID: domain.NewID(), Sort: SortUpdated}
	_, err := svc.List(context.Background(), domain.NewID(), ListOptions{After: after, Limit: 50})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !store.lastListAfter {
		t.Fatal("курсор не доехал до репозитория")
	}
}

// --- Сортировка и поиск (фаза 8.5 шаг 8) ---

func TestList_SortDefaultsToUpdated(t *testing.T) {
	store := &fakeStore{personalWS: domain.NewID()}
	svc := newTestService(store)

	if _, err := svc.List(context.Background(), domain.NewID(), ListOptions{}); err != nil {
		t.Fatalf("List: %v", err)
	}
	if store.lastListSort != string(SortUpdated) {
		t.Fatalf("сортировка %q, ожидалась %q", store.lastListSort, SortUpdated)
	}
}

// Фильтр по статусу уезжает в репозиторий как есть; пустой — значит «все статусы»,
// и в запрос он не попадает вовсе.
func TestList_StatusFilter_PassedToStore(t *testing.T) {
	for _, tt := range []struct {
		name   string
		status StatusFilter
		want   string
	}{
		{"пусто = все статусы", "", ""},
		{"черновики", StatusFilter(domain.FormStatusDraft), "draft"},
		{"закрытые", StatusFilter(domain.FormStatusClosed), "closed"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{personalWS: domain.NewID()}
			svc := newTestService(store)

			if _, err := svc.List(context.Background(), domain.NewID(), ListOptions{Status: tt.status}); err != nil {
				t.Fatalf("List: %v", err)
			}
			if store.lastListStatus != tt.want {
				t.Fatalf("в репозиторий ушёл статус %q, ожидался %q", store.lastListStatus, tt.want)
			}
		})
	}
}

// Опечатка в статусе — 422, а не молчаливая выдача всех форм: иначе клиент решит,
// что фильтр работает, а он показывает всё подряд.
func TestParseStatusFilter(t *testing.T) {
	for _, tt := range []struct {
		raw     string
		want    StatusFilter
		wantErr bool
	}{
		{raw: "", want: ""},
		{raw: "draft", want: StatusFilter(domain.FormStatusDraft)},
		{raw: "published", want: StatusFilter(domain.FormStatusPublished)},
		{raw: "closed", want: StatusFilter(domain.FormStatusClosed)},
		{raw: "drafts", wantErr: true},
		{raw: "DRAFT", wantErr: true},
		{raw: "' OR 1=1", wantErr: true},
	} {
		t.Run(tt.raw, func(t *testing.T) {
			got, err := ParseStatusFilter(tt.raw)
			if tt.wantErr {
				if !errors.Is(err, domain.ErrValidation) {
					t.Fatalf("ошибка = %v, ожидалась domain.ErrValidation", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseStatusFilter(%q): %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("статус %q, ожидался %q", got, tt.want)
			}
		})
	}
}

// Курсор одного порядка, применённый к другому, — ошибка ввода, а не повод молча
// выдать перемешанную страницу: ключ у порядков измеряет разные величины.
func TestList_CursorFromOtherSort_IsValidationError(t *testing.T) {
	store := &fakeStore{personalWS: domain.NewID()}
	svc := newTestService(store)

	after := &Cursor{SortKey: 42, ID: domain.NewID(), Sort: SortResponses}
	_, err := svc.List(context.Background(), domain.NewID(), ListOptions{Sort: SortCreated, After: after, Limit: 50})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась domain.ErrValidation", err)
	}
}

func TestParseSortOrder(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		want    SortOrder
		wantErr bool
	}{
		{"пусто — умолчание", "", SortUpdated, false},
		{"по правке", "updated", SortUpdated, false},
		{"по созданию", "created", SortCreated, false},
		{"по числу ответов", "responses", SortResponses, false},
		{"опечатка не молчит", "updatd", "", true},
		{"чужое значение", "'; DROP TABLE forms; --", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseSortOrder(tt.raw)
			if tt.wantErr {
				if !errors.Is(err, domain.ErrValidation) {
					t.Fatalf("ошибка = %v, ожидалась domain.ErrValidation", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseSortOrder(%q): %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("ParseSortOrder(%q) = %q, ожидалось %q", tt.raw, got, tt.want)
			}
		})
	}
}

// Длина строки поиска ограничена на бэке: query-строку не стережёт MaxBytesReader
// (он про тело запроса), а инвариант 3 требует валидировать любой ввод.
func TestList_SearchTooLong_IsValidationError(t *testing.T) {
	store := &fakeStore{personalWS: domain.NewID()}
	svc := newTestService(store)

	// Ровно на границе — проходит; на символ длиннее — 422.
	atLimit := strings.Repeat("я", MaxSearchLen)
	if _, err := svc.List(context.Background(), domain.NewID(), ListOptions{Search: atLimit}); err != nil {
		t.Fatalf("поиск длиной ровно %d символов должен проходить: %v", MaxSearchLen, err)
	}

	tooLong := strings.Repeat("я", MaxSearchLen+1)
	_, err := svc.List(context.Background(), domain.NewID(), ListOptions{Search: tooLong})
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидалась domain.ErrValidation", err)
	}
}

// Спецсимволы LIKE в пользовательском запросе обезвреживаются: иначе «50%» ищет
// что угодно, а «_» подходит любому символу.
func TestList_SearchEscapesLikeWildcards(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"обычный текст не трогается", "доставка", "доставка"},
		{"процент экранируется", "скидка 50%", `скидка 50\%`},
		{"подчёркивание экранируется", "форма_1", `форма\_1`},
		{"слэш удваивается один раз", `a\b`, `a\\b`},
		{"пробелы по краям срезаются", "  анкета  ", "анкета"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{personalWS: domain.NewID()}
			svc := newTestService(store)

			if _, err := svc.List(context.Background(), domain.NewID(), ListOptions{Search: tt.in}); err != nil {
				t.Fatalf("List: %v", err)
			}
			if store.lastListSearch != tt.want {
				t.Fatalf("в репозиторий ушёл поиск %q, ожидался %q", store.lastListSearch, tt.want)
			}
		})
	}
}

// --- Заголовок формы: зеркало в колонку и публичный резолв (фаза 15) ---

// Колонка forms.title — ПРОИЗВОДНАЯ от документа. Три случая, и все три разные:
// документ не высказался (схема снята до фазы) — колонку не трогаем; высказался
// текстом — пишем его; высказался пустотой — пишем служебное имя, потому что
// колонка NOT NULL и дашборду нужно чем-то назвать строку списка.
func TestUpdateDraftSchema_MirrorsTitleFromDocument(t *testing.T) {
	cases := map[string]struct {
		schema string
		want   *string
	}{
		"документ не высказался — колонка не трогается": {
			schema: `{"schemaVersion":1,"blocks":[{"id":"b","groupId":"g","type":"short_text","settings":{}}]}`,
			want:   nil,
		},
		"заголовок с текстом — едет в колонку": {
			schema: `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета ","m":["b"]},{"t":"2026"}]}]}`,
			want:   strptr("Анкета 2026"),
		},
		"заголовок стёрт — колонка получает служебное имя": {
			schema: `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[]}]}`,
			want:   strptr(defaultFormTitle),
		},
		"пробелы вокруг заголовка обрезаются": {
			schema: `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"  Анкета  "}]}]}`,
			want:   strptr("Анкета"),
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{form: Form{}}
			svc := newTestService(store)
			if _, err := svc.UpdateDraftSchema(context.Background(), domain.NewID(), domain.NewID(), json.RawMessage(tc.schema), time.Now()); err != nil {
				t.Fatalf("UpdateDraftSchema: %v", err)
			}
			got := store.lastMirrorTitle
			switch {
			case tc.want == nil && got != nil:
				t.Fatalf("колонку тронули значением %q, а документ о заголовке не говорил", *got)
			case tc.want != nil && got == nil:
				t.Fatalf("зеркало не записано, ждали %q", *tc.want)
			case tc.want != nil && *got != *tc.want:
				t.Fatalf("зеркало = %q, ждали %q", *got, *tc.want)
			}
		})
	}
}

// Публичная форма берёт заголовок из ОПУБЛИКОВАННОЙ версии, а не из живой колонки
// (решение владельца: заголовок публикуется вместе со схемой). Колонка остаётся
// фолбэком для версий, снятых до фазы, и НЕ спасает пустой заголовок — иначе
// служебное «Untitled form» снова утекло бы респонденту.
func TestPublicForm_TitleFromPublishedSchema(t *testing.T) {
	cases := map[string]struct {
		column string
		schema string
		want   string
	}{
		"версия до фазы (блока нет) — фолбэк на колонку": {
			column: "Старое название",
			schema: `{"schemaVersion":1,"blocks":[{"id":"b","groupId":"g","type":"short_text","settings":{}}]}`,
			want:   "Старое название",
		},
		"версия с заголовком — колонка игнорируется": {
			column: "Живое имя из колонки",
			schema: `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Опубликованный заголовок"}]}]}`,
			want:   "Опубликованный заголовок",
		},
		"автор стёр заголовок — пусто, а не служебное имя": {
			column: defaultFormTitle,
			schema: `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[]}]}`,
			want:   "",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{publicForm: PublicForm{Title: tc.column, Schema: json.RawMessage(tc.schema)}}
			svc := newTestService(store)
			pf, err := svc.PublicForm(context.Background(), "slug")
			if err != nil {
				t.Fatalf("PublicForm: %v", err)
			}
			if pf.Title != tc.want {
				t.Fatalf("Title = %q, ждали %q", pf.Title, tc.want)
			}
		})
	}
}

// Связка «операция → ДЕЙСТВИЕ» — то, ради чего заведена матрица прав, и до
// ревью фазы 18 её не сторожило ничто: юниты подменяли Can заглушкой, а
// интеграционные не различали ролей, потому что права на формы у них
// совпадают. Подмени действие в любой строке ниже — покраснеет здесь.
func TestOperations_AskTheRightAction(t *testing.T) {
	tests := []struct {
		name string
		call func(*Service) error
		want domain.Action
	}{
		{"Get", func(s *Service) error {
			_, err := s.Get(context.Background(), domain.NewID(), domain.NewID())
			return err
		}, domain.ActionFormRead},
		{"Delete", func(s *Service) error {
			return s.Delete(context.Background(), domain.NewID(), domain.NewID())
		}, domain.ActionFormDelete},
		{"UpdateName", func(s *Service) error {
			_, err := s.UpdateName(context.Background(), domain.NewID(), domain.NewID(), "имя")
			return err
		}, domain.ActionFormWrite},
		{"Publish", func(s *Service) error {
			_, err := s.Publish(context.Background(), domain.NewID(), domain.NewID())
			return err
		}, domain.ActionFormWrite},
		{"Versions", func(s *Service) error {
			_, err := s.Versions(context.Background(), domain.NewID(), domain.NewID())
			return err
		}, domain.ActionFormRead},
		{"GetForAction — что просили, то и спросили", func(s *Service) error {
			_, err := s.GetForAction(context.Background(), domain.NewID(), domain.NewID(),
				domain.ActionSubmissionDelete)
			return err
		}, domain.ActionSubmissionDelete},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			access := &fakeAccess{}
			svc := NewService(nil, fakeTx{}, &fakeStore{form: Form{WorkspaceID: domain.NewID()}}, access, &fakePlans{allowed: true})
			_ = tc.call(svc)
			if len(access.gotActions) == 0 {
				t.Fatalf("%s не спросил права вовсе", tc.name)
			}
			if access.gotActions[0] != tc.want {
				t.Fatalf("%s спросил %q, ждали %q", tc.name, access.gotActions[0], tc.want)
			}
		})
	}
}

// --- Бейдж: цена гейта на публичном пути (спека §9.4) ---
//
// Замер 2026-08-10 на сидированной базе: сам опрос тарифа — 198 мкс на запрос
// против 56 мкс у «SELECT 1» (то есть ~140 мкс сверху), план — четыре index scan
// в nested loop, execution 0.088 мс, ни одного seq scan. Это терпимо; но главный
// рычаг не в скорости запроса, а в том, что для большинства форм его НЕТ ВОВСЕ —
// что и сторожит тест ниже. Сломается он молча: лишняя поездка в БД на каждой
// публичной форме не роняет ничего, её видно только в графиках.
func TestShowBadge_NoIntent_DoesNotAskPlans(t *testing.T) {
	plans := &fakePlans{allowed: true}
	svc := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, plans)

	show, err := svc.ShowBadge(context.Background(), domain.NewID(), true)
	if err != nil {
		t.Fatalf("ShowBadge: %v", err)
	}
	if !show {
		t.Fatal("автор бейдж не снимал — он обязан стоять")
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен там, где спрашивать нечего: %v", plans.gotKeys)
	}
}

func TestShowBadge_IntentAsksPlanAndObeysIt(t *testing.T) {
	plans := &fakePlans{allowed: true} // тариф разрешает снять
	svc := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, plans)
	show, err := svc.ShowBadge(context.Background(), domain.NewID(), false)
	if err != nil {
		t.Fatalf("ShowBadge: %v", err)
	}
	if show {
		t.Fatal("тариф разрешает, автор просил — бейдж обязан исчезнуть")
	}
	if len(plans.gotKeys) != 1 || plans.gotKeys[0] != entitlements.FormBranding {
		t.Fatalf("спрошены ключи %v, ожидался form_branding", plans.gotKeys)
	}

	// Даунгрейд возвращает бейдж на уже опубликованную форму — в отличие от цветов,
	// которые уехали в снапшот. Это и есть «гейт другой природы» (ADR §10).
	svc = NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, &fakePlans{allowed: false})
	show, err = svc.ShowBadge(context.Background(), domain.NewID(), false)
	if err != nil {
		t.Fatalf("ShowBadge: %v", err)
	}
	if !show {
		t.Fatal("после даунгрейда бейдж обязан вернуться")
	}
}

// Свой CSS — отдельный ключ каталога, а не строка в списке платных настроек: это
// доступ к вёрстке, и он дороже. Проверяется тем же порядком (после авторизации).
func TestPublish_CustomCSSWithoutPlan_Returns402(t *testing.T) {
	store := &fakeStore{
		form:        Form{WorkspaceID: domain.NewID(), DraftSchema: designDraft(`{"css":".rf-page{padding:0}"}`)},
		nextVersion: 1,
	}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	_, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("err = %v, want ErrPlanRequired", err)
	}
	if !strings.Contains(err.Error(), "CSS") {
		t.Fatalf("отказ обязан называть причину: %v", err)
	}
	if len(plans.gotKeys) != 1 || plans.gotKeys[0] != entitlements.FormCustomCSS {
		t.Fatalf("спрошены ключи %v, ожидался только form_custom_css", plans.gotKeys)
	}
	if store.versionInserted {
		t.Fatal("отказ по тарифу не должен снапшотить версию")
	}
}

// Оформление и CSS — ДВА ключа: разрешённое оформление не открывает CSS.
func TestPublish_DesignAllowedButCSSNot_StillRefuses(t *testing.T) {
	store := &fakeStore{
		form: Form{
			WorkspaceID: domain.NewID(),
			DraftSchema: designDraft(`{"palette":{"accent":"#12ab34"},"css":".rf-page{padding:0}"}`),
		},
		nextVersion: 1,
	}
	// Фейк разрешает ВСЁ, кроме своего CSS: иначе тест не отличил бы два ключа.
	plans := &fakePlans{allowed: true, deny: map[entitlements.Key]bool{entitlements.FormCustomCSS: true}}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	_, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID())
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("err = %v, want ErrPlanRequired", err)
	}
	if len(plans.gotKeys) != 2 {
		t.Fatalf("спрошены ключи %v, ожидались оба", plans.gotKeys)
	}
}

// Пустой и пробельный CSS тарифа не касаются: платят за правило, а не за поле.
func TestPublish_BlankCSS_DoesNotGate(t *testing.T) {
	store := &fakeStore{
		form:        Form{WorkspaceID: domain.NewID(), DraftSchema: designDraft(`{"css":"   "}`)},
		nextVersion: 1,
	}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	if _, err := svc.Publish(context.Background(), domain.NewID(), domain.NewID()); err != nil {
		t.Fatalf("пробельный CSS не должен держать публикацию: %v", err)
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен из-за пустого CSS: %v", plans.gotKeys)
	}
}

// Включение сбора незавершённых требует платного тарифа — единственное место в
// продукте, где гейт стоит на СБОРЕ, а не на показе (ADR §10).
func TestUpdateCollectPartial_EnablingRequiresPlan(t *testing.T) {
	store := &fakeStore{form: Form{ID: uuid.New(), WorkspaceID: uuid.New()}}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, &fakePlans{allowed: false})

	_, err := svc.UpdateCollectPartial(context.Background(), uuid.New(), store.form.ID, true)
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("ошибка = %v, ждали ErrPlanRequired", err)
	}
	if store.updated {
		t.Error("тумблер записан вопреки отказу тарифа")
	}
}

// ВЫКЛЮЧИТЬ обязан мочь кто угодно и когда угодно: запрет остановить сбор данных о
// людях был бы дефектом, а не гейтом. Проверяется на закрытом плане — том самом,
// на котором включить нельзя.
func TestUpdateCollectPartial_DisablingNeedsNoPlan(t *testing.T) {
	store := &fakeStore{form: Form{ID: uuid.New(), WorkspaceID: uuid.New()}}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, &fakePlans{allowed: false})

	form, err := svc.UpdateCollectPartial(context.Background(), uuid.New(), store.form.ID, false)
	if err != nil {
		t.Fatalf("выключение упёрлось в тариф: %v", err)
	}
	if form.CollectPartial || !store.updated {
		t.Fatalf("тумблер = %v (записан: %v), ждали выключенный и записанный", form.CollectPartial, store.updated)
	}
}

// На публичном пути право спрашивается ЗАНОВО: даунгрейд обязан останавливать сбор
// чужих данных немедленно, не дожидаясь, пока владелец вспомнит про тумблер.
func TestCollectPartial_DowngradeStopsCollection(t *testing.T) {
	svc := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, &fakePlans{allowed: false})

	on, err := svc.CollectPartial(context.Background(), uuid.New(), true)
	if err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if on {
		t.Fatal("сбор продолжается на плане, который его больше не разрешает")
	}
}

// Выключенный тумблер тариф не спрашивает вовсе — цена гейта на горячем публичном
// пути нулевая для большинства форм.
func TestCollectPartial_DisabledAsksNoPlan(t *testing.T) {
	plans := &countingPlans{}
	svc := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, plans)

	on, err := svc.CollectPartial(context.Background(), uuid.New(), false)
	if err != nil || on {
		t.Fatalf("сбор = %v, ошибка = %v; ждали выключенный без ошибки", on, err)
	}
	if plans.calls != 0 {
		t.Errorf("походов в тарифы = %d, ждали 0", plans.calls)
	}
}

// countingPlans считает обращения к тарифам — ими проверяется цена гейта.
type countingPlans struct{ calls int }

func (p *countingPlans) CheckWorkspace(context.Context, uuid.UUID, entitlements.Key) (entitlements.Decision, error) {
	p.calls++
	return entitlements.Decision{Allowed: true}, nil
}

func (p *countingPlans) ConsumeAIGeneration(context.Context, uuid.UUID, time.Time) error { return nil }

// --- Своя карточка ссылки: сохранение свободно, применение платно ---

func TestUpdateLinkPreview_SavesOnAnyPlan(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans)

	card := &domain.LinkPreview{Title: "Февральский номер", ImageKey: "ws/abc.png"}
	if _, err := svc.UpdateLinkPreview(context.Background(), domain.NewID(), domain.NewID(), card); err != nil {
		t.Fatalf("сохранение карточки обязано проходить на любом тарифе: %v", err)
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен на сохранении (%v) — гейт обязан стоять при отдаче", plans.gotKeys)
	}
	if store.lastLinkPreview == nil || store.lastLinkPreview.Title != "Февральский номер" {
		t.Fatalf("в репозиторий уехала не та карточка: %+v", store.lastLinkPreview)
	}
}

func TestUpdateLinkPreview_TooLongTitle_Rejected(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := newTestService(store)

	card := &domain.LinkPreview{Title: strings.Repeat("я", domain.MaxLinkPreviewTitleLen+1)}
	_, err := svc.UpdateLinkPreview(context.Background(), domain.NewID(), domain.NewID(), card)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, want ErrValidation (лимит считается в рунах)", err)
	}
	if store.updated {
		t.Fatal("запись прошла при невалидной карточке")
	}
}

func TestLinkPreviewFor_GateAtDelivery(t *testing.T) {
	card := &domain.LinkPreview{Title: "Февральский номер"}

	// Карточки нет — тариф не спрашивается вовсе (цена гейта на публичном пути).
	plans := &fakePlans{allowed: true}
	svc := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, plans)
	got, err := svc.LinkPreviewFor(context.Background(), domain.NewID(), nil)
	if err != nil || got != nil {
		t.Fatalf("пустая карточка: got=%+v err=%v", got, err)
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен у формы без карточки: %v", plans.gotKeys)
	}

	// Есть карточка и право — применяется.
	got, err = svc.LinkPreviewFor(context.Background(), domain.NewID(), card)
	if err != nil || got == nil || got.Title != "Февральский номер" {
		t.Fatalf("карточка с правом: got=%+v err=%v", got, err)
	}
	if len(plans.gotKeys) != 1 || plans.gotKeys[0] != entitlements.FormLinkPreview {
		t.Fatalf("спрошен не тот ключ: %v", plans.gotKeys)
	}

	// Даунгрейд — карточка перестаёт применяться, хотя и осталась в колонке.
	denied := NewService(nil, fakeTx{}, &fakeStore{}, &fakeAccess{}, &fakePlans{allowed: false})
	got, err = denied.LinkPreviewFor(context.Background(), domain.NewID(), card)
	if err != nil || got != nil {
		t.Fatalf("после даунгрейда карточка обязана перестать действовать: got=%+v err=%v", got, err)
	}
}

// --- Пароль на форму (0047) -------------------------------------------------

// passwordSecret — секрет приложения в тестах пароля формы (у публичного
// транспорта свой, testSecret).
const passwordSecret = "form-token-secret-long-enough-32b"

// ptr — адрес значения: фасет пароля различает «не трогать» (nil) и «поставить».
func ptr[T any](v T) *T { return &v }

func passwordService(store *fakeStore) *Service {
	return NewService(nil, fakeTx{}, store, &fakeAccess{}, &fakePlans{allowed: true}).
		WithSecret([]byte(passwordSecret))
}

// Пароль ложится в колонку ШИФРОТЕКСТОМ и читается обратно на экране настроек:
// автор свой пароль видит и копирует (design/form-password.md §2.1).
func TestUpdatePassword_SealsAndReadsBack(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := passwordService(store)
	const plain = "секрет для коллег"

	if _, err := svc.UpdatePassword(context.Background(), uuid.New(), store.form.ID, ptr(plain)); err != nil {
		t.Fatalf("UpdatePassword: %v", err)
	}
	if len(store.lastSealed) == 0 {
		t.Fatal("в стор не ушло ничего")
	}
	if strings.Contains(string(store.lastSealed), plain) {
		t.Fatal("пароль ушёл в колонку открытым текстом")
	}

	store.form.PasswordSealed = store.lastSealed
	got, err := svc.Get(context.Background(), uuid.New(), store.form.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Password == nil || *got.Password != plain {
		t.Fatalf("пароль не вернулся автору: %v", got.Password)
	}
}

// Снятие пишет в колонку NULL, а не пустую строку: у «пароля нет» одно представление.
func TestUpdatePassword_Clears(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := passwordService(store)

	if _, err := svc.UpdatePassword(context.Background(), uuid.New(), store.form.ID, nil); err != nil {
		t.Fatalf("снятие пароля: %v", err)
	}
	if !store.passwordSet {
		t.Fatal("снятие не доехало до стора")
	}
	if store.lastSealed != nil {
		t.Fatalf("в колонку ушло %q вместо NULL", store.lastSealed)
	}
}

func TestUpdatePassword_Validation(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := passwordService(store)

	for _, tt := range []struct {
		name  string
		value string
	}{
		{"пустой", ""},
		{"длиннее потолка", strings.Repeat("я", MaxFormPasswordLen+1)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			_, err := svc.UpdatePassword(context.Background(), uuid.New(), store.form.ID, ptr(tt.value))
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("err = %v, want ErrValidation", err)
			}
			if store.passwordSet {
				t.Fatal("мусор доехал до стора")
			}
		})
	}
}

// Пробелы по краям НЕ режутся: пароль — ровно та строка, которую автор разослал.
func TestUpdatePassword_KeepsSpaces(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := passwordService(store)
	const plain = "  два пробела  "

	if _, err := svc.UpdatePassword(context.Background(), uuid.New(), store.form.ID, ptr(plain)); err != nil {
		t.Fatalf("UpdatePassword: %v", err)
	}
	store.form.PasswordSealed = store.lastSealed
	got, err := svc.Get(context.Background(), uuid.New(), store.form.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Password == nil || *got.Password != plain {
		t.Fatalf("пароль изменён при сохранении: %q", *got.Password)
	}
}

// Тариф на пароле не спрашивается вовсе: он бесплатен на всех планах
// (решение владельца 2026-09-01, design/form-password.md §2.2).
func TestUpdatePassword_NoPlanGate(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	plans := &fakePlans{allowed: false}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, plans).WithSecret([]byte(passwordSecret))

	if _, err := svc.UpdatePassword(context.Background(), uuid.New(), store.form.ID, ptr("пароль")); err != nil {
		t.Fatalf("пароль на бесплатном тарифе: %v", err)
	}
	if len(plans.gotKeys) != 0 {
		t.Fatalf("тариф спрошен: %v", plans.gotKeys)
	}
}

func TestUnlock_VerifiesPassword(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := passwordService(store)
	sealed, err := sealPassword([]byte(passwordSecret), "правильный")
	if err != nil {
		t.Fatalf("sealPassword: %v", err)
	}
	store.sealedPassword = sealed

	if _, _, err := svc.Unlock(context.Background(), "slug", "неправильный"); !errors.Is(err, domain.ErrFormLocked) {
		t.Fatalf("неверный пароль: err = %v, want ErrFormLocked", err)
	}

	tok, expiry, err := svc.Unlock(context.Background(), "slug", "правильный")
	if err != nil {
		t.Fatalf("верный пароль: %v", err)
	}
	if !expiry.After(time.Now()) {
		t.Fatalf("срок токена уже вышел: %v", expiry)
	}
	if err := svc.VerifyUnlock(store.form.ID, sealed, tok); err != nil {
		t.Fatalf("свой же токен не принят: %v", err)
	}
}

// У формы БЕЗ пароля разблокировка ничего не открывает: токен «ни от чего»
// пришлось бы потом отличать от настоящего.
func TestUnlock_NoPassword(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := passwordService(store)

	if _, _, err := svc.Unlock(context.Background(), "slug", ""); !errors.Is(err, domain.ErrFormLocked) {
		t.Fatalf("err = %v, want ErrFormLocked", err)
	}
}

func TestVerifyUnlock(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := passwordService(store)
	formID := domain.NewID()
	sealed := []byte("шифротекст пароля")
	tok := issueUnlockToken(deriveUnlockSecret([]byte(passwordSecret)), formID, sealed, time.Now().Add(time.Hour))

	// Форма без пароля пропускается всегда — в том числе без токена вовсе.
	if err := svc.VerifyUnlock(formID, nil, ""); err != nil {
		t.Fatalf("форма без пароля: %v", err)
	}
	if err := svc.VerifyUnlock(formID, sealed, ""); !errors.Is(err, domain.ErrFormLocked) {
		t.Fatalf("без токена: err = %v, want ErrFormLocked", err)
	}
	if err := svc.VerifyUnlock(domain.NewID(), sealed, tok); !errors.Is(err, domain.ErrFormLocked) {
		t.Fatalf("токен чужой формы принят: %v", err)
	}
	if err := svc.VerifyUnlock(formID, sealed, tok); err != nil {
		t.Fatalf("годный токен: %v", err)
	}
}

// СМЕНА ПАРОЛЯ ГАСИТ ВЫДАННЫЕ ТОКЕНЫ. Без этого автор, у которого пароль утёк, менял
// бы его и ещё сутки не мог никого отсечь — то есть смена пароля не была бы способом
// отозвать доступ, хотя ровно этого от неё и ждут (решение владельца 2026-09-01).
func TestVerifyUnlock_PasswordChangeRevokesTokens(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := passwordService(store)
	formID := domain.NewID()

	oldSealed, err := sealPassword([]byte(passwordSecret), "прежний")
	if err != nil {
		t.Fatalf("sealPassword: %v", err)
	}
	tok := issueUnlockToken(deriveUnlockSecret([]byte(passwordSecret)), formID, oldSealed, time.Now().Add(time.Hour))
	if err := svc.VerifyUnlock(formID, oldSealed, tok); err != nil {
		t.Fatalf("токен под свой пароль обязан работать: %v", err)
	}

	newSealed, err := sealPassword([]byte(passwordSecret), "новый")
	if err != nil {
		t.Fatalf("sealPassword: %v", err)
	}
	if err := svc.VerifyUnlock(formID, newSealed, tok); !errors.Is(err, domain.ErrFormLocked) {
		t.Fatalf("токен пережил смену пароля: err = %v, want ErrFormLocked", err)
	}

	// И тот же пароль, перезапечатанный заново (новый nonce), тоже гасит токен:
	// шифротекст другой, а различать «тот же пароль» и «другой» проверяющему нечем.
	resealed, err := sealPassword([]byte(passwordSecret), "прежний")
	if err != nil {
		t.Fatalf("sealPassword: %v", err)
	}
	if err := svc.VerifyUnlock(formID, resealed, tok); !errors.Is(err, domain.ErrFormLocked) {
		t.Fatalf("перезапечатанный пароль токен не погасил: %v", err)
	}
}

// Ненастроенный секрет — ОТКАЗ, а не работа без защиты: поставить пароль нельзя,
// а уже стоящий не пускает никого.
func TestPasswordWithoutSecret(t *testing.T) {
	store := &fakeStore{form: Form{ID: domain.NewID(), WorkspaceID: domain.NewID()}}
	svc := NewService(nil, fakeTx{}, store, &fakeAccess{}, &fakePlans{allowed: true})

	if _, err := svc.UpdatePassword(context.Background(), uuid.New(), store.form.ID, ptr("пароль")); err == nil {
		t.Fatal("без секрета пароль поставлен")
	}
	if store.passwordSet {
		t.Fatal("без секрета в колонку что-то записано")
	}
	if err := svc.VerifyUnlock(store.form.ID, []byte("шифротекст"), "любой токен"); !errors.Is(err, domain.ErrFormLocked) {
		t.Fatalf("без секрета форма под паролем открылась: %v", err)
	}
}

// Гейт публикации: вопрос о записи есть, расписание не выбрано (фаза 27, решение
// владельца 2026-09-03). Черновик при этом сохраняется — стена стоит только здесь.
func TestPublish_SlotWithoutSchedule(t *testing.T) {
	schema := json.RawMessage(`{"blocks":[{"id":"s1","groupId":"g1","type":"slot","settings":{}}]}`)
	store := &fakeStore{form: Form{
		ID: uuid.New(), WorkspaceID: uuid.New(), DraftSchema: schema, Status: "draft",
	}}
	svc := newTestService(store)

	_, err := svc.Publish(context.Background(), uuid.New(), store.form.ID)
	if err == nil {
		t.Fatal("форма с вопросом о записи и без расписания опубликована")
	}
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка не ErrValidation: %v", err)
	}
	if !strings.Contains(err.Error(), "расписание не выбрано") {
		t.Fatalf("текст отказа %q — автору нужно сказать, что делать", err.Error())
	}
}

// То же расписание, но выбранное, и обязательный вопрос о почте на месте: публикация
// проходит.
//
// ⚠ ПОЧТА В ЭТОЙ СХЕМЕ — НЕ УКРАШЕНИЕ. До 2026-09-04 тест публиковал форму записи без
// неё и проходил: ровно то состояние, в котором письмо о записи молча не уходит.
func TestPublish_SlotWithSchedule(t *testing.T) {
	scheduleID := uuid.New()
	schema := json.RawMessage(`{"blocks":[
		{"id":"s1","groupId":"g1","type":"slot","settings":{}},
		{"id":"e1","groupId":"g2","type":"email","required":true,"settings":{}}
	]}`)
	store := &fakeStore{form: Form{
		ID: uuid.New(), WorkspaceID: uuid.New(), DraftSchema: schema, Status: "draft",
		ScheduleID: &scheduleID,
	}}
	svc := newTestService(store)

	if _, err := svc.Publish(context.Background(), uuid.New(), store.form.ID); err != nil {
		t.Fatalf("публикация с выбранным расписанием отвергнута: %v", err)
	}
}

// РЕГРЕССИЯ (отчёт владельца 2026-09-04): форма записи публиковалась без вопроса о
// почте, и письмо о записи после этого молча не уходило — а с ним не уходила и ссылка
// отмены, то есть место оставалось занятым до самого приёма.
//
// Необязательный вопрос о почте гейт тоже не проходит: респондент его пропускает, и
// форма возвращается в то же состояние.
func TestPublish_SlotWithoutRequiredEmail(t *testing.T) {
	scheduleID := uuid.New()
	cases := map[string]string{
		"почты нет вовсе": `{"blocks":[{"id":"s1","groupId":"g1","type":"slot","settings":{}}]}`,
		"почта необязательна": `{"blocks":[
			{"id":"s1","groupId":"g1","type":"slot","settings":{}},
			{"id":"e1","groupId":"g2","type":"email","settings":{}}
		]}`,
	}
	for name, schema := range cases {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{form: Form{
				ID: uuid.New(), WorkspaceID: uuid.New(), DraftSchema: json.RawMessage(schema),
				Status: "draft", ScheduleID: &scheduleID,
			}}
			svc := newTestService(store)

			_, err := svc.Publish(context.Background(), uuid.New(), store.form.ID)
			if err == nil {
				t.Fatal("форма записи без обязательной почты опубликована")
			}
			if !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("ошибка не ErrValidation: %v", err)
			}
			if !strings.Contains(err.Error(), "ссылку отмены") {
				t.Fatalf("текст отказа %q — автору нужно сказать, ЗАЧЕМ почта", err.Error())
			}
		})
	}
}

// Формы без записи новый гейт не касается: почта им не нужна.
func TestPublish_NoSlotNeedsNoEmail(t *testing.T) {
	schema := json.RawMessage(`{"blocks":[{"id":"q1","groupId":"g1","type":"short_text","settings":{}}]}`)
	store := &fakeStore{form: Form{
		ID: uuid.New(), WorkspaceID: uuid.New(), DraftSchema: schema, Status: "draft",
	}}
	svc := newTestService(store)

	if _, err := svc.Publish(context.Background(), uuid.New(), store.form.ID); err != nil {
		t.Fatalf("обычная форма не опубликовалась: %v", err)
	}
}

// Чужое расписание формой не привязывается: id приезжает телом запроса и правом
// доступа не является (инвариант 1). Отказ — 404, а не 403: существование чужого
// расписания не раскрывается.
func TestUpdateSchedule_ForeignScheduleNotFound(t *testing.T) {
	store := &fakeStore{
		form:                Form{ID: uuid.New(), WorkspaceID: uuid.New()},
		scheduleInWorkspace: false,
	}
	svc := newTestService(store)
	foreign := uuid.New()

	_, err := svc.UpdateSchedule(context.Background(), uuid.New(), store.form.ID, &foreign)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка %v, ожидался ErrNotFound", err)
	}
	if store.lastScheduleID != nil {
		t.Fatal("привязка дошла до базы, хотя расписание чужое")
	}
}

// Снятие расписания (null) в пространство не ходит вовсе: проверять нечего.
func TestUpdateSchedule_ClearSkipsCheck(t *testing.T) {
	store := &fakeStore{form: Form{ID: uuid.New(), WorkspaceID: uuid.New()}}
	svc := newTestService(store)

	if _, err := svc.UpdateSchedule(context.Background(), uuid.New(), store.form.ID, nil); err != nil {
		t.Fatalf("снятие расписания отвергнуто: %v", err)
	}
	if !store.updated {
		t.Fatal("снятие до базы не дошло")
	}
}

// fakeGuard — стоп-кран записи в тестах: сколько живых будущих встреч у формы.
type fakeGuard struct {
	future int64
	err    error
}

func (g fakeGuard) FutureOfForm(context.Context, uuid.UUID) (int64, error) {
	return g.future, g.err
}

// Живая будущая запись держит удаление формы (фаза 27, ADR §10): молча снести чужие
// договорённости нельзя.
func TestDelete_BlockedByFutureBooking(t *testing.T) {
	store := &fakeStore{form: Form{ID: uuid.New(), WorkspaceID: uuid.New()}}
	svc := newTestService(store).WithBookingGuard(fakeGuard{future: 3})

	err := svc.Delete(context.Background(), uuid.New(), store.form.ID)
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ошибка %v, ожидался ErrConflict", err)
	}
	// Число согласовано словами: отказ читает человек.
	if !strings.Contains(err.Error(), "3 будущие записи") {
		t.Fatalf("текст отказа %q — ожидалось согласованное число", err.Error())
	}
	if store.deleted {
		t.Fatal("форма удалена, хотя на неё записаны люди")
	}
}

// Прошлые записи не держат ничего: они уже состоялись.
func TestDelete_PastBookingsDoNotBlock(t *testing.T) {
	// deleteN: одна снесённая строка — иначе фейк отвечает «нет такой формы».
	store := &fakeStore{form: Form{ID: uuid.New(), WorkspaceID: uuid.New()}, deleteN: 1}
	svc := newTestService(store).WithBookingGuard(fakeGuard{future: 0})

	if err := svc.Delete(context.Background(), uuid.New(), store.form.ID); err != nil {
		t.Fatalf("удаление отвергнуто: %v", err)
	}
	if !store.deleted {
		t.Fatal("форма не удалена")
	}
}

// Поиск по всем пространствам не спрашивает право ни у одного из них: пространство
// в запросе не названо, а чужую форму физически не пускает в выдачу соединение по
// членству (проверяется интеграционным тестом против настоящей БД). Здесь —
// договор сервиса: что уходит в репозиторий и что считается пустым запросом.
func TestSearch_TrimsEscapesAndCaps(t *testing.T) {
	uid := uuid.New()
	store := &fakeStore{searchHits: []SearchHit{{Title: "Анкета"}}}
	svc := newTestService(store)

	got, err := svc.Search(context.Background(), uid, "  50%_опрос  ")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("результатов = %d, ожидался 1", len(got))
	}
	if store.lastSearchUser != uid {
		t.Errorf("userID в репозиторий = %s, ожидался %s", store.lastSearchUser, uid)
	}
	// Пробелы обрезаны, спецсимволы LIKE обезврежены: без экранирования «50%»
	// находит любую форму, а «_» — любой символ.
	if store.lastSearchQuery != `50\%\_опрос` {
		t.Errorf("запрос в репозиторий = %q, ожидался экранированный", store.lastSearchQuery)
	}
	if store.lastSearchLimit != int32(MaxSearchResults) {
		t.Errorf("потолок выдачи = %d, ожидался %d", store.lastSearchLimit, MaxSearchResults)
	}
}

// Пустой запрос — пустой ответ, а не отказ: строка поиска пуста ровно до первой
// набранной буквы, и 422 на этом состоянии был бы ошибкой на ровном месте.
func TestSearch_EmptyQueryIsNotAnError(t *testing.T) {
	store := &fakeStore{searchHits: []SearchHit{{Title: "Анкета"}}}
	svc := newTestService(store)

	for _, q := range []string{"", "   ", "\t\n"} {
		got, err := svc.Search(context.Background(), uuid.New(), q)
		if err != nil {
			t.Fatalf("Search(%q): %v", q, err)
		}
		if got != nil {
			t.Fatalf("Search(%q) = %+v, ожидался пустой ответ", q, got)
		}
		if store.lastSearchQuery != "" {
			t.Fatalf("на пустом запросе сходили в репозиторий с %q", store.lastSearchQuery)
		}
	}
}

// Слишком длинный запрос — отказ валидации, а не шаблон в десятки килобайт в ILIKE:
// query-строку не стережёт MaxBytesReader (он про тело), а инвариант 3 требует
// проверять любой ввод на бэке.
func TestSearch_TooLongRejected(t *testing.T) {
	svc := newTestService(&fakeStore{})
	long := strings.Repeat("я", MaxSearchLen+1)
	if _, err := svc.Search(context.Background(), uuid.New(), long); !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, ожидался ErrValidation", err)
	}
}

// WithDocument — единственное место, где разбирается документ публичной формы и
// разрешается её заголовок. Тест сторожит обе половины разом, потому что на них
// завязаны ВСЕ публичные входы: разбор едет полем (pf.Parsed), и вызывающие больше
// не разбирают схему сами (TD-77).
func TestWithDocument(t *testing.T) {
	const titled = `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Из документа"}]}]}`

	t.Run("разбирает документ и берёт заголовок из него", func(t *testing.T) {
		pf := WithDocument(PublicForm{Title: "из колонки", Schema: json.RawMessage(titled)})
		if pf.ParseErr != nil {
			t.Fatalf("схема не разобралась: %v", pf.ParseErr)
		}
		if len(pf.Parsed.Blocks) != 1 {
			t.Fatalf("разбор не доехал полем: блоков %d, ожидался 1", len(pf.Parsed.Blocks))
		}
		if pf.Title != "Из документа" {
			t.Fatalf("заголовок = %q, ожидался из документа версии", pf.Title)
		}
	})

	t.Run("версия без блока заголовка оставляет колонку", func(t *testing.T) {
		pf := WithDocument(PublicForm{Title: "из колонки", Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[]}`)})
		if pf.ParseErr != nil {
			t.Fatalf("схема не разобралась: %v", pf.ParseErr)
		}
		if pf.Title != "из колонки" {
			t.Fatalf("заголовок = %q, ожидался фолбэк колонки", pf.Title)
		}
	})

	// Битый документ не роняет резолв: отношение к нему у вызывающих разное, и
	// решают они по ParseErr. Заголовок при этом обязан остаться из колонки —
	// страница формы и OG-мета рисуются даже по неразобравшейся версии.
	t.Run("битый документ отдаётся ошибкой полем, а не паникой", func(t *testing.T) {
		pf := WithDocument(PublicForm{Title: "из колонки", Schema: json.RawMessage(`{"blocks":[],"fieldFromFuture":"x"}`)})
		if pf.ParseErr == nil {
			t.Fatal("битая схема разобралась — DisallowUnknownFields не сработал")
		}
		if pf.Title != "из колонки" {
			t.Fatalf("заголовок = %q, ожидался фолбэк колонки", pf.Title)
		}
	})
}
