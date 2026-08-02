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
	"github.com/ka-shmd/trillix/internal/postgres"
)

// fakeStore — управляемая реализация Store для юнитов сервиса (без БД).
type fakeStore struct {
	personalWS  uuid.UUID
	personalErr error

	form   Form
	getErr error

	member    bool
	memberErr error

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

	// Управление чтением версий (CSV-экспорт).
	versions []Version

	// Управление путём автосейва схемы.
	schemaSaved     bool
	schemaErr       error // если задана — UpdateFormDraftSchema вернёт её (напр. pgx.ErrNoRows)
	lastSchema      json.RawMessage
	lastMirrorTitle *string
	lastExpected    time.Time

	// Захват настроек закрытия последнего UpdateCloseSettings.
	lastCloseSettings domain.CloseSettings

	// Тумблер уведомлений (слайс D) и адресат уведомления.
	lastNotifyEnabled bool
	owner             Owner
	ownerErr          error

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
}

func (f *fakeStore) GetPersonalWorkspace(_ context.Context, _ postgres.DBTX, _ uuid.UUID) (uuid.UUID, error) {
	return f.personalWS, f.personalErr
}

func (f *fakeStore) IsWorkspaceMember(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID) (bool, error) {
	return f.member, f.memberErr
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

func (f *fakeStore) ListFormsPage(_ context.Context, _ postgres.DBTX, workspaceID uuid.UUID, sort string, search string, after *Cursor, limit int32) ([]ListRow, error) {
	f.lastListWS = workspaceID
	f.lastListLimit = limit
	f.lastListAfter = after != nil
	f.lastListSort = sort
	f.lastListSearch = search
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

func newTestService(store *fakeStore) *Service {
	return NewService(nil, fakeTx{}, store)
}

func strptr(s string) *string { return &s }

// --- Анти-IDOR: доступ к чужой форме неотличим от отсутствующей (404) ---

func TestGet_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

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
	store := &fakeStore{form: Form{WorkspaceID: wsID, Title: "My form"}, member: true}
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
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

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
	store := &fakeStore{form: Form{WorkspaceID: wsID, Title: "My form"}, member: true}
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
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

	_, err := svc.UpdateCloseSettings(context.Background(), domain.NewID(), domain.NewID(), domain.CloseSettings{})
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound (чужая форма не раскрывается)", err)
	}
	if store.updated {
		t.Fatal("чужая форма не должна обновляться")
	}
}

func TestUpdateCloseSettings_InvalidLimit_ReturnsValidationBeforeStore(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: true}
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
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: true}
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
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

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
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

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
	schema := json.RawMessage(`{"schemaVersion":1,"blocks":[{"id":"b1","type":"short_text","label":"Имя"}]}`)
	store := &fakeStore{
		// У оригинала имя не задано (name=nil) — база берётся из title.
		form:   Form{WorkspaceID: wsID, Title: "Анкета", Slug: "old-slug", Status: "published", DraftSchema: schema},
		member: true,
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
		form:   Form{WorkspaceID: wsID, Name: &name, Title: "Анкета", DraftSchema: json.RawMessage(`{"blocks":[]}`)},
		member: true,
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
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

	_, err := svc.UpdateName(context.Background(), domain.NewID(), domain.NewID(), "новое имя")
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	if store.updated {
		t.Fatal("чужую форму не должно переименовывать")
	}
}

func TestUpdateName_Empty_ResetsToNil(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: true}
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
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

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
	bad := json.RawMessage(`{"blocks":[{"id":"b","type":"slider","label":"x"}]}`)
	store := &fakeStore{form: Form{DraftSchema: bad}, member: true}
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
		member:      true,
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

func TestUnpublish_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

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
		form:   Form{WorkspaceID: domain.NewID(), Status: "published", PublishedVersion: &v},
		member: true,
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
	store := &fakeStore{form: Form{}, member: true}
	svc := newTestService(store)

	// Неизвестный тип блока — ValidateSchema отвергает до всякого доступа к БД.
	bad := json.RawMessage(`{"blocks":[{"id":"b","type":"slider","label":"x"}]}`)
	_, err := svc.UpdateDraftSchema(context.Background(), domain.NewID(), domain.NewID(), bad, time.Now())
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, want ErrValidation", err)
	}
	if store.schemaSaved {
		t.Fatal("невалидная схема не должна доходить до БД")
	}
}

func TestUpdateDraftSchema_NotMember_ReturnsNotFound(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}, member: false}
	svc := newTestService(store)

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
	store := &fakeStore{form: Form{}, member: true, schemaErr: pgx.ErrNoRows}
	svc := newTestService(store)

	ok := json.RawMessage(`{"blocks":[]}`)
	_, err := svc.UpdateDraftSchema(context.Background(), domain.NewID(), domain.NewID(), ok, time.Now())
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("err = %v, want ErrConflict", err)
	}
}

func TestUpdateDraftSchema_Valid_CanonicalizesAndPassesExpected(t *testing.T) {
	store := &fakeStore{form: Form{}, member: true}
	svc := newTestService(store)

	expected := time.Now().Truncate(time.Microsecond)
	// Без schemaVersion — канонизация должна её проставить (=1).
	in := json.RawMessage(`{"blocks":[{"id":"b","type":"short_text","label":"Имя"}]}`)
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

	store := &fakeStore{personalWS: personal, member: true}
	svc := newTestService(store)
	if _, err := svc.Create(context.Background(), domain.NewID(), "Форма", &explicit); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if store.lastCreateWS != explicit {
		t.Fatalf("форма создана в %v, ожидалось названное пространство %v", store.lastCreateWS, explicit)
	}

	// Не член — 404 (не 403): существование чужого пространства не раскрываем.
	denied := &fakeStore{personalWS: personal, member: false}
	svcDenied := newTestService(denied)
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
			schema: `{"schemaVersion":4,"blocks":[{"id":"b","groupId":"g","type":"short_text","settings":{}}]}`,
			want:   nil,
		},
		"заголовок с текстом — едет в колонку": {
			schema: `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета ","m":["b"]},{"t":"2026"}]}]}`,
			want:   strptr("Анкета 2026"),
		},
		"заголовок стёрт — колонка получает служебное имя": {
			schema: `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[]}]}`,
			want:   strptr(defaultFormTitle),
		},
		"пробелы вокруг заголовка обрезаются": {
			schema: `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"  Анкета  "}]}]}`,
			want:   strptr("Анкета"),
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{form: Form{}, member: true}
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
			schema: `{"schemaVersion":3,"blocks":[{"id":"b","groupId":"g","type":"short_text","settings":{}}]}`,
			want:   "Старое название",
		},
		"версия с заголовком — колонка игнорируется": {
			column: "Живое имя из колонки",
			schema: `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Опубликованный заголовок"}]}]}`,
			want:   "Опубликованный заголовок",
		},
		"автор стёр заголовок — пусто, а не служебное имя": {
			column: defaultFormTitle,
			schema: `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[]}]}`,
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
