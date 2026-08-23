package integrations_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/postgres"
	"github.com/ka-shmd/trillix/internal/submissions"
)

type fakeOutbox struct {
	channel string
	payload []byte
}

func (f *fakeOutbox) Enqueue(_ context.Context, _ postgres.DBTX, channel string, payload []byte) error {
	f.channel, f.payload = channel, payload
	return nil
}

type fakeSubmissions struct {
	record submissions.SheetRecord
	err    error
	// page — что отдаёт догрузка. pages вызывается по одной: вторая пачка
	// приходит уже другим событием, и тест проверяет именно это.
	page      submissions.SheetPage
	pageAfter uuid.UUID
	pageCalls int
}

func (f *fakeSubmissions) SheetRow(_ context.Context, _, _ uuid.UUID) (submissions.SheetRecord, error) {
	if f.err != nil {
		return submissions.SheetRecord{}, f.err
	}
	return f.record, nil
}

func (f *fakeSubmissions) SheetRows(_ context.Context, _ uuid.UUID, _ time.Time, after uuid.UUID, _ int32) (submissions.SheetPage, error) {
	if f.err != nil {
		return submissions.SheetPage{}, f.err
	}
	f.pageAfter = after
	f.pageCalls++
	return f.page, nil
}

func col(key, label string) domain.SheetColumn {
	return domain.SheetColumn{Key: key, Label: label}
}

// linkedSheet — привязка с тремя колонками: метаколонка и два вопроса.
func linkedSheet() integrations.FormLink {
	return integrations.FormLink{
		ID:            uuid.New(),
		FormID:        testForm,
		SpreadsheetID: "ss-1",
		SheetTitle:    "Ответы",
		Status:        integrations.StatusLive,
		Columns:       []domain.SheetColumn{col("_id", "ID ответа"), col("b1", "Имя"), col("b2", "Почта")},
	}
}

func deliveryService(store *fakeStore, provider *fakeProvider, subs *fakeSubmissions, out *fakeOutbox) *integrations.Service {
	return newFormService(fakeAccess{}, store, fakeForms{}, provider).WithDelivery(out, subs)
}

// Ответ доезжает строкой в порядке КОЛОНОК ЛИСТА, и привязка помечается
// доставленной.
func TestDeliver_AppendsRow(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t)}
	provider := &fakeProvider{}
	subs := &fakeSubmissions{record: submissions.SheetRecord{
		Columns: []domain.SheetColumn{col("_id", "ID ответа"), col("b1", "Имя"), col("b2", "Почта")},
		Row:     []string{"018f", "Ирина", "i@example.com"},
	}}
	svc := deliveryService(store, provider, subs, &fakeOutbox{})

	if err := svc.Deliver(context.Background(), payload(t, store.link.ID)); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if len(provider.appended) != 1 {
		t.Fatalf("дописано строк: %d, ожидалась одна", len(provider.appended))
	}
	got := provider.appended[0]
	if len(got) != 3 || got[1] != "Ирина" || got[2] != "i@example.com" {
		t.Fatalf("строка = %v", got)
	}
	if !store.delivered {
		t.Error("привязка не помечена доставленной")
	}
}

// В форме появился новый вопрос: колонка добавляется в конец, шапка листа
// переписывается, порядок прежних колонок не меняется.
func TestDeliver_AddsColumnForNewQuestion(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t)}
	provider := &fakeProvider{}
	subs := &fakeSubmissions{record: submissions.SheetRecord{
		Columns: []domain.SheetColumn{col("_id", "ID ответа"), col("b1", "Имя"), col("b2", "Почта"), col("b3", "Телефон")},
		Row:     []string{"018f", "Ирина", "i@example.com", "+7"},
	}}
	svc := deliveryService(store, provider, subs, &fakeOutbox{})

	if err := svc.Deliver(context.Background(), payload(t, store.link.ID)); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if len(store.columnsSet) != 4 || store.columnsSet[3].Key != "b3" {
		t.Fatalf("колонки = %+v, ожидалась дописанная b3", store.columnsSet)
	}
	if len(provider.header) != 4 || provider.header[3] != "Телефон" {
		t.Fatalf("шапка = %v", provider.header)
	}
	if got := provider.appended[0]; len(got) != 4 || got[3] != "+7" {
		t.Fatalf("строка = %v", got)
	}
}

// Вопрос удалён из формы: его колонка ОСТАЁТСЯ на месте с пустой ячейкой.
// Иначе значения уехали бы на одну влево — под чужой заголовок, и увидел бы это
// автор, а не мы.
func TestDeliver_KeepsColumnOfDeletedQuestion(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t)}
	provider := &fakeProvider{}
	subs := &fakeSubmissions{record: submissions.SheetRecord{
		Columns: []domain.SheetColumn{col("_id", "ID ответа"), col("b2", "Почта")},
		Row:     []string{"018f", "i@example.com"},
	}}
	svc := deliveryService(store, provider, subs, &fakeOutbox{})

	if err := svc.Deliver(context.Background(), payload(t, store.link.ID)); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	got := provider.appended[0]
	if len(got) != 3 || got[1] != "" || got[2] != "i@example.com" {
		t.Fatalf("строка = %v, ожидалась пустая ячейка на месте удалённого вопроса", got)
	}
	if store.columnsSet != nil {
		t.Errorf("колонки переписаны: %+v — удалённый вопрос не должен их менять", store.columnsSet)
	}
}

// Окончательный отказ провайдера (доступ отозван) помечает интеграцию сломанной
// и ГАСИТ событие: у outbox нет dead-letter, и ретрай тут вечен.
func TestDeliver_PermanentFailureMarksBroken(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t)}
	provider := &fakeProvider{appendErr: integrations.ErrPermanent}
	svc := deliveryService(store, provider, &fakeSubmissions{}, &fakeOutbox{})

	if err := svc.Deliver(context.Background(), payload(t, store.link.ID)); err != nil {
		t.Fatalf("окончательный отказ ушёл на ретрай: %v", err)
	}
	if store.brokenWith == "" {
		t.Fatal("интеграция не помечена сломанной")
	}
	if store.delivered {
		t.Error("сломанная доставка помечена успешной")
	}
}

// Временный отказ уходит на ретрай — и НЕ ломает интеграцию: провайдер полежит
// и встанет, а красный статус в кабинете напугал бы автора зря.
func TestDeliver_TransientFailureRetries(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t)}
	provider := &fakeProvider{appendErr: errors.New("статус 503")}
	svc := deliveryService(store, provider, &fakeSubmissions{}, &fakeOutbox{})

	if err := svc.Deliver(context.Background(), payload(t, store.link.ID)); err == nil {
		t.Fatal("временный отказ проглочен — событие потеряно")
	}
	if store.brokenWith != "" {
		t.Errorf("интеграция помечена сломанной из-за временного отказа: %q", store.brokenWith)
	}
}

// События, которые доставлять не надо, гасятся: сломанная интеграция, отвязанная
// форма, удалённый (или скрытый тарифом) ответ.
func TestDeliver_DropsHopelessEvents(t *testing.T) {
	cases := []struct {
		name  string
		store *fakeStore
		subs  *fakeSubmissions
	}{
		{"сломанная интеграция", &fakeStore{link: brokenLink()}, &fakeSubmissions{}},
		{"форму отвязали", &fakeStore{linkErr: pgx.ErrNoRows}, &fakeSubmissions{}},
		{"ответа больше нет", &fakeStore{link: linkedSheet()}, &fakeSubmissions{err: pgx.ErrNoRows}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			provider := &fakeProvider{}
			svc := deliveryService(c.store, provider, c.subs, &fakeOutbox{})

			if err := svc.Deliver(context.Background(), payload(t, uuid.New())); err != nil {
				t.Fatalf("событие ушло на ретрай: %v", err)
			}
			if len(provider.appended) != 0 {
				t.Fatalf("в таблицу что-то записано: %v", provider.appended)
			}
		})
	}
}

// Постановка события: привязанная форма даёт строку в канал таблиц, и адресуется
// она id ПРИВЯЗКИ — отвязка и новая привязка не должны получить старое событие.
func TestEnqueueSubmission_LinkedForm(t *testing.T) {
	store := &fakeStore{link: linkedSheet()}
	out := &fakeOutbox{}
	svc := deliveryService(store, &fakeProvider{}, &fakeSubmissions{}, out)

	if err := svc.EnqueueSubmission(context.Background(), testForm, testSubmission); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if out.channel != integrations.ChannelSheets {
		t.Fatalf("канал = %q", out.channel)
	}
	var got map[string]string
	if err := json.Unmarshal(out.payload, &got); err != nil {
		t.Fatalf("payload не разбирается: %v", err)
	}
	if got["linkId"] != store.link.ID.String() || got["submissionId"] != testSubmission.String() {
		t.Fatalf("payload = %v", got)
	}
}

// Форма не привязана — события нет вовсе: приём ответа не платит за интеграцию,
// которой у формы не заведено.
func TestEnqueueSubmission_UnlinkedForm(t *testing.T) {
	out := &fakeOutbox{}
	svc := deliveryService(&fakeStore{linkErr: pgx.ErrNoRows}, &fakeProvider{}, &fakeSubmissions{}, out)

	if err := svc.EnqueueSubmission(context.Background(), testForm, testSubmission); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if out.channel != "" {
		t.Fatalf("событие поставлено для непривязанной формы: %q", out.channel)
	}
}

func brokenLink() integrations.FormLink {
	l := linkedSheet()
	l.Status = integrations.StatusBroken
	l.LastError = "доступ отозван"
	return l
}

func payload(t *testing.T, linkID uuid.UUID) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]string{
		"linkId":       linkID.String(),
		"submissionId": testSubmission.String(),
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return raw
}

var testSubmission = uuid.MustParse("00000000-0000-7000-8000-000000000004")

// Догрузка идёт ПАЧКАМИ: полная пачка ставит следующее событие с курсором
// последней строки, а не обходит все двадцать тысяч ответов внутри одного
// вызова — диспетчер общий с почтой, и занять его на минуты нельзя.
func TestDeliverBackfill_FullBatchEnqueuesNext(t *testing.T) {
	link := linkedSheet()
	link.Status = integrations.StatusBackfilling
	link.BackfillBefore = time.Now()
	store := &fakeStore{link: link, conn: sealedConn(t)}
	provider := &fakeProvider{}
	subs := &fakeSubmissions{page: fullBackfillPage()}
	out := &fakeOutbox{}
	svc := deliveryService(store, provider, subs, out)

	if err := svc.Deliver(context.Background(), backfillPayload(t, link.ID, uuid.Nil)); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if provider.appendCalls != 1 {
		t.Fatalf("запросов к провайдеру: %d, ожидался один на пачку", provider.appendCalls)
	}
	if store.backfillDone {
		t.Error("перенос объявлен законченным на полной пачке")
	}

	var next map[string]any
	if err := json.Unmarshal(out.payload, &next); err != nil {
		t.Fatalf("следующее событие не поставлено: %v", err)
	}
	if next["backfill"] != true {
		t.Fatalf("следующее событие = %v, ожидалась пачка переноса", next)
	}
	last := subs.page.Rows[len(subs.page.Rows)-1].ID.String()
	if next["after"] != last {
		t.Fatalf("курсор = %v, ожидался %q", next["after"], last)
	}
}

// Неполная пачка — ответы кончились: перенос закрывается, и ждавшие живые
// события поедут своим чередом.
func TestDeliverBackfill_ShortBatchFinishes(t *testing.T) {
	link := linkedSheet()
	link.Status = integrations.StatusBackfilling
	store := &fakeStore{link: link, conn: sealedConn(t)}
	subs := &fakeSubmissions{page: submissions.SheetPage{
		Columns: linkedSheet().Columns,
		Rows:    []submissions.SheetRow{{ID: uuid.New(), Values: []string{"018f", "Ирина", "i@example.com"}}},
	}}
	out := &fakeOutbox{}
	svc := deliveryService(store, &fakeProvider{}, subs, out)

	if err := svc.Deliver(context.Background(), backfillPayload(t, link.ID, uuid.Nil)); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if !store.backfillDone {
		t.Fatal("перенос не закрыт на неполной пачке")
	}
	if out.channel != "" {
		t.Error("поставлено лишнее событие после конца переноса")
	}
}

// Живой ответ, пришедший во время переноса, ЖДЁТ в очереди: иначе он лёг бы в
// лист поверх старых строк и перевернул бы хронологию.
func TestDeliver_LiveEventWaitsForBackfill(t *testing.T) {
	link := linkedSheet()
	link.Status = integrations.StatusBackfilling
	store := &fakeStore{link: link, conn: sealedConn(t)}
	provider := &fakeProvider{}
	svc := deliveryService(store, provider, &fakeSubmissions{}, &fakeOutbox{})

	if err := svc.Deliver(context.Background(), payload(t, link.ID)); err == nil {
		t.Fatal("живое событие доставлено во время переноса")
	}
	if len(provider.appended) != 0 {
		t.Fatalf("в лист записано во время переноса: %v", provider.appended)
	}
}

// fullBackfillPage — пачка ровно в лимит: столько же, сколько просит догрузка,
// значит ответы, возможно, ещё есть.
func fullBackfillPage() submissions.SheetPage {
	rows := make([]submissions.SheetRow, integrations.BackfillBatch)
	for i := range rows {
		rows[i] = submissions.SheetRow{ID: uuid.New(), Values: []string{"id", "Имя", "почта"}}
	}
	return submissions.SheetPage{Columns: linkedSheet().Columns, Rows: rows}
}

func backfillPayload(t *testing.T, linkID, after uuid.UUID) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"linkId":   linkID.String(),
		"backfill": true,
		"after":    after.String(),
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return raw
}
