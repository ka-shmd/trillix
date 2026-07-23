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
}

// Render разворачивает письмо в тему и тело. Неизвестный шаблон — ошибка (в норме
// не бывает, Template задаём мы). Вызывается реализациями Mailer.
func Render(msg EmailMessage) (subject, body string, err error) {
	t, ok := templates[msg.Template]
	if !ok {
		return "", "", fmt.Errorf("unknown email template %q", msg.Template)
	}
	var buf bytes.Buffer
	if err := t.body.Execute(&buf, msg.Data); err != nil {
		return "", "", fmt.Errorf("render email %q: %w", msg.Template, err)
	}
	return t.subject, buf.String(), nil
}
