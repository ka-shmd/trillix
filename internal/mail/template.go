package mail

import (
	"bytes"
	"fmt"
	"text/template"
)

// Шаблоны писем. Именуются типом Template (он же едет в payload строки outbox),
// рендер — общий (Render), чтобы разные транспорты (dev-лог, будущий провайдер,
// шлющий сырой текст) не дублировали вёрстку. Провайдер, рендерящий шаблоны у
// себя по id, Render игнорирует и маппит Template на свой идентификатор.
const (
	// TemplatePasswordReset — письмо со ссылкой сброса пароля. Data: {"link": "<url>"}.
	TemplatePasswordReset Template = "password_reset"
	// TemplateEmailVerification — письмо со ссылкой подтверждения email. Data: {"link": "<url>"}.
	TemplateEmailVerification Template = "email_verification"
	// TemplateWorkspaceInvite — приглашение в пространство. Data:
	// {"link": "<url>", "workspace": "<название>", "inviter": "<email позвавшего>"}.
	TemplateWorkspaceInvite Template = "workspace_invite"
	// TemplateSubmissionNew — письмо владельцу о новом ответе, ОДНО НА ОДИН ответ.
	// Data: {"form_title": "<название>", "link": "<url таблицы>"}; при неудавшейся
	// печати вложения диспетчер добавляет {"pdf_failed": true}.
	//
	// ⚠ Значение осталось "submission_digest", хотя дайджеста больше нет (ADR §10,
	// отмена 2026-08-30): это значение лежит в payload строк outbox, поставленных до
	// перехода. Переименуй — и такая строка станет «неизвестным шаблоном», то есть
	// вечным ретраем: dead-letter у outbox нет.
	TemplateSubmissionNew Template = "submission_digest"
	// TemplateEmailChangeConfirm — письмо со ссылкой подтверждения НОВОГО адреса
	// (фаза 23, слайс D). Уходит на новый адрес. Data: {"link": "<url>"}.
	TemplateEmailChangeConfirm Template = "email_change_confirm"
	// TemplateEmailChangeNotice — уведомление на СТАРЫЙ адрес о запросе смены.
	// Ссылки-токена не несёт. Data: {"new_email": "<адрес>"}.
	TemplateEmailChangeNotice Template = "email_change_notice"
	// TemplatePasswordChanged — уведомление о смене пароля (фаза 23, слайс C).
	// Data: {"link": "<url восстановления>"}. Ссылки-токена в нём нет: письмо не
	// даёт никаких прав, а только сообщает о случившемся.
	TemplatePasswordChanged Template = "password_changed"
)

type mailTemplate struct {
	subject string
	body    *template.Template
}

// Письма — plain text: провайдеро-независимо и достаточно для сброса; HTML-вёрстка
// под mail-tester приедет с провайдерским транспортом (слайс E). text/template, а
// не html/template: экранирование HTML тексту письма не нужно и ломало бы ссылку.
var templates = map[Template]mailTemplate{
	TemplatePasswordReset: {
		subject: "Сброс пароля в Trillix",
		body: template.Must(template.New("password_reset").Parse(
			"Здравствуйте!\n\n" +
				"Вы запросили сброс пароля. Чтобы задать новый, перейдите по ссылке " +
				"(она действует 30 минут):\n\n" +
				"{{.link}}\n\n" +
				"Если сброс запрашивали не вы — просто не переходите по ссылке, " +
				"пароль останется прежним.\n\n" +
				"— Trillix",
		)),
	},
	TemplateEmailVerification: {
		subject: "Подтверждение почты в Trillix",
		body: template.Must(template.New("email_verification").Parse(
			"Здравствуйте!\n\n" +
				"Вы зарегистрировались в Trillix. Чтобы подтвердить, что этот адрес " +
				"ваш, перейдите по ссылке (она действует 24 часа):\n\n" +
				"{{.link}}\n\n" +
				"Если вы не регистрировались в Trillix — просто не переходите по " +
				"ссылке, письмо можно удалить.\n\n" +
				"— Trillix",
		)),
	},
	TemplateWorkspaceInvite: {
		subject: "Приглашение в пространство Trillix",
		body: template.Must(template.New("workspace_invite").Parse(
			"Здравствуйте!\n\n" +
				"{{.inviter}} приглашает вас в пространство «{{.workspace}}» в Trillix. " +
				"Чтобы принять приглашение, перейдите по ссылке (она действует 7 дней):\n\n" +
				"{{.link}}\n\n" +
				"Если вы не ждали приглашения — просто не переходите по ссылке, " +
				"письмо можно удалить.\n\n" +
				"— Trillix",
		)),
	},
	TemplateSubmissionNew: {
		subject: "Новый ответ в Trillix",
		body: template.Must(template.New("submission_digest").Parse(
			"Здравствуйте!\n\n" +
				"На форму «{{.form_title}}» пришёл новый ответ.\n\n" +
				// Строка про неудавшуюся печать — единственный способ сказать владельцу,
				// что вложение обещано настройкой, но не приехало. В СВОЁМ тексте автора
				// её нет и быть не может: свой текст заменяет тело целиком (Render).
				"{{if .pdf_failed}}Приложить PDF с ответом не удалось — сервис печати не " +
				"ответил. Документ можно скачать в таблице ответов.\n\n{{end}}" +
				"Открыть таблицу ответов:\n\n" +
				"{{.link}}\n\n" +
				"Уведомления можно отключить в настройках формы.\n\n" +
				"— Trillix",
		)),
	},
	TemplateEmailChangeConfirm: {
		subject: "Подтверждение нового адреса в Trillix",
		body: template.Must(template.New("email_change_confirm").Parse(
			"Здравствуйте!\n\n" +
				"Этот адрес указан как новый для аккаунта в Trillix. Чтобы перенести " +
				"аккаунт на него, перейдите по ссылке (она действует 24 часа):\n\n" +
				"{{.link}}\n\n" +
				"Пока вы не перешли по ссылке, вход остаётся по прежнему адресу.\n\n" +
				"Если вы ничего не меняли — просто не переходите по ссылке, " +
				"письмо можно удалить.\n\n" +
				"— Trillix",
		)),
	},
	TemplateEmailChangeNotice: {
		subject: "Запрошена смена адреса в Trillix",
		body: template.Must(template.New("email_change_notice").Parse(
			"Здравствуйте!\n\n" +
				"Для вашего аккаунта в Trillix запрошена смена адреса на {{.new_email}}. " +
				"Пока новый адрес не подтверждён, вход остаётся по этому.\n\n" +
				"Если это сделали не вы — смените пароль: пока адрес прежний, " +
				"восстановление аккаунта ходит на него.\n\n" +
				"— Trillix",
		)),
	},
	TemplatePasswordChanged: {
		subject: "Пароль в Trillix изменён",
		body: template.Must(template.New("password_changed").Parse(
			"Здравствуйте!\n\n" +
				"Пароль от вашего аккаунта в Trillix только что изменён, а все " +
				"остальные сеансы завершены.\n\n" +
				"Если это сделали вы — ничего делать не нужно.\n\n" +
				"Если нет — восстановите доступ по ссылке «Забыли пароль?»:\n\n" +
				"{{.link}}\n\n" +
				"— Trillix",
		)),
	},
}

// DefaultSubject — тема письма, которую поставит шаблон, если автор не задал свою.
// Существует ради БЛАНКА ПИСЬМА в настройках формы: он показывает автору настоящий
// текст, а не подсказку, и брать этот текст ему больше негде. Копия строки на фронте
// была бы зеркалом без сторожа — разошлась бы на первой же правке шаблона.
//
// Неизвестный шаблон даёт пустую строку: это подпись в интерфейсе, а не доставка.
func DefaultSubject(t Template) string {
	return templates[t].subject
}

// Render разворачивает письмо в тему и тело. Неизвестный шаблон — ошибка (в норме
// не бывает, Template задаём мы). Вызывается реализациями Mailer.
//
// ПЕРЕБИВКИ АВТОРА СИЛЬНЕЕ ШАБЛОНА и заменяют его часть целиком: своя тема — вместо
// темы, свой текст — вместо тела. Подстановок в авторском тексте пока НЕТ (задача в
// BACKLOG.md), поэтому он не проходит через template.Execute вовсе: чужой текст с
// «{{» иначе стал бы либо ошибкой рендера, либо дырой в шаблонизаторе.
func Render(msg EmailMessage) (subject, body string, err error) {
	t, ok := templates[msg.Template]
	if !ok {
		return "", "", fmt.Errorf("unknown email template %q", msg.Template)
	}
	subject = t.subject
	if msg.Subject != "" {
		subject = msg.Subject
	}
	if msg.Body != "" {
		return subject, msg.Body, nil
	}
	var buf bytes.Buffer
	if err := t.body.Execute(&buf, msg.Data); err != nil {
		return "", "", fmt.Errorf("render email %q: %w", msg.Template, err)
	}
	return subject, buf.String(), nil
}
