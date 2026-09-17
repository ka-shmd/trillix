package forms

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
)

func filledConsent() domain.ConsentSettings {
	return domain.ConsentSettings{
		Operator: domain.ConsentOperator{Name: " ИП Иванов И. И. ", Address: "Казань", Email: "ivanov@example.com"},
	}
}

func TestSaveConsent_WritesRevisionOnlyOnChange(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newTestService(store)
	ctx, user, form := context.Background(), domain.NewID(), domain.NewID()

	first, err := svc.SaveConsent(ctx, user, form, true, filledConsent())
	if err != nil {
		t.Fatalf("SaveConsent: %v", err)
	}
	if store.consentInserted != 1 || first.RevisionID == nil || store.consentCurrent == nil || *store.consentCurrent != *first.RevisionID {
		t.Fatalf("ревизия не стала текущей: вставок %d, состояние %+v", store.consentInserted, first)
	}
	if first.Settings.Operator.Name != "ИП Иванов И. И." {
		t.Errorf("наименование не нормализовано: %q", first.Settings.Operator.Name)
	}

	// Тот же раздел ещё раз — строки нет: одинаковые ревизии подряд ничего не доказывают.
	again, err := svc.SaveConsent(ctx, user, form, true, filledConsent())
	if err != nil {
		t.Fatalf("SaveConsent (повтор): %v", err)
	}
	if store.consentInserted != 1 || *again.RevisionID != *first.RevisionID {
		t.Fatalf("повтор без изменений записал ревизию: вставок %d", store.consentInserted)
	}

	// Выключение — изменение: новая ревизия с теми же реквизитами.
	off, err := svc.SaveConsent(ctx, user, form, false, filledConsent())
	if err != nil {
		t.Fatalf("SaveConsent (выключение): %v", err)
	}
	if store.consentInserted != 2 || off.Enabled || off.Settings.Operator.Email != "ivanov@example.com" {
		t.Fatalf("выключение: вставок %d, состояние %+v", store.consentInserted, off)
	}
}

// Список реквизитов пространства пополняется только набором, который попал в типовой
// текст включённого согласия (спека §3.6).
func TestSaveConsent_RemembersOperator(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	svc := newTestService(store)
	ctx, user, form := context.Background(), domain.NewID(), domain.NewID()

	custom := filledConsent()
	custom.Documents, custom.ConsentText, custom.PolicyText = domain.ConsentDocCustom, "Согласие", "Политика"
	for name, save := range map[string]func() error{
		"выключенное":    func() error { _, err := svc.SaveConsent(ctx, user, form, false, filledConsent()); return err },
		"свои документы": func() error { _, err := svc.SaveConsent(ctx, user, form, true, custom); return err },
	} {
		if err := save(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(store.consentRemembered) != 0 {
			t.Fatalf("%s: реквизиты попали в список: %+v", name, store.consentRemembered)
		}
	}

	if _, err := svc.SaveConsent(ctx, user, form, true, filledConsent()); err != nil {
		t.Fatalf("SaveConsent: %v", err)
	}
	if len(store.consentRemembered) != 1 || store.consentRemembered[0].Name != "ИП Иванов И. И." {
		t.Fatalf("в списке %+v, ожидался нормализованный набор", store.consentRemembered)
	}
}

func TestSaveConsent_RejectsBeforeStore(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}

	incomplete := filledConsent()
	incomplete.Operator.Address = ""
	_, err := newTestService(store).SaveConsent(context.Background(), domain.NewID(), domain.NewID(), true, incomplete)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("err = %v, ожидалась ErrValidation (нет адреса оператора)", err)
	}

	_, err = newDeniedService(store).SaveConsent(context.Background(), domain.NewID(), domain.NewID(), true, filledConsent())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("err = %v, ожидалась ErrNotFound (чужая форма не раскрывается)", err)
	}
	if store.consentInserted != 0 {
		t.Fatal("отвергнутое сохранение дошло до записи")
	}
}

func TestSaveConsent_AsksWriteRight(t *testing.T) {
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID()}}
	access := &fakeAccess{}
	svc := NewService(nil, fakeTx{}, store, access, &fakePlans{allowed: true})
	if _, err := svc.SaveConsent(context.Background(), domain.NewID(), domain.NewID(), true, filledConsent()); err != nil {
		t.Fatalf("SaveConsent: %v", err)
	}
	if len(access.gotActions) != 1 || access.gotActions[0] != domain.ActionFormWrite {
		t.Fatalf("спрошены права %v, ожидалось form.write", access.gotActions)
	}
}

func TestConsentPreview_UsesDraftQuestions(t *testing.T) {
	draft := `{"blocks":[
		{"id":"ft","groupId":"g_ft","type":"form_title","text":[{"t":"Анкета гостя"}]},
		{"id":"t1","groupId":"g_b1","type":"title","text":[{"t":"Ваш телефон"}]},
		{"id":"b1","groupId":"g_b1","type":"phone","settings":{}}
	]}`
	store := &fakeStore{form: Form{WorkspaceID: domain.NewID(), Title: "колонка", DraftSchema: json.RawMessage(draft)}}
	consent, policy, err := newTestService(store).ConsentPreview(context.Background(), domain.NewID(), domain.NewID(), filledConsent())
	if err != nil {
		t.Fatalf("ConsentPreview: %v", err)
	}
	for _, text := range []string{consent.Text, policy.Text} {
		if !strings.Contains(text, "«Анкета гостя»") || !strings.Contains(text, "«Ваш телефон»") {
			t.Errorf("документ не взял заголовок и вопросы черновика:\n%s", text)
		}
	}
}

func TestPublicConsentDocument(t *testing.T) {
	formID := domain.NewID()
	enabled, disabled := domain.NewID(), domain.NewID()
	settings := domain.NormalizeConsentSettings(filledConsent())
	current := `{"blocks":[{"id":"b2","groupId":"g_b2","type":"phone","settings":{"placeholder":"Телефон"}}]}`
	store := &fakeStore{
		publicForm: WithDocument(PublicForm{
			PublicFormRef: PublicFormRef{FormID: formID, Version: 2},
			Title:         "Колонка",
			Schema:        json.RawMessage(current),
		}),
		consentRevs: map[uuid.UUID]ConsentRevision{
			enabled:  {ID: enabled, Enabled: true, Settings: settings, Template: domain.ConsentTemplateVersion},
			disabled: {ID: disabled, Enabled: false, Settings: settings, Template: domain.ConsentTemplateVersion},
		},
	}
	svc := newTestService(store)
	ctx := context.Background()

	doc, err := svc.PublicConsentDocument(ctx, "slug", domain.ConsentDocConsent, enabled, "")
	if err != nil {
		t.Fatalf("документ: %v", err)
	}
	if !strings.Contains(doc.Text, "«Телефон»") || !strings.Contains(doc.Text, "«Колонка»") {
		t.Errorf("документ не по опубликованной версии и её заголовку:\n%s", doc.Text)
	}

	for name, c := range map[string]struct {
		kind domain.ConsentDocKind
		rev  uuid.UUID
	}{
		"выключенная ревизия":  {domain.ConsentDocConsent, disabled},
		"чужая ревизия":        {domain.ConsentDocPolicy, domain.NewID()},
		"нет такого документа": {"offer", enabled},
	} {
		if _, err := svc.PublicConsentDocument(ctx, "slug", c.kind, c.rev, ""); !errors.Is(err, domain.ErrNotFound) {
			t.Errorf("%s: err = %v, ожидалась ErrNotFound", name, err)
		}
	}
}
