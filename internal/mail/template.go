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
	// TemplateRespondentReceipt — письмо РЕСПОНДЕНТУ о том, что его ответ принят
	// (docs/design/respondent-email.md). Data: {"form_title": "<название>",
	// "form_link": "<публичный адрес формы>"}.
	//
	// Единственный шаблон с ПОДВАЛОМ: письмо уходит на адрес, который респондент
	// ввёл сам, и обязано объяснять получателю, откуда оно взялось, — даже когда
	// весь остальной текст написал автор формы.
	TemplateRespondentReceipt Template = "respondent_receipt"
	// TemplateBookingConfirmed — СЛУЖЕБНОЕ письмо о записи (фаза 27,
	// design/booking.md §4.8). Data: {"form_title", "when", "cancel_link", "form_link"}.
	//
	// Отдельное от квитанции и НЕГЕЙТИМОЕ: отмена — механизм самого расписания, а не
	// любезность респонденту. Ссылка отмены в квитанции означала бы, что на
	// бесплатном тарифе место до самого приёма стоит занятым, и теряет от этого
	// прежде всего автор. Автор это письмо не настраивает и не отключает.
	//
	// Подвал у него такой же неудаляемый, как у квитанции, и по той же причине: адрес
	// приезжает ответом на форму, то есть его вводит кто угодно.
	TemplateBookingConfirmed Template = "booking_confirmed"
	// TemplateBookingCanceled — письмо об отмене записи. Тем же адресатом и с тем же
	// приглашением, но методом CANCEL: клиент гасит событие в календаре.
	// Data: {"form_title", "when", "form_link"}.
	TemplateBookingCanceled Template = "booking_canceled"
	// TemplateBookingRescheduled — письмо о переносе записи автором. Приглашение —
	// REQUEST с тем же UID и бо́льшим номером редакции: календарь ДВИГАЕТ встречу, а
	// не заводит вторую. Data: {"form_title", "was", "when", "cancel_link",
	// "form_link"}.
	TemplateBookingRescheduled Template = "booking_rescheduled"
	// TemplatePasswordChanged — уведомление о смене пароля (фаза 23, слайс C).
	// Data: {"link": "<url восстановления>"}. Ссылки-токена в нём нет: письмо не
	// даёт никаких прав, а только сообщает о случившемся.
	TemplatePasswordChanged Template = "password_changed"
	// TemplateLoginCode — код второго фактора при входе с незнакомого устройства
	// (0056). Data: {"code": "123456"}.
	//
	// ⚠ Единственное письмо, чей payload — действующий секрет, поэтому доставленные
	// строки outbox с ним удаляются уборщиком (DeleteDeliveredOutboxByTemplate,
	// cmd/api/main.go): в БД код лежит под HMAC, и открытая копия в архиве outbox
	// сделала бы эту защиту декоративной. Появится второй такой шаблон — его надо
	// добавить в список уборщика, иначе секрет останется в архиве навсегда.
	TemplateLoginCode Template = "login_code"
	// TemplateTwoFactorChanged — уведомление о включении или выключении второго
	// фактора. Data: {"state": "включена" | "выключена"}.
	TemplateTwoFactorChanged Template = "two_factor_changed"
	// TemplateAccountActionCode — код подтверждения действия в настройках (смена
	// адреса, удаление аккаунта). Data: {"code": "123456"}. Хранилище кода общее
	// с TemplateLoginCode, и уборщик секретов (см. выше) обязан знать про оба.
	TemplateAccountActionCode Template = "account_action_code"
)

type mailTemplate struct {
	subject string
	body    *template.Template
	// footer — хвост письма, который ПЕРЕЖИВАЕТ свой текст автора: он дописывается
	// и к дефолтному телу, и к авторскому (Render). Природа у него не оформительская:
	// получатель обязан узнать, откуда письмо взялось, иначе транзакционное письмо
	// неотличимо от спама. Поэтому он есть у всех писем, уходящих НА АДРЕС ИЗ ФОРМЫ
	// (квитанция и оба письма о записи) — их адресата выбрали не мы.
	//
	// Через template.Execute проходит ТОЛЬКО он, а не текст автора: подвал пишем мы.
	footer *template.Template
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
	TemplateRespondentReceipt: {
		subject: "Ваш ответ получен",
		body: template.Must(template.New("respondent_receipt").Parse(
			"Здравствуйте!\n\n" +
				"Спасибо, ваш ответ на форму «{{.form_title}}» получен.",
		)),
		// Подвал отбит чертой: авторский текст кончается там, где начинается наша
		// служебная строка, и по письму это должно быть видно.
		footer: template.Must(template.New("respondent_receipt_footer").Parse(
			"--\n" +
				"Вы получили это письмо, потому что заполнили форму «{{.form_title}}» " +
				"в Trillix:\n{{.form_link}}",
		)),
	},
	TemplateBookingConfirmed: {
		subject: "Вы записаны",
		body: template.Must(template.New("booking_confirmed").Parse(
			"Здравствуйте!\n\n" +
				"Вы записаны через форму «{{.form_title}}».\n\n" +
				"Когда: {{.when}}\n\n" +
				"К письму приложено приглашение — календарь добавит встречу сам.\n\n" +
				"Если планы изменятся, отмените запись по ссылке — место вернётся " +
				"другим:\n\n" +
				"{{.cancel_link}}",
		)),
		footer: template.Must(template.New("booking_confirmed_footer").Parse(
			"--\n" +
				"Вы получили это письмо, потому что записались через форму " +
				"«{{.form_title}}» в Trillix:\n{{.form_link}}",
		)),
	},
	TemplateBookingRescheduled: {
		subject: "Запись перенесена",
		body: template.Must(template.New("booking_rescheduled").Parse(
			"Здравствуйте!\n\n" +
				"Запись через форму «{{.form_title}}» перенесена.\n\n" +
				"Было: {{.was}}\n" +
				"Стало: {{.when}}\n\n" +
				"Приложенное приглашение двигает встречу в календаре — второй она " +
				"не станет.\n\n" +
				"Если новое время не подходит, отмените запись по ссылке и " +
				"выберите другое:\n\n" +
				"{{.cancel_link}}",
		)),
		footer: template.Must(template.New("booking_rescheduled_footer").Parse(
			"--\n" +
				"Вы получили это письмо, потому что записались через форму " +
				"«{{.form_title}}» в Trillix:\n{{.form_link}}",
		)),
	},
	TemplateBookingCanceled: {
		subject: "Запись отменена",
		body: template.Must(template.New("booking_canceled").Parse(
			"Здравствуйте!\n\n" +
				"Запись через форму «{{.form_title}}» отменена.\n\n" +
				"Когда была: {{.when}}\n\n" +
				"Приложенное приглашение гасит встречу в календаре — принимать его " +
				"не нужно, клиент уберёт её сам.",
		)),
		footer: template.Must(template.New("booking_canceled_footer").Parse(
			"--\n" +
				"Вы получили это письмо, потому что записались через форму " +
				"«{{.form_title}}» в Trillix:\n{{.form_link}}",
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
	TemplateLoginCode: {
		subject: "Код для входа",
		body: template.Must(template.New("login_code").Parse(
			"Здравствуйте!\n\n" +
				"Код для входа в Trillix: {{.code}}\n\n" +
				"Он действует десять минут и нужен потому, что вход выполняется " +
				"с устройства, которое мы ещё не видели.\n\n" +
				"Если входили не вы — код никому не сообщайте и смените пароль.\n\n" +
				"— Trillix",
		)),
	},
	TemplateAccountActionCode: {
		subject: "Код подтверждения",
		body: template.Must(template.New("account_action_code").Parse(
			"Здравствуйте!\n\n" +
				"Код для подтверждения действия в вашем аккаунте Trillix: {{.code}}\n\n" +
				"Он действует десять минут.\n\n" +
				"Если вы ничего не подтверждали — код никому не сообщайте и смените " +
				"пароль.\n\n" +
				"— Trillix",
		)),
	},
	TemplateTwoFactorChanged: {
		subject: "Двухфакторная аутентификация",
		body: template.Must(template.New("two_factor_changed").Parse(
			"Здравствуйте!\n\n" +
				"Двухфакторная аутентификация в вашем аккаунте Trillix только что " +
				"{{.state}}.\n\n" +
				"Если это сделали вы — ничего делать не нужно.\n\n" +
				"Если нет — смените пароль: тот, кто менял настройку, уже вошёл " +
				"в аккаунт.\n\n" +
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
// темы, свой текст — вместо тела. Через template.Execute авторский текст не проходит
// НИКОГДА: чужой текст с «{{» иначе стал бы либо ошибкой рендера, либо дырой в
// шаблонизаторе. Подстановки ответов в нём (mentions.md §10) к шаблонизатору
// отношения не имеют — их разворачивает domain.MentionText ДО постановки письма в
// outbox, и сюда приезжает уже готовый плоский текст.
func Render(msg EmailMessage) (subject, body string, err error) {
	t, ok := templates[msg.Template]
	if !ok {
		return "", "", fmt.Errorf("unknown email template %q", msg.Template)
	}
	subject = t.subject
	if msg.Subject != "" {
		subject = msg.Subject
	}
	body = msg.Body
	if body == "" {
		var buf bytes.Buffer
		if err := t.body.Execute(&buf, msg.Data); err != nil {
			return "", "", fmt.Errorf("render email %q: %w", msg.Template, err)
		}
		body = buf.String()
	}
	// Подвал дописывается ПОСЛЕ развилки, то есть и к своему тексту тоже: перебивка
	// автора сильнее шаблона, но не сильнее строки «почему вы это получили».
	if t.footer != nil {
		var buf bytes.Buffer
		if err := t.footer.Execute(&buf, msg.Data); err != nil {
			return "", "", fmt.Errorf("render email footer %q: %w", msg.Template, err)
		}
		body += "\n\n" + buf.String()
	}
	return subject, body, nil
}
