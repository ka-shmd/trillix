package integrations_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/notify"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// fakeNotes — уведомления кабинета в тестах доставки: запоминает поставленные
// поводы и отбои.
type fakeNotes struct {
	events  []notify.Event
	cleared []uuid.UUID
}

func (f *fakeNotes) Notify(_ context.Context, _ postgres.DBTX, ev notify.Event) error {
	f.events = append(f.events, ev)
	return nil
}

func (f *fakeNotes) Clear(_ context.Context, _ postgres.DBTX, _ notify.Kind, subjectID uuid.UUID) error {
	f.cleared = append(f.cleared, subjectID)
	return nil
}

// noticedSheet — связка с пространством, именем формы и её адресом: всё, что
// уезжает в повод. Обычный linkedSheet их не несёт — доставке они не нужны.
func noticedSheet() integrations.FormLink {
	l := linkedSheet()
	l.Name = "Лиды"
	l.WorkspaceID = testWS
	l.FormName = "Заявка на курс"
	l.FormSlug = "zayavka"
	return l
}

// Связка встала — в кабинете появляется повод. Без него автор узнал бы о поломке,
// только заглянув на таб «Интеграции» нужной формы: доставщик ходит фоном.
func TestSheetLinkBroken_RaisesNotice(t *testing.T) {
	store := &fakeStore{link: noticedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: append(headerOf(linkedSheet()), "Моя колонка")}
	columns := append(linkedSheet().Columns, col("b3", "Телефон"))
	subs := &fakeSubmissions{page: onePage(columns, "018f", "Ирина", "i@example.com", "+7")}
	notes := &fakeNotes{}
	svc := deliveryService(store, provider, subs).WithNotifications(notes)

	deliverSheets(t, svc)

	if len(notes.events) != 1 {
		t.Fatalf("поводов %d, ожидался один", len(notes.events))
	}
	ev := notes.events[0]
	if ev.Kind != notify.KindIntegrationBroken {
		t.Errorf("повод = %q", ev.Kind)
	}
	if ev.WorkspaceID != testWS || ev.FormID != testForm {
		t.Errorf("повод адресован не туда: ws=%s form=%s", ev.WorkspaceID, ev.FormID)
	}
	// Субъект — ЦЕЛЬ, а не форма: у формы целей сколько угодно, и повод о каждой
	// живёт своей строкой со своим отбоем.
	if ev.SubjectID != store.link.ID {
		t.Errorf("субъект = %s, ожидалась связка %s", ev.SubjectID, store.link.ID)
	}
	if ev.Payload.Target != "sheet" || ev.Payload.TargetName != "Лиды" {
		t.Errorf("цель в снимке = %+v", ev.Payload)
	}
	// Причина — ТА ЖЕ строка, что легла в связку и в журнал: своего текста отказа
	// повод не сочиняет.
	if ev.Payload.Reason != store.brokenWith {
		t.Errorf("причина повода = %q, у связки = %q", ev.Payload.Reason, store.brokenWith)
	}
	if !strings.Contains(ev.Payload.Reason, "колонка") {
		t.Errorf("причина не рассказывает про колонку: %q", ev.Payload.Reason)
	}
	if ev.Payload.FormTitle != "Заявка на курс" || ev.Payload.FormSlug != "zayavka" {
		t.Errorf("форма в снимке = %+v", ev.Payload)
	}
}

// Удаление связки снимает повод: человек сносит сломанную именно потому, что она
// сломана, и висящее «отвалилось» про несуществующую цель — ложь.
func TestDisconnectForm_ClearsNotice(t *testing.T) {
	link := noticedSheet()
	store := &fakeStore{link: link, conn: sealedConn(t)}
	notes := &fakeNotes{}
	svc := deliveryService(store, &fakeProvider{}, &fakeSubmissions{}).WithNotifications(notes)

	if err := svc.DisconnectForm(context.Background(), testUser, testForm, link.ID); err != nil {
		t.Fatalf("отвязка: %v", err)
	}
	if len(notes.cleared) != 1 || notes.cleared[0] != link.ID {
		t.Fatalf("отбой не сработал: %v", notes.cleared)
	}
}

// Цель ответила 410 — повод появляется тем же путём, что у связки Таблиц: у
// препятствия один вид, кто бы им ни был.
func TestWebhookBroken_RaisesNotice(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusGone)
	w, _ := h.hook(t, 1)

	if _, err := h.svc.DeliverWebhooks(context.Background()); err != nil {
		t.Fatalf("проход: %v", err)
	}
	if len(h.notes.events) != 1 {
		t.Fatalf("поводов %d, ожидался один", len(h.notes.events))
	}
	ev := h.notes.events[0]
	if ev.Kind != notify.KindIntegrationBroken || ev.SubjectID != w.ID {
		t.Fatalf("повод = %q, субъект = %s, ожидалась цель %s", ev.Kind, ev.SubjectID, w.ID)
	}
	if ev.Payload.Target != "webhook" || ev.Payload.TargetName != "CRM" {
		t.Errorf("цель в снимке = %+v", ev.Payload)
	}
	if !strings.Contains(ev.Payload.Reason, "410") {
		t.Errorf("причина = %q, ожидался рассказ про 410", ev.Payload.Reason)
	}
	// Та же причина лежит у самой цели: два текста об одном отказе разъехались бы.
	if got := h.target(t, w.ID); got.LastError != ev.Payload.Reason {
		t.Errorf("у цели причина %q, в поводе %q", got.LastError, ev.Payload.Reason)
	}
}

// Удачная «Проверить» будит цель — и снимает повод: получатель работает СЕЙЧАС.
func TestWebhookTestPasses_ClearsNotice(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	w, _ := h.hook(t, 0)
	h.store.editAny(w.ID, func(x *integrations.Webhook) { x.Status = integrations.StatusBroken })

	res, err := h.svc.TestWebhook(context.Background(), testUser, testForm, w.ID)
	if err != nil {
		t.Fatalf("проверка: %v", err)
	}
	if !res.OK {
		t.Fatalf("проверка не прошла: %+v", res)
	}
	if len(h.notes.cleared) != 1 || h.notes.cleared[0] != w.ID {
		t.Fatalf("отбой не сработал: %v", h.notes.cleared)
	}
}

// Новый адрес (даже тот же самый) снимает поломку — значит, и повод о ней.
func TestWebhookURLResaved_ClearsNotice(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	w, _ := h.hook(t, 0)
	h.store.editAny(w.ID, func(x *integrations.Webhook) { x.Status = integrations.StatusBroken })

	url := testHookURL
	err := h.svc.UpdateWebhook(context.Background(), testUser, testForm, w.ID,
		integrations.WebhookPatch{URL: &url})
	if err != nil {
		t.Fatalf("правка адреса: %v", err)
	}
	if len(h.notes.cleared) != 1 || h.notes.cleared[0] != w.ID {
		t.Fatalf("отбой не сработал: %v", h.notes.cleared)
	}
}

// Правка ИМЕНИ поломку не лечит и повода не снимает: цель как не принимала, так
// и не принимает.
func TestWebhookRenamed_KeepsNotice(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	w, _ := h.hook(t, 0)
	h.store.editAny(w.ID, func(x *integrations.Webhook) { x.Status = integrations.StatusBroken })

	name := "CRM отдела продаж"
	err := h.svc.UpdateWebhook(context.Background(), testUser, testForm, w.ID,
		integrations.WebhookPatch{Name: &name})
	if err != nil {
		t.Fatalf("переименование: %v", err)
	}
	if len(h.notes.cleared) != 0 {
		t.Fatalf("переименование сняло повод о поломке: %v", h.notes.cleared)
	}
}

// Удаление вебхука снимает повод — по тому же доводу, что у связки.
func TestDeleteWebhook_ClearsNotice(t *testing.T) {
	h := newDeliveryHarness(t, http.StatusOK)
	w, _ := h.hook(t, 0)

	if err := h.svc.DeleteWebhook(context.Background(), testUser, testForm, w.ID); err != nil {
		t.Fatalf("удаление: %v", err)
	}
	if len(h.notes.cleared) != 1 || h.notes.cleared[0] != w.ID {
		t.Fatalf("отбой не сработал: %v", h.notes.cleared)
	}
}

// Сборка без уведомлений доставку не ломает: поводов просто не бывает.
func TestDelivery_WithoutNotifications(t *testing.T) {
	store := &fakeStore{link: noticedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: append(headerOf(linkedSheet()), "Моя колонка")}
	columns := append(linkedSheet().Columns, col("b3", "Телефон"))
	subs := &fakeSubmissions{page: onePage(columns, "018f", "Ирина", "i@example.com", "+7")}

	deliverSheets(t, deliveryService(store, provider, subs))

	if store.brokenWith == "" {
		t.Fatal("связка не сломалась — сценарий не тот")
	}
}

// Переезд связки на другую таблицу лечит поломку записью самой цели — значит,
// снимает и повод. Без переноса накопленных (тумблер по умолчанию выключен) —
// то есть самым обычным путём починки.
func TestRetargetWithoutBackfill_ClearsNotice(t *testing.T) {
	link := noticedSheet()
	link.SpreadsheetID, link.SheetID = "ss-old", 5
	store := &fakeStore{link: link, conn: sealedConn(t)}
	notes := &fakeNotes{}
	svc := newFormService(fakeAccess{}, store,
		fakeForms{form: linkedForm(), version: json.RawMessage(oneQuestionSchema)}, &fakeProvider{}).
		WithNotifications(notes)

	err := svc.UpdateConnection(context.Background(), testUser, testForm, link.ID,
		integrations.ConnectionPatch{
			Name:   "Новый лист",
			Target: integrations.ConnectOptions{SpreadsheetID: "", Backfill: false},
		})
	if err != nil {
		t.Fatalf("переезд: %v", err)
	}
	if store.retargeted == nil {
		t.Fatal("связка не переехала — сценарий не тот")
	}
	if len(notes.cleared) != 1 || notes.cleared[0] != link.ID {
		t.Fatalf("отбой не сработал: %v", notes.cleared)
	}
}

// Отключение аккаунта уносит связки каскадом БД — поводы о них гаснут явно: у
// строки уведомления внешнего ключа на цель нет, и сама она не ушла бы.
func TestDisconnectAccount_ClearsNoticesOfItsLinks(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	store := &fakeStore{conn: sealedConn(t), accountLinks: []uuid.UUID{first, second}}
	notes := &fakeNotes{}
	svc := newFormService(fakeAccess{}, store, fakeForms{}, &fakeProvider{}).
		WithNotifications(notes)

	if err := svc.Disconnect(context.Background(), integrations.ProviderGoogle, testUser, uuid.New()); err != nil {
		t.Fatalf("отключение аккаунта: %v", err)
	}
	if len(notes.cleared) != 2 || notes.cleared[0] != first || notes.cleared[1] != second {
		t.Fatalf("погашены поводы %v, ожидались обе связки аккаунта", notes.cleared)
	}
}
