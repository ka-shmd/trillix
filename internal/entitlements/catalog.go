// Package entitlements — единственное место, где код спрашивает «можно ли».
//
// Три уровня, которые обычно слипаются в один `if plan == "free"`, здесь
// разведены (ADR §10, спека docs/DESIGN-billing.md §4):
//
//   - КАКИЕ гейты бывают — этот файл (код: компилятор ловит опечатку в ключе);
//   - ЧТО даёт каждый план — данные (plans.limits): меняется UPDATE'ом без выкатки;
//   - ГДЕ гейт применяется — вызов Check* в сервис-методе.
//
// Отсюда цена изменений, ради которой всё и затевалось: добавить возможность в
// платный тариф — строка здесь + строка в limits каждого плана + вызов в сервисе;
// открыть возможность всем — ОДИН UPDATE, код не трогается вовсе (вызов Check*
// остаётся на месте и с этого момента всегда разрешает — он же выключатель обратно).
//
// `if plan == …` вне этого пакета запрещён (internal/CLAUDE.md): рассыпанные
// проверки означают, что через полгода на вопрос «что входит в Pro» отвечает
// только греп, а страница тарифов начинает врать.
package entitlements

// Key — ключ возможности. Совпадает с ключом в plans.limits.
type Key string

const (
	// SubmissionsPerMonth — сколько ответов воркспейс принимает за расчётный
	// период. Основной рычаг монетизации: гейт стоит на уже созданной ценности.
	SubmissionsPerMonth Key = "submissions_per_month"
	// Workspaces — сколько воркспейсов может завести аккаунт. Ключ заведён, но
	// НЕ ПРОВЕРЯЕТСЯ: действия «создать воркспейс» в продукте нет (решение
	// владельца 2026-08-01), а гейт без действия непроверяем. Проверка приедет
	// вместе с созданием — вместе с CheckAccount (спека §5).
	Workspaces Key = "workspaces"
	// AnalyticsFunnel — воронка отвала: на каком вопросе уходят.
	AnalyticsFunnel Key = "analytics_funnel"
	// AnalyticsSources — источники трафика (utm). Ключ заведён, экрана ещё нет;
	// гейт включится вместе с экраном.
	AnalyticsSources Key = "analytics_sources"
)

// Kind — как читать значение ключа в plans.limits.
type Kind uint8

const (
	// Quota — число (или null = безлимит): «сколько можно».
	Quota Kind = iota + 1
	// Toggle — булев: «можно или нет».
	Toggle
)

// Scope — чей план разрешает возможность. Разделение не косметическое:
// аккаунт-уровневый лимит воркспейсом невыразим (нового воркспейса ещё нет,
// а старый к нему отношения не имеет), поэтому его разрешает план личного
// воркспейса-якоря — ADR §10.
type Scope uint8

const (
	// WorkspaceScope — спрашивается у плана самого воркспейса (CheckWorkspace).
	WorkspaceScope Scope = iota + 1
	// AccountScope — спрашивается у плана личного воркспейса аккаунта.
	// Обслуживающего метода (CheckAccount) сегодня НЕТ: у него нет потребителя,
	// а функция без вызывающего — запрещённая PROCESS §2 расширяемость.
	AccountScope
)

// Meter — откуда берётся израсходованное. Не выводится из Kind: Workspaces —
// тоже Quota, но её счётчик другой природы (число строк, не расход за период),
// и потребителя у него пока нет.
type Meter uint8

const (
	// NoMeter — расход не считается: Decision.Used всегда 0.
	NoMeter Meter = iota
	// SubmissionsMeter — расход берётся из workspace_usage.submissions за период.
	SubmissionsMeter
)

// Feature — описание возможности.
type Feature struct {
	Kind  Kind
	Scope Scope
	Meter Meter
	// Title — как возможность называется человеку (страница «Тариф»).
	Title string
}

// Catalog — исчерпывающее описание возможностей. Каждый план обязан назвать
// КАЖДЫЙ ключ отсюда: молчание плана не должно значить ни «разрешено», ни
// «запрещено» — оно обязано краснеть (TestPlansCoverCatalog). Именно из
// «забыли ключ → случайно раздали Pro бесплатно» берутся дорогие сюрпризы.
// CatalogOrder — порядок возможностей для человека (страница «Тариф»). Отдельно
// от Catalog, потому что обход map в Go рандомизирован: без явного порядка список
// на странице прыгал бы при каждом запросе. Новый ключ добавляется в ОБА места —
// иначе он не покажется, и это ловит тест.
var CatalogOrder = []Key{
	SubmissionsPerMonth,
	AnalyticsFunnel,
	AnalyticsSources,
	Workspaces,
}

var Catalog = map[Key]Feature{
	SubmissionsPerMonth: {Kind: Quota, Scope: WorkspaceScope, Meter: SubmissionsMeter, Title: "Ответов в месяц"},
	Workspaces:          {Kind: Quota, Scope: AccountScope, Meter: NoMeter, Title: "Воркспейсов"},
	AnalyticsFunnel:     {Kind: Toggle, Scope: WorkspaceScope, Meter: NoMeter, Title: "Воронка отвала"},
	AnalyticsSources:    {Kind: Toggle, Scope: WorkspaceScope, Meter: NoMeter, Title: "Источники трафика"},
}
