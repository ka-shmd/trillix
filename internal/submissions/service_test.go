package submissions

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/mail"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// fakeForms — коллаборатор forms с подставной опубликованной формой и владельцем.
type fakeForms struct {
	pf    forms.PublicForm
	owner forms.Owner
	// partialAllowed — разрешает ли тариф сбор незавершённых ответов.
	partialAllowed bool
	// owned — форма, доступ к которой у пользователя ЕСТЬ. nil (умолчание) =
	// чужая или несуществующая: Get и GetForAction отдают 404, и это верный
	// умолчательный случай для тестов анти-IDOR.
	owned *forms.Form
}

func (f fakeForms) PublicForm(context.Context, string) (forms.PublicForm, error) {
	return f.pf, nil
}

// CollectPartial повторяет правило сервиса: без тумблера сбора нет, с тумблером
// решает тариф. partialAllowed=false — план, который сбор больше не разрешает.
func (f fakeForms) CollectPartial(_ context.Context, _ uuid.UUID, intent bool) (bool, error) {
	return intent && f.partialAllowed, nil
}

func (f fakeForms) Get(context.Context, uuid.UUID, uuid.UUID) (forms.Form, error) {
	if f.owned == nil {
		return forms.Form{}, domain.ErrNotFound
	}
	return *f.owned, nil
}

func (f fakeForms) GetForAction(context.Context, uuid.UUID, uuid.UUID, domain.Action) (forms.Form, error) {
	if f.owned == nil {
		return forms.Form{}, domain.ErrNotFound
	}
	return *f.owned, nil
}

func (f fakeForms) Versions(context.Context, uuid.UUID, uuid.UUID) ([]forms.Version, error) {
	return nil, domain.ErrNotFound
}

func (f fakeForms) PublishedVersions(context.Context, uuid.UUID) ([]forms.Version, error) {
	return nil, domain.ErrNotFound
}

func (f fakeForms) SubmissionOwner(context.Context, uuid.UUID) (forms.Owner, error) {
	return f.owner, nil
}

// fakeTx выполняет тело транзакции без БД (fn получает nil pgx.Tx; фейки-репо и
// mailer исполнителя игнорируют).
type fakeTx struct{}

func (fakeTx) WithTx(ctx context.Context, fn func(pgx.Tx) error) error { return fn(nil) }

// fakeSubStore — submissions.Store: InsertSubmission отдаёт заданное число строк
// (0 = идемпотентный ретрай).
type fakeSubStore struct {
	Store
	insertN int64
	// lastInsert — что сервис отдал на вставку: тестам про квоту важна пометка
	// over_quota и период, в который поехал инкремент расхода.
	lastInsert NewSubmission
}

func (f *fakeSubStore) InsertSubmission(_ context.Context, _ postgres.DBTX, in NewSubmission) (int64, error) {
	f.lastInsert = in
	return f.insertN, nil
}

// fakePlans — управляемая проверка квоты. err != nil означает «спросить не
// удалось»: приём обязан продолжиться, а не упасть.
type fakePlans struct {
	allowed bool
	err     error
	period  time.Time
}

func (p fakePlans) CheckWorkspace(context.Context, uuid.UUID, entitlements.Key) (entitlements.Decision, error) {
	if p.err != nil {
		return entitlements.Decision{}, p.err
	}
	return entitlements.Decision{Allowed: p.allowed, Period: p.period}, nil
}

// PeriodStart намеренно возвращает ДРУГОЙ период, чем решение: так тест ловит
// «приём прочитал часы второй раз вместо периода из решения» — расхождение,
// которое в проде случается только на границе месяца и молча.
func (p fakePlans) PeriodStart() time.Time { return p.period.AddDate(0, -1, 0) }

// okPlans — квота не исчерпана (обычный случай в тестах не про тарифы).
func okPlans() fakePlans { return fakePlans{allowed: true} }

// fakeMailer записывает коалесцирующие постановки для проверок.
type fakeMailer struct {
	calls []coalescedCall
}

type coalescedCall struct {
	key string
	msg mail.EmailMessage
}

func (m *fakeMailer) EnqueueCoalesced(_ context.Context, _ postgres.DBTX, key string, msg mail.EmailMessage, _ time.Duration) error {
	m.calls = append(m.calls, coalescedCall{key: key, msg: msg})
	return nil
}

// Неразбираемая опубликованная схема — это нарушенный инвариант версии (её
// проверяли при публикации), а НЕ ошибка ввода респондента. Ошибка обязана стать
// внутренней: иначе respond.go по сентинелу ErrValidation отдаёт 422 и печатает
// внутренний текст наружу — респондент видит «json: unknown field ...».
//
// Как это ловилось живьём: старый бинарь API против схемы с новым полем
// (thankYouText/redirectUrl) — DisallowUnknownFields не разобрал снапшот, и
// техническая строка доехала до экрана формы.
func TestSubmit_UnparsableVersionSchema_IsInternalNotValidation(t *testing.T) {
	svc := NewService(nil, nil, fakeForms{pf: forms.PublicForm{
		// Опубликованная и открытая (иначе Submit отклонит как закрытую до разбора схемы).
		Status: domain.FormStatusPublished,
		// Поле из будущего формата: DisallowUnknownFields такую схему отвергнет.
		Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[],"fieldFromFuture":"x"}`),
	}}, nil, nil, okPlans(), nil, "")

	err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{})
	if err == nil {
		t.Fatal("ожидалась ошибка: схема версии не разбирается")
	}
	if errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка помечена ErrValidation → respond.go отдаст 422 с внутренним "+
			"текстом респонденту; ожидалась внутренняя (500): %v", err)
	}
	// Контекст для лога сохраняется — скрывается он уже в respond.go (5xx).
	if !strings.Contains(err.Error(), "slug1") {
		t.Fatalf("ошибка потеряла контекст для лога: %v", err)
	}
}

// validPublishedForm — опубликованная открытая форма без полей (пустые ответы
// валидны), с заданным тумблером уведомлений. Для проверок гейта уведомления.
func validPublishedForm(notify bool) forms.PublicForm {
	return forms.PublicForm{
		FormID:             uuid.New(),
		Status:             domain.FormStatusPublished,
		Schema:             json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
		NotifyOnSubmission: notify,
	}
}

func TestSubmit_NotifyOn_EnqueuesOwnerDigest(t *testing.T) {
	pf := validPublishedForm(true)
	mailer := &fakeMailer{}
	svc := NewService(nil, fakeTx{},
		fakeForms{pf: pf, owner: forms.Owner{Email: "owner@example.com", Title: "Моя форма"}},
		nil, mailer, okPlans(), &fakeSubStore{insertN: 1}, "https://app.test")

	if err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if len(mailer.calls) != 1 {
		t.Fatalf("поставлено уведомлений: %d, ожидалось 1", len(mailer.calls))
	}
	c := mailer.calls[0]
	if c.key != "submission:"+pf.FormID.String() {
		t.Errorf("ключ коалесинга = %q, ожидался submission:%s", c.key, pf.FormID)
	}
	if c.msg.To != "owner@example.com" || c.msg.Template != mail.TemplateSubmissionDigest {
		t.Errorf("письмо адресовано неверно: to=%q template=%q", c.msg.To, c.msg.Template)
	}
	if c.msg.Data["count"] != 1 {
		t.Errorf("стартовый count = %v, ожидался 1", c.msg.Data["count"])
	}
	if link, _ := c.msg.Data["link"].(string); link != "https://app.test/forms/slug1/responses" {
		t.Errorf("ссылка = %q, ожидалась таблица ответов кабинета", link)
	}
}

func TestSubmit_NotifyOff_NoEnqueue(t *testing.T) {
	mailer := &fakeMailer{}
	svc := NewService(nil, fakeTx{}, fakeForms{pf: validPublishedForm(false)},
		nil, mailer, okPlans(), &fakeSubStore{insertN: 1}, "https://app.test")

	if err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if len(mailer.calls) != 0 {
		t.Errorf("при выключенном тумблере письмо не ставится, а поставлено %d", len(mailer.calls))
	}
}

// Идемпотентный ретрай (тот же id, вставка вернула 0 строк) не должен слать
// повторное письмо.
func TestSubmit_NotifyOn_IdempotentRetry_NoEnqueue(t *testing.T) {
	mailer := &fakeMailer{}
	svc := NewService(nil, fakeTx{},
		fakeForms{pf: validPublishedForm(true), owner: forms.Owner{Email: "o@e.com"}},
		nil, mailer, okPlans(), &fakeSubStore{insertN: 0}, "https://app.test")

	if err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if len(mailer.calls) != 0 {
		t.Errorf("повтор того же ответа письмо не ставит, а поставлено %d", len(mailer.calls))
	}
}

// Исчерпанная квота тарифа НЕ отказывает респонденту: ответ принимается и
// помечается over_quota (скрытие живёт в кабинете владельца, ADR §10). Отказ
// здесь потерял бы данные клиента за неоплату владельцем.
func TestSubmit_OverQuota_AcceptsAndMarks(t *testing.T) {
	store := &fakeSubStore{insertN: 1}
	period := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	svc := NewService(nil, fakeTx{}, fakeForms{pf: validPublishedForm(false)},
		nil, &fakeMailer{}, fakePlans{allowed: false, period: period}, store, "https://app.test")

	if err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("исчерпанная квота отклонила ответ: %v", err)
	}
	if !store.lastInsert.OverQuota {
		t.Error("ответ сверх квоты не помечен over_quota")
	}
	// Инкремент расхода обязан попасть в ТОТ ЖЕ период, что прочитала проверка.
	if !store.lastInsert.Period.Equal(period) {
		t.Errorf("период вставки = %v, ждали %v (период РЕШЕНИЯ, а не второе чтение часов)",
			store.lastInsert.Period, period)
	}
}

func TestSubmit_WithinQuota_NotMarked(t *testing.T) {
	store := &fakeSubStore{insertN: 1}
	svc := NewService(nil, fakeTx{}, fakeForms{pf: validPublishedForm(false)},
		nil, &fakeMailer{}, okPlans(), store, "https://app.test")

	if err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	if store.lastInsert.OverQuota {
		t.Error("ответ в пределах квоты помечен over_quota")
	}
}

// Сбой самой проверки (нет подписки, битые limits) не имеет права уронить приём:
// это отказ РЕСПОНДЕНТУ из-за внутренней проблемы владельца. Ответ проходит как
// «в пределах квоты» — щедро, но данные целы.
func TestSubmit_QuotaCheckFails_StillAccepts(t *testing.T) {
	store := &fakeSubStore{insertN: 1}
	svc := NewService(nil, fakeTx{}, fakeForms{pf: validPublishedForm(false)},
		nil, &fakeMailer{}, fakePlans{err: errors.New("нет подписки")}, store, "https://app.test")

	if err := svc.Submit(context.Background(), "slug1", uuid.New(), map[string]json.RawMessage{}, Meta{}); err != nil {
		t.Fatalf("сбой проверки квоты уронил приём ответа: %v", err)
	}
	if store.lastInsert.OverQuota {
		t.Error("при несостоявшейся проверке ответ помечен сверхлимитным")
	}
}

// fakePartialStore — Store для листинга черновиков: отдаёт заданные строки и общее
// число. Остальные методы не реализованы (встроенный nil-интерфейс) — листинг их
// не зовёт, и вызов упал бы паникой, а не молча.
type fakePartialStore struct {
	Store
	rows  []Partial
	total int64
	// after — курсор, с которым пришли в репозиторий: тест проверяет, что сервис
	// передал его как есть, а не потерял по дороге.
	after *TimeCursor
}

func (f *fakePartialStore) ListPartials(_ context.Context, _ postgres.DBTX, _ uuid.UUID, limit int32, after *TimeCursor) ([]Partial, error) {
	f.after = after
	if int(limit) < len(f.rows) {
		return f.rows[:limit], nil
	}
	return f.rows, nil
}

func (f *fakePartialStore) CountPartials(context.Context, postgres.DBTX, uuid.UUID) (int64, error) {
	return f.total, nil
}

// Чужая форма — 404 РАНЬШЕ разговора о тарифе: иначе отказ по тарифу подтверждал бы
// существование чужой формы (инвариант 1, тот же порядок, что у публикации).
func TestListPartials_ForeignForm_404BeforePlanGate(t *testing.T) {
	svc := NewService(nil, nil, fakeForms{}, nil, nil,
		fakePlans{err: errors.New("тарифы спрашивать не должны были")}, &fakePartialStore{}, "")

	_, err := svc.ListPartialsForForm(context.Background(), uuid.New(), uuid.New(), nil, 0)
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидался ErrNotFound", err)
	}
}

// Тариф больше не разрешает показ (даунгрейд при включённом тумблере) — 402, а не
// пустая страница: молча показать ноль черновиков значило бы соврать про данные,
// которые собраны и лежат.
func TestListPartials_PlanDenied(t *testing.T) {
	svc := NewService(nil, nil, fakeForms{owned: &forms.Form{ID: uuid.New(), WorkspaceID: uuid.New()}},
		nil, nil, fakePlans{allowed: false}, &fakePartialStore{}, "")

	_, err := svc.ListPartialsForForm(context.Background(), uuid.New(), uuid.New(), nil, 0)
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("ошибка = %v, ожидался ErrPlanRequired", err)
	}
}

// Страница режется по limit, а курсор строится по ПОСЛЕДНЕЙ ПОКАЗАННОЙ строке, а не
// по лишней: иначе следующая страница начиналась бы через одну, и одна запись
// пропадала бы из списка навсегда.
func TestListPartials_CursorFromLastShownRow(t *testing.T) {
	older := time.Date(2026, 8, 26, 9, 0, 0, 0, time.UTC)
	rows := []Partial{
		{VisitID: uuid.New(), UpdatedAt: older.Add(2 * time.Hour)},
		{VisitID: uuid.New(), UpdatedAt: older.Add(time.Hour)},
		{VisitID: uuid.New(), UpdatedAt: older},
	}
	store := &fakePartialStore{rows: rows, total: 42}
	svc := NewService(nil, nil, fakeForms{owned: &forms.Form{ID: uuid.New(), WorkspaceID: uuid.New()}},
		nil, nil, okPlans(), store, "")

	page, err := svc.ListPartialsForForm(context.Background(), uuid.New(), uuid.New(), nil, 2)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if len(page.Partials) != 2 {
		t.Fatalf("показано строк = %d, ожидалось 2", len(page.Partials))
	}
	if page.Total != 42 {
		t.Fatalf("total = %d, ожидалось 42", page.Total)
	}
	if page.NextCursor == nil {
		t.Fatal("курсор следующей страницы пуст, а лишняя строка была")
	}
	if page.NextCursor.ID != rows[1].VisitID || !page.NextCursor.At.Equal(rows[1].UpdatedAt) {
		t.Fatalf("курсор указывает не на последнюю показанную строку: %+v", *page.NextCursor)
	}
}

// Последняя страница курсора не отдаёт: непустой nextCursor заставил бы кабинет
// показать «Показать ещё» и сходить за пустотой.
func TestListPartials_LastPageHasNoCursor(t *testing.T) {
	store := &fakePartialStore{rows: []Partial{{VisitID: uuid.New()}}, total: 1}
	svc := NewService(nil, nil, fakeForms{owned: &forms.Form{ID: uuid.New(), WorkspaceID: uuid.New()}},
		nil, nil, okPlans(), store, "")

	page, err := svc.ListPartialsForForm(context.Background(), uuid.New(), uuid.New(), nil, 50)
	if err != nil {
		t.Fatalf("список: %v", err)
	}
	if page.NextCursor != nil {
		t.Fatalf("курсор = %+v, ожидался nil", *page.NextCursor)
	}
}

// Удаление черновика спрашивает право УДАЛЯТЬ ОТВЕТЫ, а не читать форму: это чужой
// набранный текст, и снятая ячейка матрицы прав обязана его защищать (тот же разбор,
// что у удаления ответа).
func TestDeletePartial_ForeignForm_404(t *testing.T) {
	svc := NewService(nil, nil, fakeForms{}, nil, nil, okPlans(), &fakePartialStore{}, "")

	err := svc.DeletePartialForForm(context.Background(), uuid.New(), uuid.New(), uuid.New())
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ожидался ErrNotFound", err)
	}
}
