package submissions

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/notify"
	"github.com/ka-shmd/trillix/internal/postgres"
)

type readMark struct {
	user    uuid.UUID
	kind    notify.Kind
	subject uuid.UUID
}

type fakeNotes struct {
	events []notify.Event
	marks  []readMark
	err    error
}

func (f *fakeNotes) Notify(_ context.Context, _ postgres.DBTX, ev notify.Event) error {
	f.events = append(f.events, ev)
	return f.err
}

func (f *fakeNotes) MarkReadBySubject(_ context.Context, userID uuid.UUID, kind notify.Kind, subjectID uuid.UUID) error {
	f.marks = append(f.marks, readMark{userID, kind, subjectID})
	return f.err
}

// notifiedForm — опубликованная форма с пространством и кабинетным именем: то и
// другое уезжает в повод, и берётся оно из уже прочитанной публичной формы.
func notifiedForm() forms.PublicForm {
	return forms.WithDocument(forms.PublicForm{
		PublicFormRef: forms.PublicFormRef{
			FormID:      uuid.New(),
			WorkspaceID: uuid.New(),
			CabinetName: "Заявка на консультацию",
			Status:      domain.FormStatusPublished,
		},
		Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
	})
}

// Повод о новых ответах ставится на КАЖДЫЙ принятый ответ и НЕ зависит от
// тумблера письма: письмо — настройка формы, лента — вид человека на своё
// хозяйство.
func TestSubmit_RaisesNewSubmissionsNotification(t *testing.T) {
	pf := notifiedForm()
	notes := &fakeNotes{}
	svc := NewService(nil, fakeTx{}, fakeForms{pf: pf},
		nil, &fakeMailer{}, okPlans(), &fakeSubStore{insertN: 1}, "https://app.test").
		WithNotifications(notes)

	if err := svc.Submit(context.Background(), "zayavka", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if len(notes.events) != 1 {
		t.Fatalf("поставлено поводов %d, ожидался один", len(notes.events))
	}
	ev := notes.events[0]
	if ev.Kind != notify.KindNewSubmissions {
		t.Errorf("повод = %q", ev.Kind)
	}
	if ev.WorkspaceID != pf.WorkspaceID {
		t.Error("повод адресован не тому пространству")
	}
	// Субъект повода — форма: по нему склеивается повтор и по нему же гаснет
	// строка, когда человек откроет таблицу ответов.
	if ev.SubjectID != pf.FormID || ev.FormID != pf.FormID {
		t.Errorf("субъект = %s, форма = %s, ожидалась форма %s", ev.SubjectID, ev.FormID, pf.FormID)
	}
	// Имя в снимке — кабинетное: в ленте форма обязана называться тем же словом,
	// что в списке форм.
	if ev.Payload.FormTitle != "Заявка на консультацию" || ev.Payload.FormSlug != "zayavka" {
		t.Errorf("снимок повода = %+v", ev.Payload)
	}
}

// Сверхлимитный ответ повода не поднимает: в таблице ответов кабинета такой
// строки не видно (счётчик карточки считает NOT over_quota), и обещать её
// колокольчиком нельзя.
func TestSubmit_OverQuota_RaisesNoNewSubmissions(t *testing.T) {
	notes := &fakeNotes{}
	svc := NewService(nil, fakeTx{}, fakeForms{pf: notifiedForm()},
		nil, &fakeMailer{}, fakePlans{allowed: false}, &fakeSubStore{insertN: 1}, "https://app.test").
		WithNotifications(notes)

	if err := svc.Submit(context.Background(), "zayavka", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if len(notes.events) != 0 {
		t.Fatalf("сверхлимитный ответ поднял повод о новых ответах: %+v", notes.events)
	}
}

// Идемпотентный ретрай (тот же id) второго повода не даёт: строка не вставлялась,
// нового ответа не появилось.
func TestSubmit_Retry_RaisesNoSecondNotification(t *testing.T) {
	notes := &fakeNotes{}
	svc := NewService(nil, fakeTx{}, fakeForms{pf: notifiedForm()},
		nil, &fakeMailer{}, okPlans(), &fakeSubStore{insertN: 0}, "https://app.test").
		WithNotifications(notes)

	if err := svc.Submit(context.Background(), "zayavka", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if len(notes.events) != 0 {
		t.Fatalf("повтор ответа поставил повод: %+v", notes.events)
	}
}

// Сбой постановки повода не имеет права уронить принятый ответ: респондент увидел
// бы «не удалось отправить» на записанном ответе.
func TestSubmit_NotificationFailure_DoesNotFailAccept(t *testing.T) {
	notes := &fakeNotes{err: errors.New("база отвернулась")}
	svc := NewService(nil, fakeTx{}, fakeForms{pf: notifiedForm()},
		nil, &fakeMailer{}, okPlans(), &fakeSubStore{insertN: 1}, "https://app.test").
		WithNotifications(notes)

	if err := svc.Submit(context.Background(), "zayavka", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("сбой уведомления уронил приём ответа: %v", err)
	}
}

// Сборка без уведомлений (nil) приём ответа не замечает — как и без файлов и без
// записи на время.
func TestSubmit_WithoutNotifications_Accepts(t *testing.T) {
	svc := NewService(nil, fakeTx{}, fakeForms{pf: notifiedForm()},
		nil, &fakeMailer{}, okPlans(), &fakeSubStore{insertN: 1}, "https://app.test")

	if err := svc.Submit(context.Background(), "zayavka", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("Submit без уведомлений: %v", err)
	}
}
