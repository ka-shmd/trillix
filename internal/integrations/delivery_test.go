package integrations_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/integrations"
	"github.com/ka-shmd/trillix/internal/submissions"
)

// fakeSubmissions — строки ответов, которые доставщик просит у модуля ответов.
//
// page отдаётся целиком: доставщик сам разбирает, какие из запрошенных id в ней
// вернулись, а какие нет (удалён автором либо скрыт тарифом).
type fakeSubmissions struct {
	page submissions.SheetPage
	err  error
	// asked — за какими ответами ходили: тесты порядка проверяют, что список
	// приехал из очереди и в её порядке.
	asked []uuid.UUID
	// webhook — тело ответа для вебхука; webhookErr перебивает его.
	webhook    submissions.WebhookRecord
	webhookErr error
}

func (f *fakeSubmissions) WebhookRow(_ context.Context, _, _ uuid.UUID) (submissions.WebhookRecord, error) {
	if f.webhookErr != nil {
		return submissions.WebhookRecord{}, f.webhookErr
	}
	return f.webhook, nil
}

func (f *fakeSubmissions) SheetRows(_ context.Context, _ uuid.UUID, ids []uuid.UUID) (submissions.SheetPage, error) {
	if f.err != nil {
		return submissions.SheetPage{}, f.err
	}
	f.asked = append(f.asked, ids...)
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
		Enabled:       true,
		Status:        integrations.StatusLive,
		Columns:       []domain.SheetColumn{col("_id", "ID ответа"), col("b1", "Имя"), col("b2", "Почта")},
	}
}

func brokenLink() integrations.FormLink {
	l := linkedSheet()
	l.Status = integrations.StatusBroken
	return l
}

func disabledLink() integrations.FormLink {
	l := linkedSheet()
	l.Enabled = false
	return l
}

var testSubmission = uuid.MustParse("00000000-0000-7000-8000-000000000004")

// headerOf — шапка листа, совпадающая с колонками связки: обычное состояние,
// пока автор её не трогал.
func headerOf(link integrations.FormLink) []string {
	out := make([]string, 0, len(link.Columns))
	for _, c := range link.Columns {
		out = append(out, c.Label)
	}
	return out
}

// liveQueue — очередь из одного живого ответа: то, что кладёт в неё ветка CTE
// приёма.
func liveQueue() []integrations.QueuedSheetRow {
	return []integrations.QueuedSheetRow{{SubmissionID: testSubmission}}
}

// onePage — пачка из одной строки под тот же ответ.
func onePage(columns []domain.SheetColumn, values ...string) submissions.SheetPage {
	return submissions.SheetPage{
		Columns: columns,
		Rows:    []submissions.SheetRow{{ID: testSubmission, Values: values}},
	}
}

func deliveryService(store *fakeStore, provider *fakeProvider, subs *fakeSubmissions) *integrations.Service {
	return newFormService(fakeAccess{}, store, fakeForms{}, provider).WithDelivery(subs)
}

// deliverSheets гоняет один проход доставщика. Ошибка здесь означает отказ
// ВЫБОРКИ целей; отказ конкретной связки ею не считается — он лежит в её
// расписании и в журнале.
func deliverSheets(t *testing.T, svc *integrations.Service) int {
	t.Helper()
	n, err := svc.DeliverSheets(context.Background())
	if err != nil {
		t.Fatalf("проход доставщика: %v", err)
	}
	return n
}

// Человека сняли с пространства — связка его аккаунтом останавливается и
// краснеет, а не льёт ответы команды в Диск бывшего участника.
//
// Это плата за личные аккаунты, названная в ADR §10 и закрытая сторожем: без
// него снятие доступа не останавливало бы поток наружу вовсе.
func TestDeliverSheets_StopsWhenAccountOwnerLeftWorkspace(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Ирина", "i@example.com")}
	svc := newFormService(fakeAccess{gone: true}, store, fakeForms{}, provider).WithDelivery(subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 0 {
		t.Fatalf("ответ уехал в Диск бывшего участника: %v", provider.appended)
	}
	if store.brokenWith == "" {
		t.Fatal("связка не помечена сломанной — владелец не узнает причину")
	}
	if len(store.queue) != 1 {
		t.Error("ответ снят с очереди: починка связки его больше не увезёт")
	}
}

// Тот же сторож обязан останавливать и ПЕРЕНОС: догрузка ушедшего участника —
// та же утечка, только пачкой. Проверяется отдельно: сторож стоит выше разбора
// строк, и уронить его туда, где он смотрит только на живые, слишком легко.
func TestDeliverSheets_GuardCoversBackfillRows(t *testing.T) {
	store := &fakeStore{
		link:  linkedSheet(),
		conn:  sealedConn(t),
		queue: []integrations.QueuedSheetRow{{SubmissionID: testSubmission, Backfill: true}},
	}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{gone: true}, store, fakeForms{}, provider).
		WithDelivery(&fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Ирина", "i@example.com")})

	deliverSheets(t, svc)

	if len(provider.appended) != 0 {
		t.Fatalf("перенос уехал в Диск бывшего участника: %v", provider.appended)
	}
	if store.brokenWith == "" {
		t.Fatal("связка не помечена сломанной")
	}
}

// Ответ доезжает строкой в порядке КОЛОНОК ЛИСТА, снимается с очереди, и связка
// помечается доставленной.
func TestDeliverSheets_AppendsRow(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Ирина", "i@example.com")}
	svc := deliveryService(store, provider, subs)

	if n := deliverSheets(t, svc); n != 1 {
		t.Fatalf("доставлено строк: %d, ожидалась одна", n)
	}
	if len(provider.appended) != 1 {
		t.Fatalf("дописано строк: %d, ожидалась одна", len(provider.appended))
	}
	got := provider.appended[0]
	if len(got) != 3 || got[1] != "Ирина" || got[2] != "i@example.com" {
		t.Fatalf("строка = %v", got)
	}
	if !store.delivered {
		t.Error("связка не помечена доставленной")
	}
	if len(store.queue) != 0 {
		t.Error("доставленный ответ остался в очереди — он уедет вторым разом")
	}
}

// Вся пачка тика уезжает ОДНИМ запросом. Это не оптимизация: у Google 60
// запросов в минуту на пользователя, и перенос накопленных поштучно упёрся бы в
// лимит на первой же сотне.
func TestDeliverSheets_BatchGoesInOneRequest(t *testing.T) {
	link := linkedSheet()
	queue := make([]integrations.QueuedSheetRow, 0, 50)
	rows := make([]submissions.SheetRow, 0, 50)
	for i := 0; i < 50; i++ {
		id := uuid.New()
		queue = append(queue, integrations.QueuedSheetRow{SubmissionID: id, Backfill: true})
		rows = append(rows, submissions.SheetRow{ID: id, Values: []string{id.String(), "Имя", "a@b.c"}})
	}
	store := &fakeStore{link: link, conn: sealedConn(t), queue: queue}
	provider := &fakeProvider{header: headerOf(link)}
	subs := &fakeSubmissions{page: submissions.SheetPage{Columns: link.Columns, Rows: rows}}
	svc := deliveryService(store, provider, subs)

	if n := deliverSheets(t, svc); n != 50 {
		t.Fatalf("доставлено строк: %d, ожидалось 50", n)
	}
	if provider.appendCalls != 1 {
		t.Fatalf("запросов к Google: %d, ожидался один на всю пачку", provider.appendCalls)
	}
	if len(store.queue) != 0 {
		t.Errorf("в очереди осталось %d строк", len(store.queue))
	}
}

// Порядок строк в листе — это порядок ОЧЕРЕДИ: сначала накопленные, следом
// живой ответ, пришедший позже. Ради этого очередь и заводилась: в общем outbox
// порядок между событиями не гарантирован ничем.
func TestDeliverSheets_FollowsQueueOrder(t *testing.T) {
	link := linkedSheet()
	old1, old2 := uuid.New(), uuid.New()
	store := &fakeStore{link: link, conn: sealedConn(t), queue: []integrations.QueuedSheetRow{
		{SubmissionID: old1, Backfill: true},
		{SubmissionID: old2, Backfill: true},
		{SubmissionID: testSubmission},
	}}
	provider := &fakeProvider{header: headerOf(link)}
	// Модуль ответов отдаёт строки в СВОЁМ порядке — раскладывать их обязан
	// доставщик, иначе хронология в листе зависела бы от плана запроса.
	subs := &fakeSubmissions{page: submissions.SheetPage{Columns: link.Columns, Rows: []submissions.SheetRow{
		{ID: testSubmission, Values: []string{"новый", "Новый", "n@b.c"}},
		{ID: old2, Values: []string{"второй", "Второй", "s@b.c"}},
		{ID: old1, Values: []string{"первый", "Первый", "f@b.c"}},
	}}}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 3 {
		t.Fatalf("строк в листе %d, ждали три", len(provider.appended))
	}
	want := []string{"первый", "второй", "новый"}
	for i, w := range want {
		if provider.appended[i][0] != w {
			t.Fatalf("строка %d = %v, ждали %q — порядок листа разошёлся с очередью", i, provider.appended[i], w)
		}
	}
}

// В форме появился новый вопрос: колонка добавляется в конец, шапка листа
// переписывается, порядок прежних колонок не меняется.
func TestDeliverSheets_AddsColumnForNewQuestion(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: headerOf(linkedSheet())}
	columns := append(linkedSheet().Columns, col("b3", "Телефон"))
	subs := &fakeSubmissions{page: onePage(columns, "018f", "Ирина", "i@example.com", "+7")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.header) != 4 || provider.header[3] != "Телефон" {
		t.Fatalf("шапка = %v, ожидалась дописанная колонка", provider.header)
	}
	got := provider.appended[0]
	if len(got) != 4 || got[3] != "+7" {
		t.Fatalf("строка = %v", got)
	}
	if len(store.columnsSet) != 4 || store.columnsSet[3].Key != "b3" {
		t.Fatalf("колонки связки = %+v", store.columnsSet)
	}
}

// Автор переставил колонки местами — строка раскладывается по ШАПКЕ, а не по
// запомненному порядку, и новый порядок запоминается.
func TestDeliverSheets_FollowsReorderedHeader(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: []string{"ID ответа", "Почта", "Имя"}}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Ирина", "i@example.com")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	got := provider.appended[0]
	if len(got) != 3 || got[1] != "i@example.com" || got[2] != "Ирина" {
		t.Fatalf("строка = %v, ожидался порядок ШАПКИ, а не запомненный", got)
	}
	if len(store.columnsSet) != 3 || store.columnsSet[1].Key != "b2" {
		t.Fatalf("колонки = %+v, ожидался сохранённый порядок листа", store.columnsSet)
	}
	if provider.header != nil {
		t.Errorf("шапка переписана поверх авторской: %v", provider.header)
	}
}

// Автор убрал колонку из листа — она не возвращается. В своей таблице
// распоряжается он; «колонка только добавляется» — это про вопросы формы, а не
// про правки автора.
func TestDeliverSheets_FollowsDeletedColumn(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: []string{"ID ответа", "Почта"}}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Ирина", "i@example.com")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	got := provider.appended[0]
	if len(got) != 2 || got[1] != "i@example.com" {
		t.Fatalf("строка = %v, ожидались две колонки по шапке", got)
	}
}

// Своя колонка автора СПРАВА от наших законна: в неё мы просто не пишем, строка
// выходит короче ширины листа.
func TestDeliverSheets_LeavesAlienTailAlone(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: append(headerOf(linkedSheet()), "Местное время")}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Ирина", "i@example.com")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 1 || len(provider.appended[0]) != 3 {
		t.Fatalf("строка = %v, ожидались три ячейки без захода в чужую колонку", provider.appended)
	}
	if provider.header != nil {
		t.Errorf("шапка переписана поверх чужой колонки: %v", provider.header)
	}
}

// Новую колонку некуда дописать: справа стоит колонка автора. Отказ
// окончательный, и текст зовёт перезалить, а не «вернуть шапку».
func TestDeliverSheets_NoRoomForNewColumnTellsToRefill(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: append(headerOf(linkedSheet()), "Моя колонка")}
	columns := append(linkedSheet().Columns, col("b3", "Телефон"))
	subs := &fakeSubmissions{page: onePage(columns, "018f", "Ирина", "i@example.com", "+7")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 0 {
		t.Fatalf("строка записана поверх чужой колонки: %v", provider.appended)
	}
	if !strings.Contains(store.brokenWith, "колонка") {
		t.Fatalf("причина = %q, ожидался рассказ про колонку", store.brokenWith)
	}
}

// Чужая колонка ПОСЕРЕДИНЕ наших — раскладка, за которой следовать нельзя:
// append умеет только сплошную строку от колонки A.
func TestDeliverSheets_RefusesAlienColumnInTheMiddle(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: []string{"ID ответа", "Моя колонка", "Имя", "Почта"}}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Ирина", "i@example.com")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 0 {
		t.Fatalf("строка записана в лист с чужой колонкой посередине: %v", provider.appended)
	}
	if store.brokenWith == "" {
		t.Fatal("связка не покраснела")
	}
}

// Два вопроса с ОДИНАКОВОЙ подписью на нетронутом листе доставляются: позиции
// различимы всегда, и разбор по подписи для этого случая не нужен вовсе.
func TestDeliverSheets_DuplicateLabelsOnUntouchedSheet(t *testing.T) {
	link := linkedSheet()
	link.Columns = []domain.SheetColumn{col("_id", "ID ответа"), col("b1", "Имя"), col("b2", "Имя")}
	store := &fakeStore{link: link, conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: headerOf(link)}
	subs := &fakeSubmissions{page: onePage(link.Columns, "018f", "Ирина", "Петрова")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 1 {
		t.Fatalf("форма с двумя одинаковыми подписями не доставлена: %v", store.brokenWith)
	}
	if got := provider.appended[0]; got[1] != "Ирина" || got[2] != "Петрова" {
		t.Fatalf("строка = %v", got)
	}
}

// А вот переставленная шапка с двумя одинаковыми подписями двусмысленна:
// угадывать нельзя, отказываем.
func TestDeliverSheets_RefusesAmbiguousHeaderLabels(t *testing.T) {
	link := linkedSheet()
	link.Columns = []domain.SheetColumn{col("_id", "ID ответа"), col("b1", "Имя"), col("b2", "Имя")}
	store := &fakeStore{link: link, conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: []string{"Имя", "ID ответа", "Имя"}}
	subs := &fakeSubmissions{page: onePage(link.Columns, "018f", "Ирина", "Петрова")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 0 {
		t.Fatalf("строка записана по догадке: %v", provider.appended)
	}
	if store.brokenWith == "" {
		t.Fatal("связка не покраснела на двусмысленной шапке")
	}
}

// Вопрос удалили из формы: его колонка в листе остаётся, а ячейка пустеет —
// иначе значения уехали бы на одну влево, под чужой заголовок.
func TestDeliverSheets_KeepsColumnOfDeletedQuestion(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: headerOf(linkedSheet())}
	subs := &fakeSubmissions{page: onePage(
		[]domain.SheetColumn{col("_id", "ID ответа"), col("b2", "Почта")}, "018f", "i@example.com")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	got := provider.appended[0]
	if len(got) != 3 || got[1] != "" || got[2] != "i@example.com" {
		t.Fatalf("строка = %v, ожидалась пустая ячейка на месте удалённого вопроса", got)
	}
	if store.columnsSet != nil {
		t.Errorf("колонки переписаны: %+v — удалённый вопрос не должен их менять", store.columnsSet)
	}
}

// Окончательный отказ (доступ отозван) ломает связку. Очередь при этом
// ОСТАЁТСЯ: ответы копятся до починки, и она увезёт их по порядку. В общем
// outbox такое событие приходилось гасить — вернуть его было нечем.
func TestDeliverSheets_PermanentFailureMarksBroken(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{appendErr: integrations.ErrPermanent}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Аня", "a@b.c")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if store.brokenWith == "" {
		t.Fatal("связка не помечена сломанной")
	}
	if store.delivered {
		t.Error("сломанная доставка помечена успешной")
	}
	if len(store.queue) != 1 {
		t.Error("ответ снят с очереди: после починки он уже не уедет")
	}
}

// Временный отказ усыпляет СВЯЗКУ до следующего окна и НЕ ломает её: лежащий
// лист получает одну попытку за окно бэкоффа, сколько бы ответов ни ждало.
func TestDeliverSheets_TransientFailureSleepsTheLink(t *testing.T) {
	link := linkedSheet()
	link.ConsecutiveFailures = 2
	store := &fakeStore{link: link, conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{appendErr: errors.New("статус 503")}
	subs := &fakeSubmissions{page: onePage(link.Columns, "018f", "Аня", "a@b.c")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if store.brokenWith != "" {
		t.Errorf("связка сломана из-за временного отказа: %q", store.brokenWith)
	}
	if store.failedWith == "" {
		t.Fatal("неудача не записана — связку возьмут тем же тиком снова")
	}
	// Третья неудача подряд: минута, две, четыре.
	if want := 4 * integrations.SheetBackoffBase; store.nextAttempt.Sub(store.failingSince) != want {
		t.Errorf("пауза = %s, ждали %s", store.nextAttempt.Sub(store.failingSince), want)
	}
	if len(store.queue) != 1 {
		t.Error("ответ снят с очереди при временном отказе")
	}
}

// Сутки неудач подряд — связка считается сломанной, даже если каждый отдельный
// отказ был временным. Отсчёт идёт от ПЕРВОЙ неудачи подряд, иначе он не
// наступит никогда.
func TestDeliverSheets_DayOfFailuresBreaksTheLink(t *testing.T) {
	now := time.Now()
	link := linkedSheet()
	link.FailingSince = now.Add(-integrations.SheetBrokenAfter - time.Minute)
	link.ConsecutiveFailures = 40
	store := &fakeStore{link: link, conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{appendErr: errors.New("статус 503")}
	subs := &fakeSubmissions{page: onePage(link.Columns, "018f", "Аня", "a@b.c")}
	svc := deliveryService(store, provider, subs).WithClock(func() time.Time { return now })

	deliverSheets(t, svc)

	if store.brokenWith == "" {
		t.Fatal("сутки отказов не сломали связку — доставщик будет стучаться вечно")
	}
	if !strings.Contains(store.brokenWith, "суток") {
		t.Errorf("причина = %q, ожидался рассказ про сутки", store.brokenWith)
	}
}

// Ответ удалён автором или скрыт тарифом: везти нечего — строка снимается с
// очереди со следом в журнале, а не держит связку занятой вечно.
func TestDeliverSheets_DropsAnswerThatIsGone(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{}
	// Модуль ответов вернул пустую пачку: запрошенного ответа в ней нет.
	subs := &fakeSubmissions{page: submissions.SheetPage{Columns: linkedSheet().Columns}}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 0 {
		t.Fatalf("в таблицу что-то записано: %v", provider.appended)
	}
	if len(store.queue) != 0 {
		t.Fatal("ответ, которого нет, остался в очереди навсегда")
	}
	if len(store.deliveries) != 1 || store.deliveries[0].Outcome != integrations.OutcomeSkipped {
		t.Fatalf("журнал = %+v, ждали одну запись «не повезли»", store.deliveries)
	}
}

// Выключенная и сломанная связки доставщиком НЕ берутся: в первую ответы не
// встают вовсе, во второй копятся до починки.
func TestDeliverSheets_SkipsLinksThatAreNotDue(t *testing.T) {
	for _, c := range []struct {
		name string
		link integrations.FormLink
	}{
		{"связка выключена", disabledLink()},
		{"связка сломана", brokenLink()},
	} {
		t.Run(c.name, func(t *testing.T) {
			store := &fakeStore{link: c.link, conn: sealedConn(t), queue: liveQueue()}
			provider := &fakeProvider{}
			svc := deliveryService(store, provider, &fakeSubmissions{})

			deliverSheets(t, svc)

			if len(provider.appended) != 0 {
				t.Fatalf("в таблицу что-то записано: %v", provider.appended)
			}
			if len(store.deliveries) != 0 {
				t.Fatalf("в журнал что-то записано: %+v", store.deliveries)
			}
		})
	}
}

// Журнал: живой ответ даёт СВОЮ строку, перенос — одну строку на всю пачку.
// «Уехало двести ответов» это одна запись ленты, а не двести.
func TestDeliverSheets_LogsLiveRowsOneByOneAndBackfillAsBatch(t *testing.T) {
	link := linkedSheet()
	old1, old2 := uuid.New(), uuid.New()
	store := &fakeStore{link: link, conn: sealedConn(t), queue: []integrations.QueuedSheetRow{
		{SubmissionID: old1, Backfill: true},
		{SubmissionID: old2, Backfill: true},
		{SubmissionID: testSubmission},
	}}
	provider := &fakeProvider{header: headerOf(link)}
	subs := &fakeSubmissions{page: submissions.SheetPage{Columns: link.Columns, Rows: []submissions.SheetRow{
		{ID: old1, Values: []string{"a", "Аня", "a@b.c"}},
		{ID: old2, Values: []string{"b", "Боря", "b@b.c"}},
		{ID: testSubmission, Values: []string{"c", "Вера", "c@b.c"}},
	}}}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(store.deliveries) != 2 {
		t.Fatalf("записей в журнале %d, ждали две: %+v", len(store.deliveries), store.deliveries)
	}
	live, batch := store.deliveries[0], store.deliveries[1]
	if live.Kind != integrations.DeliveryKindSubmission || live.SubmissionID != testSubmission || live.RowCount != 1 {
		t.Errorf("запись живого ответа = %+v", live)
	}
	if batch.Kind != integrations.DeliveryKindBackfill || batch.SubmissionID != uuid.Nil || batch.RowCount != 2 {
		t.Errorf("запись переноса = %+v, ждали пачку из двух без id ответа", batch)
	}
}

// Журнал доставок: у каждой попытки свой исход, и он попадает в ленту связки.
// Проверяется исход, а не текст: тексты правятся, а вопрос «что стало с этим
// ответом» — нет.
func TestDeliverSheets_WritesDeliveryLog(t *testing.T) {
	cases := []struct {
		name     string
		provide  func() *fakeProvider
		subs     func() *fakeSubmissions
		outcome  string
		wantText bool
	}{
		{
			name:    "доставлено",
			provide: func() *fakeProvider { return &fakeProvider{header: headerOf(linkedSheet())} },
			subs: func() *fakeSubmissions {
				return &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Аня", "a@b.c")}
			},
			outcome: integrations.OutcomeDelivered,
		},
		{
			name:    "окончательный отказ",
			provide: func() *fakeProvider { return &fakeProvider{appendErr: integrations.ErrPermanent} },
			subs: func() *fakeSubmissions {
				return &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Аня", "a@b.c")}
			},
			outcome:  integrations.OutcomeFailed,
			wantText: true,
		},
		{
			name:    "временный отказ",
			provide: func() *fakeProvider { return &fakeProvider{appendErr: errors.New("статус 503")} },
			subs: func() *fakeSubmissions {
				return &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Аня", "a@b.c")}
			},
			outcome:  integrations.OutcomeFailed,
			wantText: true,
		},
		{
			name:    "ответа больше нет",
			provide: func() *fakeProvider { return &fakeProvider{} },
			subs: func() *fakeSubmissions {
				return &fakeSubmissions{page: submissions.SheetPage{Columns: linkedSheet().Columns}}
			},
			outcome:  integrations.OutcomeSkipped,
			wantText: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
			svc := deliveryService(store, c.provide(), c.subs())

			deliverSheets(t, svc)

			if len(store.deliveries) != 1 {
				t.Fatalf("записей в журнале %d, ждали одну: %+v", len(store.deliveries), store.deliveries)
			}
			got := store.deliveries[0]
			if got.Outcome != c.outcome {
				t.Errorf("исход = %q, ждали %q (текст: %q)", got.Outcome, c.outcome, got.Detail)
			}
			if got.LinkID != store.link.ID {
				t.Errorf("запись адресована связке %s вместо %s", got.LinkID, store.link.ID)
			}
			if got.Kind != integrations.DeliveryKindSubmission || got.SubmissionID != testSubmission {
				t.Errorf("предмет попытки = %q/%s", got.Kind, got.SubmissionID)
			}
			if c.wantText && got.Detail == "" {
				t.Error("неуспех без текста: автору формы нечего прочитать")
			}
		})
	}
}

// ⚠ Мина: отказ ЗАПИСИ В ЖУРНАЛ не имеет права уронить доставку. Уронит — и
// успешно уехавшая пачка вернётся по бэкоффу и ляжет в чужой лист вторым разом
// (у values.append нет идемпотентности).
func TestDeliverSheets_LogFailureDoesNotBreakDelivery(t *testing.T) {
	store := &fakeStore{
		link: linkedSheet(), conn: sealedConn(t), queue: liveQueue(),
		deliveryLogErr: errors.New("база недоступна"),
	}
	provider := &fakeProvider{header: headerOf(linkedSheet())}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Аня", "a@b.c")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(provider.appended) != 1 {
		t.Fatalf("строк в листе %d, ждали одну", len(provider.appended))
	}
	if !store.delivered {
		t.Error("доставка не помечена успешной")
	}
	if len(store.queue) != 0 {
		t.Error("доставленный ответ остался в очереди — он уедет вторым разом")
	}
}

// Ответ, прождавший дольше срока хранения, снимается с очереди СО СТРОКОЙ В
// ЖУРНАЛЕ: «не доставлен» — это исход, а не отсутствие записи.
func TestCleanupSheetQueue_WritesOffExpiredAnswers(t *testing.T) {
	link := linkedSheet()
	// Строка реально лежит в очереди и реально стара: уборщик снимает её той же
	// границей, по которой признал просроченной.
	store := &fakeStore{
		link: link, conn: sealedConn(t),
		queue: []integrations.QueuedSheetRow{{
			SubmissionID: testSubmission,
			EnqueuedAt:   time.Now().Add(-integrations.SheetQueueTTL - time.Hour),
		}},
		expired: []integrations.SheetQueueRef{{LinkID: link.ID, SubmissionID: testSubmission}},
	}
	svc := deliveryService(store, &fakeProvider{}, &fakeSubmissions{})

	n, err := svc.CleanupSheetQueue(context.Background())
	if err != nil {
		t.Fatalf("уборка очереди: %v", err)
	}
	if n != 1 {
		t.Fatalf("снято строк: %d, ждали одну", n)
	}
	if len(store.dropped) != 1 || store.dropped[0] != testSubmission {
		t.Errorf("с очереди снято: %v", store.dropped)
	}
	if len(store.deliveries) != 1 || store.deliveries[0].Outcome != integrations.OutcomeFailed {
		t.Fatalf("журнал = %+v, ждали запись о невозможной доставке", store.deliveries)
	}
}

// Уборка журнала зовётся с границей «сейчас минус срок хранения»: перепутанный
// знак вычистил бы вместо старых записей все, кроме них.
func TestCleanupDeliveries_UsesRetentionBorder(t *testing.T) {
	store := &fakeStore{}
	svc := deliveryService(store, &fakeProvider{}, &fakeSubmissions{})

	if _, err := svc.CleanupDeliveries(context.Background()); err != nil {
		t.Fatalf("уборка: %v", err)
	}
	want := time.Now().UTC().Add(-integrations.DeliveryTTL)
	if diff := store.deletedBefore.Sub(want); diff > time.Minute || diff < -time.Minute {
		t.Fatalf("граница уборки = %s, ждали около %s", store.deletedBefore, want)
	}
}

// Отказ ТОКЕН-ручки убивает подключение целиком, и пометка ложится на аккаунт,
// а не только на связку, которая об этом узнала.
//
// Ради этого признак и заводился (задача владельца 2026-09-10): пока смерть
// согласия жила только в статусе связки, мёртвый аккаунт выглядел рабочим везде,
// кроме одной формы, где как раз упала доставка.
func TestDeliverSheets_AccessLostMarksAccount(t *testing.T) {
	store := &fakeStore{link: linkedSheet(), conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{refreshErr: integrations.ErrAccessLost}
	subs := &fakeSubmissions{page: onePage(linkedSheet().Columns, "018f", "Аня", "a@b.c")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if store.accessLostAt.IsZero() {
		t.Fatal("подключение не помечено мёртвым — в других формах оно останется зелёным")
	}
	if store.brokenWith == "" {
		t.Error("связка не покраснела")
	}
}

// ⚠ Беда ЛИСТА подключение не трогает. Автор переставил колонки — виновата одна
// таблица; пометить аккаунт значило бы соврать про все остальные формы и
// позвать человека переподключаться там, где переподключение ничего не лечит.
func TestDeliverSheets_SheetBreakLeavesAccountAlone(t *testing.T) {
	link := linkedSheet()
	store := &fakeStore{link: link, conn: sealedConn(t), queue: liveQueue()}
	provider := &fakeProvider{sheetHeader: []string{"ID ответа", "Моя колонка", "Имя", "Почта"}}
	subs := &fakeSubmissions{page: onePage(link.Columns, "018f", "Аня", "a@b.c")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if store.brokenWith == "" {
		t.Fatal("связка не покраснела — тест проверяет не тот случай")
	}
	if !store.accessLostAt.IsZero() {
		t.Fatal("подключение помечено мёртвым из-за беды одной таблицы")
	}
}

// Согласие вернули в самом Google — пометка гаснет на первом же удачном токене.
// Иначе красный аккаунт остался бы в кабинете навсегда.
func TestDeliverSheets_WorkingTokenClearsAccessLost(t *testing.T) {
	conn := sealedConn(t)
	conn.AccessLostAt = time.Now().Add(-time.Hour)
	link := linkedSheet()
	store := &fakeStore{link: link, conn: conn, accessLostAt: conn.AccessLostAt, queue: liveQueue()}
	provider := &fakeProvider{header: headerOf(link)}
	subs := &fakeSubmissions{page: onePage(link.Columns, "018f", "Аня", "a@b.c")}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if !store.accessLostAt.IsZero() {
		t.Fatal("пометка мёртвого подключения пережила удачную доставку")
	}
}

// Экран узнаёт о смерти согласия из пометки, а не из статуса связки: аккаунт
// требует переподключения ВЕЗДЕ, включая формы, где доставок ещё не было.
func TestStatus_AccessLostAsksToReconnect(t *testing.T) {
	conn := sealedConn(t)
	conn.AccessLostAt = time.Now().Add(-time.Hour)
	svc := deliveryService(&fakeStore{conn: conn}, &fakeProvider{}, &fakeSubmissions{})

	st, err := svc.Status(context.Background(), testUser)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if len(st.Accounts) != 1 || !st.Accounts[0].NeedsReconnect {
		t.Fatalf("аккаунты = %+v, ждали пометку «нужно переподключить»", st.Accounts)
	}
}

// ⚠ Повтор спрашивает судьбу ОТВЕТА, а не исход строки, по которой нажали.
//
// Строка журнала = одна попытка, и у ответа, доехавшего со второго раза
// (503 → бэкофф → успех), первая навсегда остаётся неудачной. Гейт по её исходу
// держал бы живую кнопку «Повторить» под ответом, который в таблице уже лежит.
func TestRetryDelivery_RefusesWhenAnswerAlreadyInSheet(t *testing.T) {
	link := linkedSheet()
	failed := integrations.Delivery{
		ID: uuid.New(), LinkID: link.ID, Kind: integrations.DeliveryKindSubmission,
		SubmissionID: testSubmission, Outcome: integrations.OutcomeFailed,
		Detail: "Записать в таблицу не удалось, попробуем ещё раз позже.",
	}
	// Та же строка ответа доехала следующей попыткой.
	ok := integrations.Delivery{
		ID: uuid.New(), LinkID: link.ID, Kind: integrations.DeliveryKindSubmission,
		SubmissionID: testSubmission, Outcome: integrations.OutcomeDelivered, RowCount: 1,
	}
	store := &fakeStore{link: link, conn: sealedConn(t), deliveries: []integrations.Delivery{failed, ok}}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{}).
		WithDelivery(&fakeSubmissions{})

	err := svc.RetryDelivery(context.Background(), testUser, testForm, link.ID, failed.ID)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ожидался отказ: ответ уже в таблице", err)
	}
	if len(store.queue) != 0 {
		t.Fatal("ответ поставлен в очередь — он ляжет в чужой лист вторым разом")
	}
}

// Повтор неудачи, которая ничем не кончилась, по-прежнему работает: гейт про
// доехавший ответ, а не про наличие неудачных строк.
func TestRetryDelivery_RepeatsWhenAnswerNeverArrived(t *testing.T) {
	link := linkedSheet()
	failed := integrations.Delivery{
		ID: uuid.New(), LinkID: link.ID, Kind: integrations.DeliveryKindSubmission,
		SubmissionID: testSubmission, Outcome: integrations.OutcomeFailed,
	}
	store := &fakeStore{link: link, conn: sealedConn(t), deliveries: []integrations.Delivery{failed}}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{}).
		WithDelivery(&fakeSubmissions{})

	if err := svc.RetryDelivery(context.Background(), testUser, testForm, link.ID, failed.ID); err != nil {
		t.Fatalf("повтор: %v", err)
	}
	if len(store.queue) != 1 || store.queue[0].SubmissionID != testSubmission {
		t.Fatalf("очередь = %+v, ответ не поставлен", store.queue)
	}
}

// Повтор в ВЫКЛЮЧЕННУЮ связку отказывает: доставщик её не берёт, и ответ висел
// бы в очереди, а экран показывал бы «в очереди 1» без движения.
func TestRetryDelivery_RefusesOnDisabledLink(t *testing.T) {
	link := disabledLink()
	failed := integrations.Delivery{
		ID: uuid.New(), LinkID: link.ID, Kind: integrations.DeliveryKindSubmission,
		SubmissionID: testSubmission, Outcome: integrations.OutcomeFailed,
	}
	store := &fakeStore{link: link, conn: sealedConn(t), deliveries: []integrations.Delivery{failed}}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, &fakeProvider{}).
		WithDelivery(&fakeSubmissions{})

	err := svc.RetryDelivery(context.Background(), testUser, testForm, link.ID, failed.ID)
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("ошибка = %v, ожидался отказ по выключенному тумблеру", err)
	}
	if len(store.queue) != 0 {
		t.Fatal("ответ поставлен в очередь выключенной связки")
	}
}

// Смерть подключения замечает ЛЮБОЙ поход к провайдеру, а не только доставка:
// перезалив, перепроверка, список таблиц идут тем же путём за токеном. Иначе
// знание об отзыве согласия зависело бы от того, каким путём мы за ним пошли.
func TestRefillForm_AccessLostMarksAccount(t *testing.T) {
	link := linkedSheet()
	store := &fakeStore{link: link, conn: sealedConn(t)}
	provider := &fakeProvider{refreshErr: integrations.ErrAccessLost}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, provider)

	if err := svc.RefillForm(context.Background(), testUser, testForm, link.ID); err == nil {
		t.Fatal("перезалив мёртвым аккаунтом прошёл успешно")
	}
	if store.accessLostAt.IsZero() {
		t.Fatal("подключение не помечено мёртвым — экран продолжит показывать его рабочим")
	}
}

// ⚠ Перезалив ОБЯЗАН снимать поломку, иначе он её усугубляет.
//
// Кнопка «Перезаписать лист» живёт только внутри предупреждения о поломке —
// другого входа в перезалив на экране нет. Доставщик сломанную связку не берёт
// вовсе, поэтому перезалив, не снявший статус, оставляет вычищенный лист,
// полную очередь и красную точку навсегда: через месяц уборщик спишет всю
// очередь строками «не доставлен». Найдено ревью диффа переезда на очередь.
func TestRefillForm_RevivesBrokenLink(t *testing.T) {
	link := brokenLink()
	link.LastError = "Google больше не принимает записи в эту таблицу."
	store := &fakeStore{link: link, conn: sealedConn(t)}
	provider := &fakeProvider{}
	svc := newFormService(fakeAccess{}, store, fakeForms{form: linkedForm()}, provider)

	if err := svc.RefillForm(context.Background(), testUser, testForm, link.ID); err != nil {
		t.Fatalf("перезалив: %v", err)
	}
	if provider.cleared == "" {
		t.Fatal("лист не вычищен — тест проверяет не тот случай")
	}
	if !store.errorCleared {
		t.Fatal("поломка не снята: доставщик такую связку не возьмёт, и перезалив оставит пустой лист")
	}
	if !store.queueCleared || store.backfilledForm != testForm {
		t.Error("очередь не пересобрана")
	}
}

// ⚠ Перезалив, успевший ПОКА ДОСТАВЩИК ХОДИЛ В GOOGLE, свою очередь сохраняет.
//
// Между чтением очереди и снятием доставленных лежат два-три сетевых запроса.
// Перезалив в этом окне ставит те же ответы заново — уже под новый лист, — и
// снятие «по id» унесло бы их: строки уехали бы в СТАРЫЙ лист, а в новый не
// попали бы вовсе. Границу держит enqueued_at. Найдено ревью диффа.
func TestDeliverSheets_RefillDuringTickKeepsItsQueue(t *testing.T) {
	link := linkedSheet()
	store := &fakeStore{link: link, conn: sealedConn(t), queue: []integrations.QueuedSheetRow{
		{SubmissionID: testSubmission, EnqueuedAt: time.Now().Add(-time.Minute)},
	}}
	provider := &fakeProvider{header: headerOf(link)}
	subs := &fakeSubmissions{page: onePage(link.Columns, "018f", "Аня", "a@b.c")}
	// Перезалив случается ровно в окне: провайдер зовёт его из середины прохода,
	// как это сделал бы человек, нажавший кнопку во время тика.
	provider.beforeAppend = func() {
		store.queue = []integrations.QueuedSheetRow{
			{SubmissionID: testSubmission, Backfill: true, EnqueuedAt: time.Now()},
		}
	}
	svc := deliveryService(store, provider, subs)

	deliverSheets(t, svc)

	if len(store.queue) != 1 {
		t.Fatalf("очередь = %+v, перезалив потерял свою строку — в новый лист ответ не попадёт", store.queue)
	}
	if !store.queue[0].Backfill {
		t.Error("снята строка перезалива, а осталась прочитанная доставщиком")
	}
}

// Уснувшая после неудачи связка тиком НЕ берётся: лежащий лист получает одну
// попытку за окно бэкоффа, сколько бы ответов ни ждало. Это весь смысл переезда
// на очередь по целям, и до ревью его не сторожил ни один тест.
func TestDeliverSheets_SleepingLinkIsNotTaken(t *testing.T) {
	now := time.Date(2026, 9, 12, 12, 0, 0, 0, time.UTC)
	link := linkedSheet()
	store := &fakeStore{link: link, conn: sealedConn(t), queue: liveQueue(), now: func() time.Time { return now }}
	provider := &fakeProvider{appendErr: errors.New("статус 503")}
	subs := &fakeSubmissions{page: onePage(link.Columns, "018f", "Аня", "a@b.c")}
	svc := deliveryService(store, provider, subs).WithClock(func() time.Time { return now })

	// Первый проход: отказ усыпляет связку на минуту.
	deliverSheets(t, svc)
	if provider.attempts != 1 || store.nextAttempt.IsZero() {
		t.Fatalf("первый проход не оставил расписания: попыток %d, next %v", provider.attempts, store.nextAttempt)
	}
	attempts := provider.attempts

	// Второй проход в ту же секунду: в спящую связку доставщик не идёт.
	deliverSheets(t, svc)
	if provider.attempts != attempts {
		t.Fatalf("попыток к Google стало %d — спящая связка взята тем же тиком", provider.attempts)
	}

	// Окно кончилось — связка снова в работе.
	now = now.Add(integrations.SheetBackoffBase + time.Second)
	deliverSheets(t, svc)
	if provider.attempts == attempts {
		t.Fatal("после окна бэкоффа связка так и не взята — она уснула навсегда")
	}
}
