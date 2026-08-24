package visits

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/postgres"
)

type fakeForms struct {
	form     forms.PublicForm
	err      error
	versions []forms.Version
}

func (f fakeForms) PublicForm(context.Context, string) (forms.PublicForm, error) {
	return f.form, f.err
}

func (f fakeForms) Versions(context.Context, uuid.UUID, uuid.UUID) ([]forms.Version, error) {
	return f.versions, f.err
}

func (f fakeForms) Get(context.Context, uuid.UUID, uuid.UUID) (forms.Form, error) {
	return forms.Form{ID: f.form.FormID, WorkspaceID: f.form.WorkspaceID}, f.err
}

// fakePlans — управляемый тариф. allowed=false = «воронка закрыта планом».
type fakePlans struct {
	allowed bool
	err     error
}

func (p fakePlans) CheckWorkspace(context.Context, uuid.UUID, entitlements.Key) (entitlements.Decision, error) {
	return entitlements.Decision{Allowed: p.allowed}, p.err
}

// openPlans — тариф, который воронку не закрывает (обычный случай тестов не про гейт).
func openPlans() fakePlans { return fakePlans{allowed: true} }

type upsertCall struct {
	id, formID, versionID uuid.UUID
	lastBlockID           *string
	seq                   int16
	meta                  json.RawMessage
}

type fakeStore struct {
	upserts     []upsertCall
	marked      []uuid.UUID
	byLastBlock []domain.LastBlockCount
	insights    domain.VisitInsights
	period      domain.Period // окно наблюдения, с которым сервис пришёл в стор
	upsetErr    error
}

func (s *fakeStore) UpsertVisit(_ context.Context, _ postgres.DBTX, id, formID, versionID uuid.UUID, lastBlockID *string, seq int16, meta json.RawMessage) error {
	s.upserts = append(s.upserts, upsertCall{id, formID, versionID, lastBlockID, seq, meta})
	return s.upsetErr
}

func (s *fakeStore) MarkSubmitted(_ context.Context, _ postgres.DBTX, id, _ uuid.UUID) (int64, error) {
	s.marked = append(s.marked, id)
	return 0, nil
}

func (s *fakeStore) CountByLastBlock(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period) ([]domain.LastBlockCount, error) {
	s.period = period
	return s.byLastBlock, nil
}

func (s *fakeStore) Insights(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period) (domain.VisitInsights, error) {
	s.period = period
	return s.insights, nil
}

var now = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func openForm() forms.PublicForm {
	return forms.PublicForm{
		FormID:    uuid.New(),
		VersionID: uuid.New(),
		Version:   3,
		Status:    domain.FormStatusPublished,
	}
}

func newSvc(f forms.PublicForm, store *fakeStore) *Service {
	svc := NewService(nil, fakeForms{form: f}, openPlans(), store)
	svc.now = func() time.Time { return now }
	return svc
}

func validVisit() Visit {
	return Visit{ID: uuid.New(), Version: 3, Seq: 0}
}

func TestRecord_WritesVisitOfPublishedVersion(t *testing.T) {
	form := openForm()
	store := &fakeStore{}
	if err := newSvc(form, store).Record(context.Background(), "abc", validVisit()); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if len(store.upserts) != 1 {
		t.Fatalf("апсертов = %d, ждали 1", len(store.upserts))
	}
	got := store.upserts[0]
	if got.formID != form.FormID || got.versionID != form.VersionID {
		t.Errorf("визит привязан к form=%v version=%v, ждали %v/%v", got.formID, got.versionID, form.FormID, form.VersionID)
	}
}

// Форму переиздали между открытием страницы и биконом. Приписать визит новой версии
// нельзя: last_block_id искали бы в схеме, которой человек не видел.
func TestRecord_VersionMismatchRejected(t *testing.T) {
	store := &fakeStore{}
	v := validVisit()
	v.Version = 2 // опубликована 3

	err := newSvc(openForm(), store).Record(context.Background(), "abc", v)
	if !errors.Is(err, domain.ErrValidation) {
		t.Fatalf("ошибка = %v, ждали ErrValidation", err)
	}
	if len(store.upserts) != 0 {
		t.Error("визит записан при расхождении версий")
	}
}

// Черновик/несуществующая форма — ошибка коллаборатора едет наружу как есть (404),
// приватное не раскрывается.
func TestRecord_NotFoundPropagates(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, openPlans(), store)
	svc.now = func() time.Time { return now }

	if err := svc.Record(context.Background(), "abc", validVisit()); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали ErrNotFound", err)
	}
	if len(store.upserts) != 0 {
		t.Error("визит записан для несуществующей формы")
	}
}

// Закрытая форма визитов не набирает: ответом они закончиться не могли, а конверсию
// бы занижали. Проверяем все три способа закрытия.
func TestRecord_ClosedFormRejected(t *testing.T) {
	past := now.Add(-time.Hour)
	limit := int32(10)

	cases := map[string]func(*forms.PublicForm){
		"снята вручную":   func(f *forms.PublicForm) { f.Status = domain.FormStatusClosed },
		"дата прошла":     func(f *forms.PublicForm) { f.CloseAt = &past },
		"лимит достигнут": func(f *forms.PublicForm) { f.ResponseLimit = &limit; f.SubmissionCount = 10 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			form := openForm()
			mutate(&form)
			store := &fakeStore{}

			if err := newSvc(form, store).Record(context.Background(), "abc", validVisit()); !errors.Is(err, domain.ErrFormClosed) {
				t.Fatalf("ошибка = %v, ждали ErrFormClosed", err)
			}
			if len(store.upserts) != 0 {
				t.Error("визит записан для закрытой формы")
			}
		})
	}
}

func TestRecord_RejectsBadLastBlockID(t *testing.T) {
	empty := ""
	long := strings.Repeat("x", domain.MaxIDLen+1)

	for name, id := range map[string]*string{"пустой": &empty, "длиннее предела": &long} {
		t.Run(name, func(t *testing.T) {
			store := &fakeStore{}
			v := validVisit()
			v.LastBlockID = id

			if err := newSvc(openForm(), store).Record(context.Background(), "abc", v); !errors.Is(err, domain.ErrValidation) {
				t.Fatalf("ошибка = %v, ждали ErrValidation", err)
			}
			if len(store.upserts) != 0 {
				t.Error("визит записан с неверным last_block_id")
			}
		})
	}
}

// nil last_block_id — законное «открыл и ушёл, не тронув вопросов», а не ошибка.
func TestRecord_NilLastBlockIDAllowed(t *testing.T) {
	store := &fakeStore{}
	if err := newSvc(openForm(), store).Record(context.Background(), "abc", validVisit()); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if store.upserts[0].lastBlockID != nil {
		t.Error("last_block_id должен остаться nil")
	}
}

// Мета — закрытый список: user_agent, referer и только известные utm_*. Иначе
// публичная ручка на запись принимает произвольный словарь от клиента.
func TestRecord_MetaWhitelistsUTM(t *testing.T) {
	store := &fakeStore{}
	v := validVisit()
	v.UserAgent = "Mozilla/5.0"
	v.Referer = "https://t.me/chan"
	v.UTM = map[string]string{
		"utm_source":  "telegram",
		"utm_medium":  "",   // пустое не попадает в мету
		"tracking_id": "42", // не из списка
	}

	if err := newSvc(openForm(), store).Record(context.Background(), "abc", v); err != nil {
		t.Fatalf("Record: %v", err)
	}

	var meta map[string]string
	if err := json.Unmarshal(store.upserts[0].meta, &meta); err != nil {
		t.Fatalf("разбор меты: %v", err)
	}
	if meta["user_agent"] != "Mozilla/5.0" || meta["referer"] != "https://t.me/chan" {
		t.Errorf("мета = %v, ждали user_agent и referer", meta)
	}
	if meta["utm_source"] != "telegram" {
		t.Errorf("utm_source = %q, ждали telegram", meta["utm_source"])
	}
	if _, ok := meta["tracking_id"]; ok {
		t.Error("в мету попал ключ вне списка utm_*")
	}
	if _, ok := meta["utm_medium"]; ok {
		t.Error("в мету попал пустой utm_medium")
	}
}

// IP в мете не появляется ни под каким именем — инвариант приватности модуля
// (ARCHITECTURE §3.3). Тест падает, если кто-то добавит его «для антифрода».
func TestRecord_MetaHasNoIP(t *testing.T) {
	store := &fakeStore{}
	v := validVisit()
	v.UserAgent = "Mozilla/5.0"

	if err := newSvc(openForm(), store).Record(context.Background(), "abc", v); err != nil {
		t.Fatalf("Record: %v", err)
	}
	var meta map[string]string
	if err := json.Unmarshal(store.upserts[0].meta, &meta); err != nil {
		t.Fatalf("разбор меты: %v", err)
	}
	for k := range meta {
		if strings.Contains(k, "ip") || strings.Contains(k, "addr") {
			t.Errorf("в мете визита появился ключ %q — IP не пишется", k)
		}
	}
}

// Длинный user_agent обрезается по границе руны: обрезка по байтам оставила бы
// хвост битой руны и мойибаке в JSONB.
func TestRecord_TruncatesMetaOnRuneBoundary(t *testing.T) {
	store := &fakeStore{}
	v := validVisit()
	// Однобайтовый префикс сдвигает двухбайтовые руны на нечётные смещения, поэтому
	// предел maxMetaFieldLen приходится РОВНО в середину руны. Без сдвига (одни «я»)
	// граница легла бы на стык, и тест проходил бы даже при обрезке по байтам.
	v.UserAgent = "x" + strings.Repeat("я", maxMetaFieldLen)

	if err := newSvc(openForm(), store).Record(context.Background(), "abc", v); err != nil {
		t.Fatalf("Record: %v", err)
	}
	var meta map[string]string
	if err := json.Unmarshal(store.upserts[0].meta, &meta); err != nil {
		t.Fatalf("разбор меты: %v", err)
	}
	ua := meta["user_agent"]
	if len(ua) > maxMetaFieldLen {
		t.Errorf("длина user_agent = %d, ждали ≤ %d", len(ua), maxMetaFieldLen)
	}
	if strings.ContainsRune(ua, '�') {
		t.Error("обрезка разрубила руну — в мете символ замены")
	}
}

// Воронка чужой формы недоступна: forms.Versions проверяет членство в воркспейсе и
// отдаёт ErrNotFound, а сервис обязан пропустить эту ошибку наружу нетронутой —
// id формы из URL правом доступа не является (инвариант 1).
func TestFunnel_ForeignFormIsNotFound(t *testing.T) {
	store := &fakeStore{byLastBlock: []domain.LastBlockCount{{BlockID: "b1", Visits: 5}}}
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, openPlans(), store)

	_, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали ErrNotFound", err)
	}
}

// Воронка обходится ОДНИМ счётным запросом: верх (визиты и конверсия) выводится из
// той же разбивки, что и шаги. Тест держит и результат, и это свойство — второй
// источник тех же чисел мог бы разойтись с шагами, а стоил бы лишний скан на каждом
// открытии страницы.
func TestFunnel_SingleCountQueryAndDerivedTotals(t *testing.T) {
	store := &fakeStore{byLastBlock: []domain.LastBlockCount{
		{BlockID: "", Visits: 20},                    // ушли, не начав
		{BlockID: "b1", Visits: 68},                  // бросили на вопросе
		{BlockID: "b1", Submitted: true, Visits: 12}, // отправили
	}}
	svc := NewService(nil, fakeForms{versions: []forms.Version{{
		Number: 1,
		Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[{"id":"t_b1","groupId":"g_b1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g_b1","type":"short_text","required":false,"settings":{}}]}`),
	}}}, openPlans(), store)

	f, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if err != nil {
		t.Fatalf("Funnel: %v", err)
	}
	if f.Visits != 100 || f.Submitted != 12 {
		t.Errorf("верх воронки = %d/%d, ждали 100/12 (выведено из разбивки)", f.Visits, f.Submitted)
	}
	if f.LeftBeforeFirst != 20 {
		t.Errorf("LeftBeforeFirst = %d, ждали 20", f.LeftBeforeFirst)
	}
	if len(f.Steps) != 1 || f.Steps[0].Label != "Имя" {
		t.Fatalf("шаги = %+v, ждали один вопрос «Имя»", f.Steps)
	}
	if f.Steps[0].Reached != 80 || f.Steps[0].DroppedHere != 68 {
		t.Errorf("шаг = %d дошли / %d отвал, ждали 80/68 (отправивший не отвал)",
			f.Steps[0].Reached, f.Steps[0].DroppedHere)
	}
}

// Воронка закрыта тарифом → ErrPlanRequired (402), а не пустая воронка и не 403:
// у отказа по деньгам свой код, по нему кабинет рисует плашку апгрейда.
func TestFunnel_PlanDenies_ErrPlanRequired(t *testing.T) {
	svc := NewService(nil, fakeForms{versions: []forms.Version{{
		Number: 1,
		Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[]}`),
	}}}, fakePlans{allowed: false}, &fakeStore{})

	_, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("ошибка = %v, ждали domain.ErrPlanRequired", err)
	}
}

// Чужая форма закрыта тарифом ИЛИ нет — снаружи это должно быть неразличимо:
// авторизация идёт ПЕРВОЙ, поэтому посторонний получает 404, а не 402 (иначе код
// ответа рассказывал бы о существовании формы и о плане чужого воркспейса).
func TestFunnel_ForeignForm_404BeforePlanGate(t *testing.T) {
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, fakePlans{allowed: false}, &fakeStore{})

	_, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали domain.ErrNotFound (гейт тарифа не должен опережать авторизацию)", err)
	}
}

// Карточки чужой формы недоступны так же, как воронка: forms.Get проверяет членство
// и отдаёт ErrNotFound, сервис обязан пропустить её наружу нетронутой (инвариант 1).
func TestInsights_ForeignFormIsNotFound(t *testing.T) {
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, openPlans(), &fakeStore{})

	_, err := svc.Insights(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали ErrNotFound", err)
	}
}

// Карточки НЕ гейтятся тарифом: «сколько людей пришло» — первое, что владелец видит
// после публикации, и замок на этом рекламировал бы Pro вместо продукта. Платным
// остаётся разбор (воронка, источники). Тест держит это решение: закрытый план
// обязан отдать числа.
func TestInsights_NotGatedByPlan(t *testing.T) {
	store := &fakeStore{insights: domain.VisitInsights{Visits: 7, Submitted: 2}}
	svc := NewService(nil, fakeForms{}, fakePlans{allowed: false}, store)

	in, err := svc.Insights(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if in.Visits != 7 || in.Submitted != 2 {
		t.Fatalf("карточки = %+v, ждали 7 визитов и 2 ответа", in)
	}
}

// Окно наблюдения доезжает до стора неизменным — и у карточек, и у воронки. Без
// этого селектор периода молча показывал бы «всё время»: экран остался бы рабочим,
// а числа — неверными.
func TestPeriodReachesStore(t *testing.T) {
	period := domain.Period{
		From: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		To:   time.Date(2026, 8, 24, 0, 0, 0, 0, time.UTC),
	}

	t.Run("карточки", func(t *testing.T) {
		store := &fakeStore{}
		svc := NewService(nil, fakeForms{}, openPlans(), store)
		if _, err := svc.Insights(context.Background(), uuid.New(), uuid.New(), period); err != nil {
			t.Fatalf("неожиданная ошибка: %v", err)
		}
		if store.period != period {
			t.Fatalf("период в сторе = %+v, ждали %+v", store.period, period)
		}
	})

	t.Run("воронка", func(t *testing.T) {
		store := &fakeStore{}
		svc := NewService(nil, fakeForms{}, openPlans(), store)
		if _, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), period); err != nil {
			t.Fatalf("неожиданная ошибка: %v", err)
		}
		if store.period != period {
			t.Fatalf("период в сторе = %+v, ждали %+v", store.period, period)
		}
	})
}
