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
	"github.com/ka-shmd/trillix/internal/geo"
	"github.com/ka-shmd/trillix/internal/postgres"
)

type fakeForms struct {
	form     forms.PublicFormRef
	err      error
	versions []forms.Version
}

func (f fakeForms) PublicFormRef(context.Context, string) (forms.PublicFormRef, error) {
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

// keyPlans — тариф, закрывающий ровно перечисленные ключи.
type keyPlans map[entitlements.Key]bool

func (p keyPlans) CheckWorkspace(_ context.Context, _ uuid.UUID, key entitlements.Key) (entitlements.Decision, error) {
	return entitlements.Decision{Allowed: !p[key]}, nil
}

type upsertCall struct {
	id, formID, versionID uuid.UUID
	lastBlockID           *string
	seq                   int16
	meta                  json.RawMessage
	place                 geo.Place
	visitorKey            []byte
}

type fakeStore struct {
	upserts     []upsertCall
	pages       []string // block_id вставленных строк пути
	paths       []domain.PathCount
	spans       []domain.PageSpan
	filter      domain.VisitFilter // фильтр сегмента, с которым сервис пришёл в стор
	versionStat map[uuid.UUID]domain.VersionStat
	marked      []uuid.UUID
	byLastBlock []domain.LastBlockCount
	insights    domain.VisitInsights
	buckets     []domain.TimeBucket
	sources     []domain.SourceRow
	countries   []domain.PlaceCount
	cities      []domain.PlaceCount
	agents      []domain.UserAgentRow
	step        domain.BucketStep
	period      domain.Period // окно наблюдения, с которым сервис пришёл в стор
	upsetErr    error
}

func (s *fakeStore) UpsertVisit(_ context.Context, _ postgres.DBTX, id, formID, versionID uuid.UUID, lastBlockID *string, seq int16, meta json.RawMessage, place geo.Place, visitorKey []byte) error {
	s.upserts = append(s.upserts, upsertCall{id, formID, versionID, lastBlockID, seq, meta, place, visitorKey})
	return s.upsetErr
}

// fakeGeo — справочник, который знает ровно один адрес. Пустой IP и всё остальное
// даёт пустое место — как настоящий на IPv6 и приватных адресах.
type fakeGeo struct{}

func (fakeGeo) Configured() bool { return true }

func (fakeGeo) Lookup(ip string) geo.Place {
	if ip == "77.94.1.1" {
		return geo.Place{CountryCode: "RU", Country: "Россия", City: "Москва"}
	}
	return geo.Place{}
}

func (s *fakeStore) InsertPage(_ context.Context, _ postgres.DBTX, _, _ uuid.UUID, blockID string) error {
	s.pages = append(s.pages, blockID)
	return nil
}

func (s *fakeStore) CountPaths(_ context.Context, _ postgres.DBTX, _ uuid.UUID, _ domain.Period, _ domain.VisitFilter) ([]domain.PathCount, error) {
	return s.paths, nil
}

func (s *fakeStore) PageSpans(_ context.Context, _ postgres.DBTX, _ uuid.UUID, _ domain.Period, _ domain.VisitFilter) ([]domain.PageSpan, error) {
	return s.spans, nil
}

func (s *fakeStore) VersionStats(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period, f domain.VisitFilter) (map[uuid.UUID]domain.VersionStat, error) {
	s.period, s.filter = period, f
	return s.versionStat, nil
}

func (s *fakeStore) MarkSubmitted(_ context.Context, _ postgres.DBTX, id, _ uuid.UUID) (int64, error) {
	s.marked = append(s.marked, id)
	return 0, nil
}

func (s *fakeStore) CountByLastBlock(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period, f domain.VisitFilter) ([]domain.LastBlockCount, error) {
	s.period, s.filter = period, f
	return s.byLastBlock, nil
}

func (s *fakeStore) Insights(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period, f domain.VisitFilter) (domain.VisitInsights, error) {
	s.period, s.filter = period, f
	return s.insights, nil
}

func (s *fakeStore) Timeseries(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period, step domain.BucketStep) ([]domain.TimeBucket, error) {
	s.period = period
	s.step = step
	return s.buckets, nil
}

func (s *fakeStore) Countries(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period) ([]domain.PlaceCount, error) {
	s.period = period
	return s.countries, nil
}

func (s *fakeStore) Cities(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period) ([]domain.PlaceCount, error) {
	s.period = period
	return s.cities, nil
}

func (s *fakeStore) Sources(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period) ([]domain.SourceRow, error) {
	s.period = period
	return s.sources, nil
}

func (s *fakeStore) UserAgents(_ context.Context, _ postgres.DBTX, _ uuid.UUID, period domain.Period) ([]domain.UserAgentRow, error) {
	s.period = period
	return s.agents, nil
}

var now = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func openForm() forms.PublicFormRef {
	return forms.PublicFormRef{
		FormID:    uuid.New(),
		VersionID: uuid.New(),
		Version:   3,
		Status:    domain.FormStatusPublished,
	}
}

func newSvc(f forms.PublicFormRef, store *fakeStore) *Service {
	svc := NewService(nil, fakeForms{form: f}, openPlans(), store, fakeGeo{}, keySecret)
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

// Бикон перехода (page) пишет строку пути после апсерта; обычный бикон — нет, как и
// переход без блока (флаг от клиента, блока нет — писать нечего).
func TestRecord_PageBeaconWritesPath(t *testing.T) {
	store := &fakeStore{}
	svc := newSvc(openForm(), store)

	v := validVisit()
	if err := svc.Record(context.Background(), "abc", v); err != nil {
		t.Fatalf("Record: %v", err)
	}
	page := validVisit()
	page.Page = true
	block := "q_page2"
	page.LastBlockID = &block
	if err := svc.Record(context.Background(), "abc", page); err != nil {
		t.Fatalf("Record page: %v", err)
	}
	empty := validVisit()
	empty.Page = true
	empty.LastBlockID = nil
	if err := svc.Record(context.Background(), "abc", empty); err != nil {
		t.Fatalf("Record page without block: %v", err)
	}

	if len(store.upserts) != 3 {
		t.Fatalf("апсертов = %d, ждали 3: путь не отменяет запись визита", len(store.upserts))
	}
	if len(store.pages) != 1 || store.pages[0] != block {
		t.Errorf("строки пути = %v, ждали [%s]", store.pages, block)
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
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, openPlans(), store, fakeGeo{}, keySecret)
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

	cases := map[string]func(*forms.PublicFormRef){
		"снята вручную":   func(f *forms.PublicFormRef) { f.Status = domain.FormStatusClosed },
		"дата прошла":     func(f *forms.PublicFormRef) { f.CloseAt = &past },
		"лимит достигнут": func(f *forms.PublicFormRef) { f.ResponseLimit = &limit; f.SubmissionCount = 10 },
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
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, openPlans(), store, fakeGeo{}, keySecret)

	_, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{})
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
	}}}, openPlans(), store, fakeGeo{}, keySecret)

	f, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{})
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
	}}}, fakePlans{allowed: false}, &fakeStore{}, fakeGeo{}, keySecret)

	_, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{})
	if !errors.Is(err, domain.ErrPlanRequired) {
		t.Fatalf("ошибка = %v, ждали domain.ErrPlanRequired", err)
	}
}

// Чужая форма закрыта тарифом ИЛИ нет — снаружи это должно быть неразличимо:
// авторизация идёт ПЕРВОЙ, поэтому посторонний получает 404, а не 402 (иначе код
// ответа рассказывал бы о существовании формы и о плане чужого воркспейса).
func TestFunnel_ForeignForm_404BeforePlanGate(t *testing.T) {
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, fakePlans{allowed: false}, &fakeStore{}, fakeGeo{}, keySecret)

	_, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{})
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали domain.ErrNotFound (гейт тарифа не должен опережать авторизацию)", err)
	}
}

// Карточки чужой формы недоступны так же, как воронка: forms.Get проверяет членство
// и отдаёт ErrNotFound, сервис обязан пропустить её наружу нетронутой (инвариант 1).
func TestInsights_ForeignFormIsNotFound(t *testing.T) {
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, openPlans(), &fakeStore{}, fakeGeo{}, keySecret)

	_, err := svc.Insights(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{})
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
	svc := NewService(nil, fakeForms{}, fakePlans{allowed: false}, store, fakeGeo{}, keySecret)

	in, err := svc.Insights(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{})
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
		svc := NewService(nil, fakeForms{}, openPlans(), store, fakeGeo{}, keySecret)
		if _, err := svc.Insights(context.Background(), uuid.New(), uuid.New(), period, domain.Segment{}); err != nil {
			t.Fatalf("неожиданная ошибка: %v", err)
		}
		if store.period != period {
			t.Fatalf("период в сторе = %+v, ждали %+v", store.period, period)
		}
	})

	t.Run("воронка", func(t *testing.T) {
		store := &fakeStore{}
		svc := NewService(nil, fakeForms{}, openPlans(), store, fakeGeo{}, keySecret)
		if _, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), period, domain.Segment{}); err != nil {
			t.Fatalf("неожиданная ошибка: %v", err)
		}
		if store.period != period {
			t.Fatalf("период в сторе = %+v, ждали %+v", store.period, period)
		}
	})
}

// Гейт источников закрывает ОДНУ секцию, а не всю вкладку: 402 на весь запрос
// унёс бы заодно график и устройства, которые платными не объявлялись. Число
// визитов с известным источником при этом настоящее — плашка обязана показывать
// число владельца, а не рекламировать пустоту.
func TestBreakdown_LockedSourcesKeepRestOfTab(t *testing.T) {
	store := &fakeStore{
		sources: []domain.SourceRow{
			{UTMSource: "newsletter", Visits: 7},
			{Visits: 3},
		},
		agents: []domain.UserAgentRow{
			{UserAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Safari/537.36", Visits: 10},
		},
	}
	svc := NewService(nil, fakeForms{}, fakePlans{allowed: false}, store, fakeGeo{}, keySecret)

	b, err := svc.Breakdown(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if !b.SourcesLocked || len(b.Sources) != 0 {
		t.Errorf("источники = %+v (locked=%v), ждали пустые и закрытые", b.Sources, b.SourcesLocked)
	}
	if b.KnownSources != 7 {
		t.Errorf("визитов с источником = %d, ждали 7 — число показывается и под замком", b.KnownSources)
	}
	if len(b.Browsers) == 0 || len(b.Devices) == 0 {
		t.Error("браузеры и устройства обязаны остаться: платными объявлялись только источники")
	}
}

// На открытом плане секция источников приезжает свёрнутой доменом.
func TestBreakdown_OpenPlanFoldsSources(t *testing.T) {
	store := &fakeStore{sources: []domain.SourceRow{
		{Referer: "https://vk.com/wall", Visits: 5},
		{Referer: "https://www.vk.com/feed", Visits: 3},
	}}
	svc := NewService(nil, fakeForms{}, openPlans(), store, fakeGeo{}, keySecret)

	b, err := svc.Breakdown(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if b.SourcesLocked {
		t.Fatal("на открытом плане источники не закрываются")
	}
	if len(b.Sources) != 1 || b.Sources[0].Source != "vk.com" || b.Sources[0].Visits != 8 {
		t.Fatalf("источники = %+v, ждали одну строку vk.com на 8 визитов", b.Sources)
	}
}

// Вкладка чужой формы недоступна — и это проверяется ДО тарифа: иначе код ответа
// рассказывал бы постороннему о существовании формы.
func TestBreakdown_ForeignFormIsNotFound(t *testing.T) {
	svc := NewService(nil, fakeForms{err: domain.ErrNotFound}, fakePlans{allowed: false}, &fakeStore{}, fakeGeo{}, keySecret)

	_, err := svc.Breakdown(context.Background(), uuid.New(), uuid.New(), domain.Period{})
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("ошибка = %v, ждали ErrNotFound", err)
	}
}

// Шаг ряда выбирает сервер и передаёт его в запрос: сутки смотрят часами, длинные
// окна — сутками. Без этого график за месяц состоял бы из тысяч точек.
func TestBreakdown_StepFollowsPeriod(t *testing.T) {
	store := &fakeStore{}
	svc := NewService(nil, fakeForms{}, openPlans(), store, fakeGeo{}, keySecret)
	day := domain.Period{From: time.Now().Add(-24 * time.Hour)}

	if _, err := svc.Breakdown(context.Background(), uuid.New(), uuid.New(), day); err != nil {
		t.Fatalf("неожиданная ошибка: %v", err)
	}
	if store.step != domain.StepHour {
		t.Errorf("шаг = %q, ждали %q", store.step, domain.StepHour)
	}
}

// Гео определяется на ПЕРВОМ биконе и только на нём: у следующих адрес тот же, а
// строка уже создана — апсерт гео не трогает. Лишний поиск по справочнику на
// каждое переключение вкладки не нужен.
func TestRecord_GeoResolvedOnFirstBeaconOnly(t *testing.T) {
	form := openForm()
	store := &fakeStore{}
	svc := newSvc(form, store)

	first := validVisit()
	first.IP = "77.94.1.1"
	if err := svc.Record(context.Background(), "abc", first); err != nil {
		t.Fatalf("Record: %v", err)
	}
	second := first
	second.Seq = 1
	if err := svc.Record(context.Background(), "abc", second); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if len(store.upserts) != 2 {
		t.Fatalf("апсертов = %d, ждали 2", len(store.upserts))
	}
	if got := store.upserts[0].place; got.CountryCode != "RU" || got.City != "Москва" {
		t.Errorf("место первого бикона = %+v, ждали Россию и Москву", got)
	}
	if got := store.upserts[1].place; !got.Empty() {
		t.Errorf("место второго бикона = %+v, ждали пустое: гео ищется один раз на визит", got)
	}
}

// Неизвестный справочнику адрес (IPv6, приватный, чужая сеть) даёт пустое место, а
// не ошибку: аналитика не имеет права отклонить бикон из-за того, что не узнала
// город.
func TestRecord_UnknownAddressIsNotAnError(t *testing.T) {
	form := openForm()
	store := &fakeStore{}
	v := validVisit()
	v.IP = "2a02:6b8::2:242"

	if err := newSvc(form, store).Record(context.Background(), "abc", v); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if !store.upserts[0].place.Empty() {
		t.Errorf("место = %+v, ждали пустое", store.upserts[0].place)
	}
}

// IP не попадает в мету визита ни под каким ключом. Тест-близнец
// TestRecord_MetaHasNoIP: тот сторожил отсутствие адреса, когда его вовсе не было
// в модели, этот — когда он в модель добавлен и обязан остаться внутри сервиса.
func TestRecord_IPDoesNotLeakIntoMeta(t *testing.T) {
	form := openForm()
	store := &fakeStore{}
	v := validVisit()
	v.IP = "77.94.1.1"

	if err := newSvc(form, store).Record(context.Background(), "abc", v); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if strings.Contains(string(store.upserts[0].meta), "77.94.1.1") {
		t.Fatalf("адрес утёк в мету визита: %s", store.upserts[0].meta)
	}
}

// Ключ посетителя считается на первом биконе и только на нём — как и место.
func TestRecord_VisitorKeyOnFirstBeaconOnly(t *testing.T) {
	form := openForm()
	store := &fakeStore{}
	svc := newSvc(form, store)

	first := validVisit()
	first.IP = "77.94.1.1"
	first.UserAgent = chromeUA
	if err := svc.Record(context.Background(), "abc", first); err != nil {
		t.Fatalf("Record: %v", err)
	}
	second := first
	second.Seq = 1
	if err := svc.Record(context.Background(), "abc", second); err != nil {
		t.Fatalf("Record: %v", err)
	}

	if len(store.upserts[0].visitorKey) != visitorKeyLen {
		t.Errorf("ключ первого бикона = %x, ждали %d байт", store.upserts[0].visitorKey, visitorKeyLen)
	}
	if store.upserts[1].visitorKey != nil {
		t.Errorf("ключ второго бикона = %x, ждали nil: ключ считается один раз на визит",
			store.upserts[1].visitorKey)
	}
}

// Контур без секрета уникальных не считает — и это не ошибка приёма: бикон
// принимается, просто ключа у него нет.
func TestRecord_NoSecretNoVisitorKey(t *testing.T) {
	form := openForm()
	store := &fakeStore{}
	svc := NewService(nil, fakeForms{form: form}, openPlans(), store, fakeGeo{}, nil)
	svc.now = func() time.Time { return now }

	v := validVisit()
	v.IP = "77.94.1.1"
	if err := svc.Record(context.Background(), "abc", v); err != nil {
		t.Fatalf("Record: %v", err)
	}
	if store.upserts[0].visitorKey != nil {
		t.Fatalf("ключ = %x, ждали nil", store.upserts[0].visitorKey)
	}
}

const (
	uaPhone   = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
	uaDesktop = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

func segmentSvc(plans Plans, store *fakeStore, versions []forms.Version) *Service {
	return NewService(nil, fakeForms{versions: versions}, plans, store, fakeGeo{}, keySecret)
}

// Сегмент по устройству сводится к строкам user-agent периода, которые разбираются в
// это устройство; воронка идёт в стор уже с этим фильтром.
func TestFunnel_SegmentResolvesToUserAgents(t *testing.T) {
	store := &fakeStore{agents: []domain.UserAgentRow{{UserAgent: uaPhone}, {UserAgent: uaDesktop}}}
	svc := segmentSvc(openPlans(), store, nil)

	if _, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{Dim: domain.SegDevice, Value: "Телефон"}); err != nil {
		t.Fatalf("Funnel: %v", err)
	}
	if store.filter.Kind != domain.FilterUserAgent || len(store.filter.Keys) != 1 || store.filter.Keys[0] != uaPhone {
		t.Errorf("фильтр = %+v, ждали строку айфона", store.filter)
	}
}

// Без сегмента фильтра нет вовсе — не «пустой список».
func TestFunnel_NoSegmentNoFilter(t *testing.T) {
	store := &fakeStore{}
	if _, err := segmentSvc(openPlans(), store, nil).Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{}); err != nil {
		t.Fatalf("Funnel: %v", err)
	}
	if !store.filter.IsZero() {
		t.Errorf("фильтр без сегмента: %+v", store.filter)
	}
}

// Сегмент — ключ analytics_segments; сегмент по источнику — ещё и analytics_sources,
// иначе закрытая разбивка источников читалась бы сегментами по одному. Воронка при
// этом открыта: закрыт именно разрез.
func TestSegment_Gates(t *testing.T) {
	ctx := context.Background()
	phone := domain.Segment{Dim: domain.SegDevice, Value: "Телефон"}
	vk := domain.Segment{Dim: domain.SegSource, Value: "vk.com"}

	closedSegments := segmentSvc(keyPlans{entitlements.AnalyticsSegments: true}, &fakeStore{}, nil)
	if _, err := closedSegments.Funnel(ctx, uuid.New(), uuid.New(), domain.Period{}, phone); !errors.Is(err, domain.ErrPlanRequired) {
		t.Errorf("сегмент при закрытом analytics_segments: %v, ждали ErrPlanRequired", err)
	}
	if _, err := closedSegments.Insights(ctx, uuid.New(), uuid.New(), domain.Period{}, phone); !errors.Is(err, domain.ErrPlanRequired) {
		t.Errorf("карточки с сегментом: %v, ждали ErrPlanRequired", err)
	}
	if _, err := closedSegments.Funnel(ctx, uuid.New(), uuid.New(), domain.Period{}, domain.Segment{}); err != nil {
		t.Errorf("воронка без сегмента закрылась вместе с сегментами: %v", err)
	}

	closedSources := segmentSvc(keyPlans{entitlements.AnalyticsSources: true}, &fakeStore{}, nil)
	if _, err := closedSources.Funnel(ctx, uuid.New(), uuid.New(), domain.Period{}, vk); !errors.Is(err, domain.ErrPlanRequired) {
		t.Errorf("сегмент по источнику при закрытых источниках: %v, ждали ErrPlanRequired", err)
	}
	if _, err := closedSources.Funnel(ctx, uuid.New(), uuid.New(), domain.Period{}, phone); err != nil {
		t.Errorf("сегмент по устройству закрыли источники: %v", err)
	}
}

// Сегмент по версии — id версии с этим номером; номера нет — пустой список (ноль
// визитов), а не «все».
func TestSegment_VersionByNumber(t *testing.T) {
	v1, v2 := uuid.New(), uuid.New()
	versions := []forms.Version{
		{ID: v1, Number: 1, Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[]}`)},
		{ID: v2, Number: 2, Schema: json.RawMessage(`{"schemaVersion":1,"blocks":[]}`)},
	}
	store := &fakeStore{}
	svc := segmentSvc(openPlans(), store, versions)

	if _, err := svc.Funnel(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{Dim: domain.SegVersion, Value: "2"}); err != nil {
		t.Fatalf("Funnel: %v", err)
	}
	if store.filter.Kind != domain.FilterVersion || len(store.filter.Keys) != 1 || store.filter.Keys[0] != v2.String() {
		t.Errorf("фильтр версии = %+v, ждали %s", store.filter, v2)
	}
	if _, err := svc.Insights(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{Dim: domain.SegVersion, Value: "9"}); err != nil {
		t.Fatalf("Insights: %v", err)
	}
	if store.filter.IsZero() || len(store.filter.Keys) != 0 {
		t.Errorf("несуществующая версия: %+v, ждали пустой список", store.filter)
	}
}

// Разрез по версиям: свежие сверху, номер и дата — из модуля форм, версии без
// визитов в окне не показываются.
func TestVersions_FreshFirstOnlyWithVisits(t *testing.T) {
	v1, v2, v3 := uuid.New(), uuid.New(), uuid.New()
	published := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	versions := []forms.Version{{ID: v1, Number: 1}, {ID: v2, Number: 2, PublishedAt: published}, {ID: v3, Number: 3}}
	store := &fakeStore{versionStat: map[uuid.UUID]domain.VersionStat{
		v1: {Visits: 10, Submitted: 2},
		v2: {Visits: 30, Submitted: 15},
	}}
	got, err := segmentSvc(openPlans(), store, versions).Versions(context.Background(), uuid.New(), uuid.New(), domain.Period{}, domain.Segment{})
	if err != nil {
		t.Fatalf("Versions: %v", err)
	}
	if len(got) != 2 || got[0].Number != 2 || got[1].Number != 1 {
		t.Fatalf("версии: %+v", got)
	}
	if !got[0].PublishedAt.Equal(published) || got[0].Visits != 30 || got[0].Submitted != 15 {
		t.Errorf("версия 2: %+v", got[0])
	}
}
