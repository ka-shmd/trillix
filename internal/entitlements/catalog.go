// Package entitlements — единственное место, где код спрашивает «можно ли».
//
// Три уровня, которые обычно слипаются в один `if plan == "free"`, здесь
// разведены (ADR §10, спека docs/design/billing.md §4):
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
	// Workspaces — сколько пространств может завести аккаунт. Считаются те,
	// которыми он ВЛАДЕЕТ, а не те, где состоит: иначе владелец Pro не смог бы
	// позвать ни одного человека с Free — а звать он будет именно их (ADR §10).
	Workspaces Key = "workspaces"
	// MembersPerWorkspace — сколько человек помещается в пространство (считая
	// владельца). Гейт стоит на приглашении: «позвать коллегу» — это и есть
	// момент, когда команда становится командой.
	MembersPerWorkspace Key = "members_per_workspace"
	// AnalyticsFunnel — воронка отвала: на каком вопросе уходят.
	AnalyticsFunnel Key = "analytics_funnel"
	// AnalyticsSources — источники трафика (utm). Ключ заведён, экрана ещё нет;
	// гейт включится вместе с экраном.
	AnalyticsSources Key = "analytics_sources"
	// FormDesignCustom — свои значения оформления: цвета, шрифт, ширина, кегль,
	// скругление, кнопка (фаза 22). ОБЕ ТЕМЫ, светлая и тёмная, бесплатны
	// намеренно: гейт ставится на созданную ценность, а не на настройку, и право
	// выбрать одну из двух тем — это право завести пустую папку. Новичок должен
	// получить «выглядит прилично» даром; платят за «выглядит как мы».
	//
	// Спрашивается на ПУБЛИКАЦИИ, а не на сохранении: автосейв не имеет права
	// вернуть 402 посреди набора (спека design/theme.md §9.3).
	FormDesignCustom Key = "form_design_custom"
	// FormCustomCSS — свой CSS формы. Отдельным ключом от остального оформления и
	// дороже: это не настройка, а доступ к вёрстке. Ключ заведён, точки применения
	// ещё нет — она приезжает слайсом 7 (как сегодня у analytics_sources).
	FormCustomCSS Key = "form_custom_css"
	// FormBranding — право снять бейдж «Сделано в Trillix» с публичной формы.
	//
	// ГЕЙТ ДРУГОЙ ПРИРОДЫ, чем у оформления, и это осознанно: цвет уехал в снапшот
	// и обязан пережить даунгрейд (за него платили тогда), а бейдж — свойство
	// ВЫДАЧИ, а не документа. Лежи он в снапшоте, один месяц оплаты навсегда снял
	// бы бейдж со всех опубликованных в этот месяц форм — это не подписка, а
	// разовая покупка. Поэтому спрашивается при отдаче публичной формы.
	FormBranding Key = "form_branding"
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
	// AccountScope — спрашивается у подписки самого аккаунта (CheckAccount):
	// нового воркспейса ещё нет, а старый к нему отношения не имеет.
	AccountScope
)

// Meter — откуда берётся израсходованное. Не выводится из Kind: Workspaces —
// тоже Quota, но её счётчик другой природы (число строк здесь и сейчас, а не
// расход, накопленный за расчётный период).
type Meter uint8

const (
	// NoMeter — расход не считается: Decision.Used всегда 0.
	NoMeter Meter = iota
	// SubmissionsMeter — расход берётся из workspace_usage.submissions за период.
	SubmissionsMeter
	// MembersMeter — израсходовано = сколько человек уже в пространстве.
	// Периода нет: выгнал участника — место освободилось сразу.
	MembersMeter
	// WorkspacesMeter — израсходовано = сколько пространств аккаунт уже держит
	// (строки workspace_members с role='owner'). Периода у этого счётчика нет:
	// удалил пространство — освободилось место, ждать первого числа не нужно.
	WorkspacesMeter
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
	MembersPerWorkspace,
	AnalyticsFunnel,
	AnalyticsSources,
	FormDesignCustom,
	FormCustomCSS,
	FormBranding,
	Workspaces,
}

var Catalog = map[Key]Feature{
	SubmissionsPerMonth: {Kind: Quota, Scope: WorkspaceScope, Meter: SubmissionsMeter, Title: "Ответов в месяц"},
	Workspaces:          {Kind: Quota, Scope: AccountScope, Meter: WorkspacesMeter, Title: "Пространств"},
	MembersPerWorkspace: {Kind: Quota, Scope: WorkspaceScope, Meter: MembersMeter, Title: "Участников"},
	AnalyticsFunnel:     {Kind: Toggle, Scope: WorkspaceScope, Meter: NoMeter, Title: "Воронка отвала"},
	AnalyticsSources:    {Kind: Toggle, Scope: WorkspaceScope, Meter: NoMeter, Title: "Источники трафика"},
	FormDesignCustom:    {Kind: Toggle, Scope: WorkspaceScope, Meter: NoMeter, Title: "Своё оформление"},
	FormCustomCSS:       {Kind: Toggle, Scope: WorkspaceScope, Meter: NoMeter, Title: "Свой CSS"},
	FormBranding:        {Kind: Toggle, Scope: WorkspaceScope, Meter: NoMeter, Title: "Без бейджа Trillix"},
}
