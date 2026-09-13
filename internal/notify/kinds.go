package notify

import (
	"fmt"
	"strings"

	"github.com/ka-shmd/trillix/internal/domain"
)

// Kind — повод уведомления. Значение уезжает в колонку kind как есть.
type Kind string

const (
	// KindNewSubmissions — на форме новые ответы. Повод-СЧЁТЧИК: интерес к нему
	// исчезает от прочтения, поэтому отбоя у него нет — прочтение и есть отбой.
	KindNewSubmissions Kind = "new_submissions"
	// KindIntegrationBroken — цель доставки (связка Таблиц или вебхук) не
	// принимает. Повод-ПРЕПЯТСТВИЕ: прочтение его не отменяет, отменяет починка.
	KindIntegrationBroken Kind = "integration_broken"
	// KindOverQuota — ответы пошли сверх лимита тарифа. Препятствие, но чинится
	// не кнопкой, а новым периодом либо тарифом.
	KindOverQuota Kind = "over_quota"
)

// Payload — снимок, из которого собираются текст и ссылка. Хранится в JSONB.
//
// Снимок, а не JOIN на живые таблицы: причина поломки живёт в last_error ЦЕЛИ и
// затирается починкой, а уведомление обязано помнить, что было. Ответов
// респондента здесь нет и быть не может — это ПДн, обрабатываемые по поручению
// (ADR §10), а снимок рассчитан на отправку в мессенджер.
type Payload struct {
	FormTitle  string `json:"formTitle,omitempty"`
	FormSlug   string `json:"formSlug,omitempty"`
	Target     string `json:"target,omitempty"`     // sheet | webhook
	TargetName string `json:"targetName,omitempty"` // имя цели, данное автором
	Reason     string `json:"reason,omitempty"`     // причина отказа — ТА ЖЕ, что у цели и в журнале доставок
	Period     string `json:"period,omitempty"`     // YYYY-MM у over_quota: по нему рвётся склейка на границе месяца
}

// spec — описание повода в реестре.
type spec struct {
	// action — какое право надо иметь в пространстве, чтобы получить повод.
	// Действие, а не роль: сравнение с ролью вне workspaces запрещено.
	action domain.Action
	// obstacle — повод-препятствие: у него есть парная точка отбоя, и гаснет он
	// не прочтением, а устранением причины (ADR §10).
	obstacle bool
	text     func(p Payload, count int32) string
	link     func(p Payload, workspaceSlug string) string
}

// registry — ЕДИНСТВЕННОЕ место, где повод описан. Молчание реестра про повод
// означает, что повода нет: неизвестный kind лента пропускает, а не показывает
// пустой строкой (см. Service.Feed).
var registry = map[Kind]spec{
	KindNewSubmissions: {
		action: domain.ActionFormRead,
		text: func(p Payload, count int32) string {
			return fmt.Sprintf("%s — %s", formTitle(p),
				domain.Plural(int64(count), "новый ответ", "новых ответа", "новых ответов"))
		},
		// Адрес раздела ответов, а не вкладки: вкладку человек выбирает сам, а
		// старый /responses — редирект, оставленный ради уже разосланных писем.
		link: func(p Payload, _ string) string { return "/forms/" + p.FormSlug + "/submissions" },
	},
	KindIntegrationBroken: {
		action:   domain.ActionFormRead,
		obstacle: true,
		text: func(p Payload, _ int32) string {
			// Причина уже человеческая и уже наша: её написали brokenReason и
			// webhookFailureReason, она же лежит у цели и в журнале доставок.
			// Своего текста отказа повод не сочиняет — три формулировки одного
			// отказа разъезжаются молча (ADR §10).
			return fmt.Sprintf("%s — %s: %s", formTitle(p), targetName(p), p.Reason)
		},
		link: func(p Payload, _ string) string { return "/forms/" + p.FormSlug + "/integrations" },
	},
	KindOverQuota: {
		action:   domain.ActionBillingView,
		obstacle: true,
		text: func(_ Payload, count int32) string {
			return fmt.Sprintf("Ответы сверх лимита тарифа: %d", count)
		},
		link: func(_ Payload, workspaceSlug string) string { return "/w/" + workspaceSlug + "/plan" },
	},
}

// AllKinds — все поводы, которые обязан называть реестр. Молчание реестра должно
// краснеть тестом, а не оборачиваться уведомлением без текста (тот же приём, что
// у workspaces.AllActions и каталога тарифов).
var AllKinds = []Kind{KindNewSubmissions, KindIntegrationBroken, KindOverQuota}

// formTitle — название формы для текста повода. Пустое имя показывается тем же
// словом, что и в списке форм кабинета: строка «— 3 новых ответа» без
// подлежащего читается как поломка, а не как форма без названия.
func formTitle(p Payload) string {
	if strings.TrimSpace(p.FormTitle) == "" {
		return "Без названия"
	}
	return p.FormTitle
}

// targetName — имя цели доставки. Автор вправе его не давать, и тогда цель
// называется своим видом.
func targetName(p Payload) string {
	if strings.TrimSpace(p.TargetName) != "" {
		return p.TargetName
	}
	if p.Target == "webhook" {
		return "вебхук"
	}
	return "таблица"
}
