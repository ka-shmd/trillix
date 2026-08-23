package domain

// Action — действие в пространстве, право на которое можно спросить.
//
// ЧТО спрашивают живёт здесь, а КТО отвечает — в internal/workspaces (роль,
// матрица «роль × действие», функция Can). Разделение вынужденное и полезное
// сразу по двум причинам:
//
//   - без него был бы цикл импортов: workspaces спрашивает лимиты у
//     entitlements, а entitlements спрашивает право показать тариф — и оба не
//     могут импортировать друг друга;
//   - потребитель объявляет нужный ему интерфейс сам (`Can(…, domain.Action)`),
//     не притаскивая весь модуль прав ради одной константы.
//
// Правило, ради которого это всё (ADR §10, internal/CLAUDE.md): код спрашивает
// «можно ли ДЕЙСТВИЕ», а не «какая роль». Персональные исключения («всё, кроме
// удаления форм») тогда приезжают таблицей и десятком строк внутри Can — ни
// одна точка вызова не меняется. Спроси код про роль — и то же изменение
// потребует тронуть весь бэк.
type Action string

const (
	// ActionFormRead — видеть формы пространства, их ответы и аналитику.
	ActionFormRead Action = "form.read"
	// ActionFormWrite — создавать и править формы, публиковать и закрывать.
	ActionFormWrite Action = "form.write"
	// ActionFormDelete — удалять форму вместе с её ответами. Отдельно от
	// ActionFormWrite намеренно: это первое, что владелец захочет запретить
	// персонально, и действие обязано быть спрашиваемым по отдельности.
	ActionFormDelete Action = "form.delete"
	// ActionSubmissionDelete — удалять ответы респондентов.
	ActionSubmissionDelete Action = "submission.delete"
	// ActionBillingView — видеть тариф пространства и управлять им.
	ActionBillingView Action = "billing.view"
	// ActionMemberRead — видеть список участников.
	ActionMemberRead Action = "member.read"
	// ActionMemberManage — приглашать, отзывать доступ, менять роли.
	ActionMemberManage Action = "member.manage"
	// ActionWorkspaceManage — править само пространство: пока это только
	// переименование. Отдельно от ActionMemberManage намеренно: состав и
	// вывеска — разные вещи, и разрешать их вместе значит запретить их порознь.
	ActionWorkspaceManage Action = "workspace.manage"
	// ActionWorkspaceDelete — удалить пространство со всеми его формами и
	// ответами. Отдельно от ActionWorkspaceManage по той же причине, по которой
	// form.delete отделён от form.write: это необратимо, и запретить его
	// персонально захотят раньше всего остального.
	ActionWorkspaceDelete Action = "workspace.delete"
	// ActionIntegrationRead — видеть, подключён ли внешний аккаунт к пространству
	// и какие формы в него льют. Отдельно от ActionFormRead: интеграция — не
	// форма и не её аналитика, а канал наружу, и спрашивать про неё формой
	// значило бы, что запретить её порознь нельзя.
	ActionIntegrationRead Action = "integration.read"
	// ActionIntegrationManage — подключать и отключать внешний аккаунт
	// (Google). Отдельно и строже, чем ActionFormWrite: подключение решает,
	// куда уезжают персональные данные респондентов, — это решение владельца
	// пространства. Привязка КОНКРЕТНОЙ формы к таблице этим действием не
	// гейтится: она идёт под ActionFormWrite, потому что редактор и так правит
	// формы и видит ответы.
	ActionIntegrationManage Action = "integration.manage"
)

// Действия без потребителя здесь НЕ заводятся (PROCESS §2): объявленное, но не
// спрашиваемое право — обещание, которого система не держит.
