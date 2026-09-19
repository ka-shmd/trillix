package visits

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/entitlements"
	"github.com/ka-shmd/trillix/internal/forms"
	"github.com/ka-shmd/trillix/internal/geo"
	"github.com/ka-shmd/trillix/internal/postgres"
)

// maxMetaFieldLen — потолок длины строк меты (user_agent, referer, значения utm):
// обрезаем, чтобы раздутый заголовок не распухал JSONB. Совпадает по значению с
// submissions, но свой — модули не делят константы.
const maxMetaFieldLen = 512

// utmKeys — что считаем меткой источника. Список закрытый, а не «всё, что начинается
// на utm_»: иначе публичная ручка на запись превращается в приём произвольного
// словаря от клиента (раздувание JSONB, мусор в аналитике).
var utmKeys = [...]string{"utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"}

// Forms — коллаборатор из модуля forms: отдаёт опубликованную форму по slug (запись
// визита) и авторизует доступ автора к форме (чтение воронки). Реализация —
// *forms.Service; общение через интерфейс сервиса (не чужой repo).
type Forms interface {
	// PublicFormRef — форма БЕЗ документа: биконy нужны только id, номер версии и
	// настройки закрытия, а схема это JSONB в TOAST, и на самом частом публичном
	// запросе она читалась вхолостую (TD-77).
	PublicFormRef(ctx context.Context, slug string) (forms.PublicFormRef, error)
	// Get авторизует доступ автора к форме и отдаёт её — воронке нужен
	// workspace_id, чтобы спросить у тарифа право на просмотр (фаза 17).
	Get(ctx context.Context, userID, formID uuid.UUID) (forms.Form, error)
	// Versions авторизует доступ (чужая/несуществующая → domain.ErrNotFound,
	// анти-IDOR) и отдаёт опубликованные версии: их схемы дают воронке порядок и
	// подписи вопросов — тот же список, что у выгрузки и сводки.
	Versions(ctx context.Context, userID, formID uuid.UUID) ([]forms.Version, error)
}

// Plans — коллаборатор из модуля entitlements: единственная точка «можно ли»
// (ADR §10). Реализация — *entitlements.Service.
//
// Гейт стоит на ЧТЕНИИ воронки, а не на записи визита: визиты собираются для
// всех планов без исключения. Иначе в момент апселла показывать было бы нечего
// и плашка «откройте Pro» рекламировала бы пустоту.
type Plans interface {
	CheckWorkspace(ctx context.Context, workspaceID uuid.UUID, key entitlements.Key) (entitlements.Decision, error)
}

// Geo — справочник «адрес → место». Реализация — *geo.Service; nil означает
// «на контуре справочника нет», и это законное состояние: Lookup у nil-сервиса
// отдаёт пустое место, поэтому ветки «а настроено ли гео» здесь нет.
type Geo interface {
	Lookup(ip string) geo.Place
	// Configured отличает «справочника на контуре нет» от «есть, но ни одного
	// места не определили». Списки в обоих случаях пустые, а означают разное:
	// первое прячет блок, второе объясняет пустоту.
	Configured() bool
}

// Store — доступ к данным visits, объявленный на стороне потребителя.
type Store interface {
	UpsertVisit(ctx context.Context, db postgres.DBTX, id, formID, versionID uuid.UUID, lastBlockID *string, seq int16, meta json.RawMessage, place geo.Place, visitorKey []byte) error
	MarkSubmitted(ctx context.Context, db postgres.DBTX, id, formID uuid.UUID) (int64, error)
	InsertPage(ctx context.Context, db postgres.DBTX, visitID, formID uuid.UUID, blockID string) error
	CountByLastBlock(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.LastBlockCount, error)
	CountPaths(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.PathCount, error)
	PageSpans(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.PageSpan, error)
	Insights(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) (domain.VisitInsights, error)
	Timeseries(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period, step domain.BucketStep) ([]domain.TimeBucket, error)
	Countries(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.PlaceCount, error)
	Cities(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.PlaceCount, error)
	Sources(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.SourceRow, error)
	UserAgents(ctx context.Context, db postgres.DBTX, formID uuid.UUID, period domain.Period) ([]domain.UserAgentRow, error)
}

var _ Store = Repo{}

// Visit — то, что присылает бикон рендерера. Version — номер версии, которую
// РЕАЛЬНО открыл человек (не «текущая опубликованная»): без него визит переклеился
// бы на свежую версию после переиздания, и last_block_id искали бы в чужой схеме.
// LastBlockID nil — «открыл, но ни одного вопроса не коснулся».
type Visit struct {
	ID          uuid.UUID
	Version     int32
	LastBlockID *string
	Seq         int16
	// Page — бикон перехода: LastBlockID — первый вопрос открытой страницы, и она
	// ложится в путь визита. Старые бандлы рендерера флага не шлют — визит без пути.
	Page      bool
	UserAgent string
	Referer   string
	UTM       map[string]string
	// IP нужен РОВНО для одного: определить страну и город по локальному
	// справочнику. Дальше сервиса он не уходит — ни в БД, ни в лог, ни в хеше
	// (ADR §10). Поле не сериализуется и в теле бикона его нет: адрес берётся из
	// соединения, а не со слов клиента.
	IP string
}

// Service — запись визитов и чтение воронки.
type Service struct {
	db    postgres.DBTX
	forms Forms
	plans Plans
	repo  Store
	geo   Geo
	// visitorSecret — из него выводится суточная соль ключа посетителя. Не читается
	// из окружения: выводится из секрета токена формы с меткой назначения
	// (deriveVisitorSecret) — своей переменной у аналитики нет намеренно.
	visitorSecret []byte
	now           func() time.Time // подменяется в тестах (проверка даты закрытия)
}

// NewService принимает секрет токена формы (тот же, что у публичных ручек): из него
// выводится ключ аналитики. Пустой секрет означает «уникальных не считаем».
func NewService(db postgres.DBTX, forms Forms, plans Plans, repo Store, geoSvc Geo, formTokenSecret []byte) *Service {
	return &Service{
		db: db, forms: forms, plans: plans, repo: repo, geo: geoSvc,
		visitorSecret: deriveVisitorSecret(formTokenSecret), now: time.Now,
	}
}

// Record записывает визит. Порядок повторяет приём ответа: резолв формы (черновик/
// нет → 404, приватное не раскрывается) → «форма закрыта» → валидация → запись.
//
// Закрытая форма визит НЕ пишет (410). Рендерер до бикона и не дойдёт — GET закрытой
// отдаёт 410 и вместо формы рисуется «приём закрыт», — но ручка публичная, и
// принимать по ней то, чего не бывает в жизни, значит открывать способ портить
// владельцу конверсию визитами, которые ответом закончиться не могли.
func (s *Service) Record(ctx context.Context, slug string, v Visit) error {
	pf, err := s.forms.PublicFormRef(ctx, slug)
	if err != nil {
		return err
	}
	if domain.FormClosed(pf.Status, pf.CloseAt, pf.ResponseLimit, pf.SubmissionCount, s.now().UTC()) {
		return domain.ErrFormClosed
	}

	// Версия из бикона обязана совпасть с опубликованной сейчас. Расхождение = форму
	// переиздали между открытием страницы и биконом; окно микроскопическое (бикон
	// «открыли» уходит через миллисекунды после GET), и терять такой визит честнее,
	// чем приписать его версии, которой человек не видел. Ищем именно ЭТУ ошибку, а
	// не «версия не найдена»: form_version_id берём из pf, второй запрос не нужен.
	if v.Version != pf.Version {
		return fmt.Errorf("%w: форма переиздана", domain.ErrValidation)
	}

	if v.Seq < 0 {
		return fmt.Errorf("%w: неверный seq", domain.ErrValidation)
	}
	if v.LastBlockID != nil {
		id := *v.LastBlockID
		if id == "" || len(id) > domain.MaxIDLen || !utf8.ValidString(id) {
			return fmt.Errorf("%w: неверный last_block_id", domain.ErrValidation)
		}
	}

	// Существование блока в схеме НЕ проверяем: чужой id не портит данные — воронка
	// читает подписи из схемы версии и просто не найдёт его, а лишний разбор JSONB
	// схемы на каждом биконе оплачивался бы на самом частом публичном запросе.

	metaJSON, err := json.Marshal(s.buildMeta(v))
	if err != nil {
		return fmt.Errorf("marshal visit meta: %w", err)
	}

	// Место определяется ТОЛЬКО на первом биконе визита: у следующих адрес тот же,
	// а строка уже создана — апсерт гео не трогает. Так поиск по справочнику идёт
	// один раз на визит, а не на каждое переключение вкладки.
	// Место и ключ посетителя считаются ТОЛЬКО на первом биконе визита: у следующих
	// адрес тот же, строка уже создана, и апсерт эти колонки не трогает.
	var (
		place geo.Place
		key   []byte
	)
	if v.Seq == 0 {
		if s.geo != nil {
			place = s.geo.Lookup(v.IP)
		}
		key = visitorKey(s.visitorSecret, pf.FormID, v.IP, v.UserAgent, s.now())
	}
	if err := s.repo.UpsertVisit(ctx, s.db, v.ID, pf.FormID, pf.VersionID, v.LastBlockID, v.Seq, metaJSON, place, key); err != nil {
		return err
	}
	// Строка пути — после апсерта: вставка берёт визит выборкой по id и форме, и без
	// строки визита её не будет. Существование блока, как и у last_block_id, не
	// проверяется — неизвестный блок воронка на чтении отбрасывает.
	if v.Page && v.LastBlockID != nil {
		return s.repo.InsertPage(ctx, s.db, v.ID, pf.FormID, *v.LastBlockID)
	}
	return nil
}

func (s *Service) buildMeta(v Visit) map[string]string {
	meta := map[string]string{
		"user_agent": truncate(v.UserAgent, maxMetaFieldLen),
		"referer":    truncate(v.Referer, maxMetaFieldLen),
	}
	for _, k := range utmKeys {
		if val := truncate(v.UTM[k], maxMetaFieldLen); val != "" {
			meta[k] = val
		}
	}
	return meta
}

// MarkSubmitted отмечает визит как закончившийся ответом. Вызывается приёмом ответа
// ПОСЛЕ его коммита и best-effort: неизвестный или подделанный visitId даёт 0 строк
// и не является ошибкой — аналитика не имеет права отклонить принятый ответ.
func (s *Service) MarkSubmitted(ctx context.Context, formID, visitID uuid.UUID) error {
	_, err := s.repo.MarkSubmitted(ctx, s.db, visitID, formID)
	return err
}

// Funnel — воронка формы для её автора: на каком вопросе уходят.
//
// Порядок: авторизация через forms.Versions (чужая или несуществующая форма → 404,
// приватное не раскрывается — инвариант 1: id из URL правом доступа не является),
// затем ОДИН счётный запрос и чистая свёртка в домене.
//
// Модель вопросов — общая с выгрузкой и сводкой (domain.QuestionOrder): три экрана
// обязаны показывать один и тот же список вопросов.
func (s *Service) Funnel(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (domain.Funnel, error) {
	// Порядок обязателен: сначала АВТОРИЗАЦИЯ (чужая форма → 404, приватное не
	// раскрывается), только потом тариф (→ 402). Наоборот — и посторонний узнавал
	// бы по коду ответа, существует ли форма и какой у чужого воркспейса план.
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return domain.Funnel{}, err
	}
	d, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.AnalyticsFunnel)
	if err != nil {
		return domain.Funnel{}, err
	}
	if !d.Allowed {
		// Данные собраны и никуда не делись — закрыт только показ разбивки.
		// Число не дошедших кабинет берёт из счётчиков самой формы (они уже
		// загружены на странице), поэтому в теле отказа его дублировать незачем.
		return domain.Funnel{}, domain.ErrPlanRequired
	}

	versions, err := s.forms.Versions(ctx, userID, formID)
	if err != nil {
		return domain.Funnel{}, err
	}

	schemas := make([]domain.VersionedSchema, 0, len(versions))
	for _, v := range versions {
		schema, e := domain.ValidateSchema(v.Schema)
		if e != nil {
			// Опубликованный снапшот обязан быть валиден (проверен при публикации) —
			// сбой здесь означает нарушенный инвариант иммутабельности версии. %v, а
			// не %w: сентинел ErrValidation в цепочке увёл бы respond.go в 422 с
			// внутренним текстом наружу вместо 500 (тот же приём, что в submissions).
			return domain.Funnel{}, fmt.Errorf("parse version %d schema of form %s: %v", v.Number, formID, e)
		}
		schemas = append(schemas, domain.VersionedSchema{Version: int(v.Number), Schema: schema})
	}

	// Верх воронки (визиты и конверсия) выводится из той же разбивки, что и шаги, —
	// см. BuildFunnel. Путь и время на страницах читаются только у многостраничной
	// формы: у одностраничной строк пути нет, и два запроса были бы вхолостую.
	var data domain.FunnelData
	if data.Counts, err = s.repo.CountByLastBlock(ctx, s.db, formID, period); err != nil {
		return domain.Funnel{}, err
	}
	pages := domain.PageOrder(schemas)
	if pages != nil {
		if data.Paths, err = s.repo.CountPaths(ctx, s.db, formID, period); err != nil {
			return domain.Funnel{}, err
		}
		if data.Spans, err = s.repo.PageSpans(ctx, s.db, formID, period); err != nil {
			return domain.Funnel{}, err
		}
	}
	return domain.BuildFunnel(domain.QuestionOrder(schemas), pages, data), nil
}

// Insights — счётчики визитов за период для карточек над вкладками Insights.
//
// Гейта тарифа здесь НЕТ, и это не упущение: карточки — первое, что владелец видит
// после публикации формы, и замок на них рекламировал бы Pro вместо продукта.
// Платным остаётся разбор (воронка, источники), а не сам факт «сколько людей».
func (s *Service) Insights(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (domain.VisitInsights, error) {
	// Авторизация — тем же способом, что у воронки: чужая или несуществующая форма
	// даёт 404 (инвариант 1, id из URL правом доступа не является).
	if _, err := s.forms.Get(ctx, userID, formID); err != nil {
		return domain.VisitInsights{}, err
	}
	return s.repo.Insights(ctx, s.db, formID, period)
}

// Breakdown — вкладка «Визиты» целиком: ряд по времени, источники, устройства,
// браузеры, ОС (спека design/analytics-tally.md §8).
//
// Гейт стоит на ОДНОЙ секции, а не на всей вкладке: 402 на весь запрос закрыл бы
// заодно график и устройства, которые платными не объявлялись. Источники приезжают
// пустым списком с флагом и настоящим числом визитов, у которых источник известен, —
// плашка обязана показывать число владельца, а не рекламировать пустоту (ADR §10).
func (s *Service) Breakdown(ctx context.Context, userID, formID uuid.UUID, period domain.Period) (domain.VisitsBreakdown, error) {
	form, err := s.forms.Get(ctx, userID, formID)
	if err != nil {
		return domain.VisitsBreakdown{}, err
	}
	// Тариф спрашивается ПОСЛЕ авторизации: иначе код ответа рассказывал бы
	// постороннему и о существовании формы, и о плане чужого воркспейса.
	d, err := s.plans.CheckWorkspace(ctx, form.WorkspaceID, entitlements.AnalyticsSources)
	if err != nil {
		return domain.VisitsBreakdown{}, err
	}

	step := domain.StepFor(period)
	buckets, err := s.repo.Timeseries(ctx, s.db, formID, period, step)
	if err != nil {
		return domain.VisitsBreakdown{}, err
	}
	sources, err := s.repo.Sources(ctx, s.db, formID, period)
	if err != nil {
		return domain.VisitsBreakdown{}, err
	}
	countries, err := s.repo.Countries(ctx, s.db, formID, period)
	if err != nil {
		return domain.VisitsBreakdown{}, err
	}
	cities, err := s.repo.Cities(ctx, s.db, formID, period)
	if err != nil {
		return domain.VisitsBreakdown{}, err
	}
	agents, err := s.repo.UserAgents(ctx, s.db, formID, period)
	if err != nil {
		return domain.VisitsBreakdown{}, err
	}

	devices, browsers, systems := domain.FoldUserAgents(agents)
	// Визиты без места считаем вычитанием, а не отдельным запросом: сумма стран
	// известна, общее число визитов — тоже, и второй счётный запрос за тем же
	// числом дал бы ещё и возможность рассогласования между двумя выборками.
	total := 0
	for _, b := range buckets {
		total += b.Visits
	}
	withPlace := 0
	for _, c := range countries {
		withPlace += c.Visits
	}
	out := domain.VisitsBreakdown{
		Step:          step,
		Timeseries:    domain.FillBuckets(buckets, step, period.From, period.To),
		SourcesLocked: !d.Allowed,
		KnownSources:  domain.CountKnownSources(sources),
		Devices:       devices,
		Browsers:      browsers,
		Systems:       systems,
		Countries:     countries,
		Cities:        cities,
		UnknownPlace:  total - withPlace,
		GeoConfigured: s.geo != nil && s.geo.Configured(),
	}
	if d.Allowed {
		out.Sources = domain.FoldSources(sources)
	}
	return out, nil
}

// truncate режет строку по границе рун: обрезка по байтам оставила бы хвост битой
// руны, и JSONB получил бы невалидный UTF-8.
func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	for max > 0 && !utf8.RuneStart(s[max]) {
		max--
	}
	return s[:max]
}
