package mail

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

func TestRenderPasswordReset(t *testing.T) {
	link := "https://app.trillix.ru/reset-password?token=abc123"
	subject, body, err := Render(EmailMessage{
		Template: TemplatePasswordReset,
		Data:     map[string]any{"link": link},
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if subject == "" {
		t.Error("пустая тема письма")
	}
	if !strings.Contains(body, link) {
		t.Errorf("тело письма не содержит ссылку сброса:\n%s", body)
	}
}

func TestRenderSubmissionNew(t *testing.T) {
	subject, body, err := Render(EmailMessage{
		Template: TemplateSubmissionNew,
		Data:     map[string]any{"form_title": "Анкета", "link": "https://app/forms/s/responses"},
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if subject == "" {
		t.Error("пустая тема письма")
	}
	for _, want := range []string{"Анкета", "https://app/forms/s/responses"} {
		if !strings.Contains(body, want) {
			t.Errorf("тело письма не содержит %q:\n%s", want, body)
		}
	}
	if strings.Contains(body, "печати") {
		t.Errorf("строка о неудавшейся печати не имеет права стоять в обычном письме:\n%s", body)
	}
}

// Печать вложения не удалась — владелец обязан узнать об этом из письма, а не из
// нашего лога: вложение обещано его же настройкой.
func TestRenderSubmissionNew_PDFFailed(t *testing.T) {
	_, body, err := Render(EmailMessage{
		Template: TemplateSubmissionNew,
		Data:     map[string]any{"form_title": "Анкета", "link": "https://x", "pdf_failed": true},
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.Contains(body, "не удалось") {
		t.Errorf("тело не сообщает о неудавшейся печати:\n%s", body)
	}
}

func TestRenderUnknownTemplate(t *testing.T) {
	_, _, err := Render(EmailMessage{Template: "no-such-template"})
	if err == nil {
		t.Error("неизвестный шаблон обязан вернуть ошибку")
	}
}

// Перебивки автора сильнее шаблона и заменяют его часть целиком (0042). Свой текст
// НЕ проходит через шаблонизатор: «{{» в письме автора не имеет права стать ни
// ошибкой рендера, ни выполненным действием.
func TestRender_AuthorOverrides(t *testing.T) {
	subject, body, err := Render(EmailMessage{
		Template: TemplateSubmissionNew,
		Data:     map[string]any{"form_title": "Анкета", "link": "https://x"},
		Subject:  "Заявка с сайта",
		Body:     "Пришла заявка {{.link}} — смотрите в кабинете.",
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if subject != "Заявка с сайта" {
		t.Fatalf("subject = %q, ожидалась тема автора", subject)
	}
	if body != "Пришла заявка {{.link}} — смотрите в кабинете." {
		t.Fatalf("body = %q — текст автора обязан уйти как есть", body)
	}
}

// Перебита только тема — тело остаётся шаблонным и по-прежнему разворачивается.
func TestRender_SubjectOnlyKeepsTemplateBody(t *testing.T) {
	subject, body, err := Render(EmailMessage{
		Template: TemplateSubmissionNew,
		Data:     map[string]any{"form_title": "Анкета", "link": "https://x"},
		Subject:  "Заявка с сайта",
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if subject != "Заявка с сайта" {
		t.Fatalf("subject = %q", subject)
	}
	if !strings.Contains(body, "Анкета") || !strings.Contains(body, "https://x") {
		t.Fatalf("тело перестало быть шаблонным: %q", body)
	}
}

// Подвал письма респонденту переживает свой текст автора: получатель обязан узнать,
// откуда письмо взялось, и это не оформление, а единственное отличие уведомления от
// спама (docs/design/respondent-email.md §5). Свой текст при этом по-прежнему НЕ
// проходит через шаблонизатор.
func TestRenderRespondentReceipt_FooterSurvivesOverride(t *testing.T) {
	data := map[string]any{"form_title": "Анкета", "form_link": "https://f.trillix.ru/anketa"}

	_, body, err := Render(EmailMessage{Template: TemplateRespondentReceipt, Data: data})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	for _, want := range []string{"Анкета", "https://f.trillix.ru/anketa", "Вы получили это письмо"} {
		if !strings.Contains(body, want) {
			t.Errorf("дефолтное письмо не содержит %q:\n%s", want, body)
		}
	}

	own := "Спасибо! {{.form_link}} — ваш ответ у нас."
	_, body, err = Render(EmailMessage{Template: TemplateRespondentReceipt, Data: data, Body: own})
	if err != nil {
		t.Fatalf("Render со своим текстом: %v", err)
	}
	if !strings.HasPrefix(body, own) {
		t.Fatalf("текст автора изменён:\n%s", body)
	}
	if !strings.Contains(body, "Вы получили это письмо") {
		t.Fatalf("свой текст съел подвал:\n%s", body)
	}
	if !strings.Contains(body, "https://f.trillix.ru/anketa") {
		t.Fatalf("подвал не развернул адрес формы:\n%s", body)
	}
}

// Подвал есть ровно у письма респондента: у остальных писем получатель известен
// заранее, и служебная строка в них была бы шумом.
func TestRender_FooterOnlyForRespondent(t *testing.T) {
	_, body, err := Render(EmailMessage{
		Template: TemplateSubmissionNew,
		Data:     map[string]any{"form_title": "Анкета", "link": "https://x"},
		Body:     "Свой текст.",
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if body != "Свой текст." {
		t.Fatalf("к письму владельцу приписан подвал: %q", body)
	}
}

// TestEveryTemplateIsRegistered — РЕГРЕССИЯ. Константы шаблонов и карта templates
// заводятся в двух разных местах одного файла, и фаза 27 показала цену этого: оба
// письма о записи были объявлены константами с расписанным составом данных, но в
// карту не попали. Ошибку выдаёт только Render, то есть уже диспетчер outbox — письмо
// уходит в бесконечный бэкофф, а тесты вокруг него проверяют строку в очереди и потому
// зелены.
//
// Список констант читается из ИСХОДНИКА (go/parser), а не переписывается сюда руками:
// переписанный список забыли бы ровно так же.
func TestEveryTemplateIsRegistered(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "template.go", nil, 0)
	if err != nil {
		t.Fatalf("разбор template.go: %v", err)
	}
	var declared []string
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok {
			return true
		}
		ident, ok := spec.Type.(*ast.Ident)
		if !ok || ident.Name != "Template" {
			return true
		}
		for _, name := range spec.Names {
			declared = append(declared, name.Name)
		}
		return true
	})
	if len(declared) == 0 {
		t.Fatal("в template.go не найдено ни одной константы Template — сломался разбор, а не код")
	}
	for _, name := range declared {
		value := templateByName(t, name)
		if _, ok := templates[value]; !ok {
			t.Errorf("шаблон %s (%q) объявлен константой, но не заведён в карте templates: "+
				"Render вернёт ошибку, и письмо не уйдёт никогда", name, value)
		}
	}
}

// templateByName — значение константы по её имени. Разбор исходника даёт имена;
// значения берём у самого пакета, чтобы не парсить ещё и строковые литералы.
func templateByName(t *testing.T, name string) Template {
	t.Helper()
	byName := map[string]Template{
		"TemplatePasswordReset":      TemplatePasswordReset,
		"TemplateEmailVerification":  TemplateEmailVerification,
		"TemplateWorkspaceInvite":    TemplateWorkspaceInvite,
		"TemplateSubmissionNew":      TemplateSubmissionNew,
		"TemplateEmailChangeConfirm": TemplateEmailChangeConfirm,
		"TemplateEmailChangeNotice":  TemplateEmailChangeNotice,
		"TemplateRespondentReceipt":  TemplateRespondentReceipt,
		"TemplateBookingConfirmed":   TemplateBookingConfirmed,
		"TemplateBookingCanceled":    TemplateBookingCanceled,
		"TemplateBookingRescheduled": TemplateBookingRescheduled,
		"TemplatePasswordChanged":    TemplatePasswordChanged,
		"TemplateLoginCode":          TemplateLoginCode,
		"TemplateTwoFactorChanged":   TemplateTwoFactorChanged,
		"TemplateAccountActionCode":  TemplateAccountActionCode,
	}
	value, ok := byName[name]
	if !ok {
		t.Fatalf("константа %s объявлена в template.go, но не добавлена в этот тест: "+
			"допиши её сюда — иначе новый шаблон не проверяется ничем", name)
	}
	return value
}

func TestRenderBookingConfirmed(t *testing.T) {
	data := map[string]any{
		"form_title":  "Стрижка",
		"when":        "11 сентября 2026, 11:00 (Europe/Moscow)",
		"cancel_link": "https://f.trillix.ru/cancel/abc",
		"form_link":   "https://f.trillix.ru/r/anketa",
	}
	subject, body, err := Render(EmailMessage{Template: TemplateBookingConfirmed, Data: data})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if subject == "" {
		t.Error("пустая тема письма")
	}
	// Ссылка отмены обязательна: без неё респондент не вернёт место в оборот, а
	// подвал обязан объяснить, откуда письмо взялось (адрес ввели в форму).
	parts := []string{
		"Стрижка", "11:00 (Europe/Moscow)",
		"https://f.trillix.ru/cancel/abc", "https://f.trillix.ru/r/anketa",
	}
	for _, want := range parts {
		if !strings.Contains(body, want) {
			t.Errorf("тело письма не содержит %q:\n%s", want, body)
		}
	}
}

func TestRenderBookingCanceled(t *testing.T) {
	data := map[string]any{
		"form_title": "Стрижка",
		"when":       "11 сентября 2026, 11:00 (Europe/Moscow)",
		"form_link":  "https://f.trillix.ru/r/anketa",
	}
	subject, body, err := Render(EmailMessage{Template: TemplateBookingCanceled, Data: data})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if subject == "" {
		t.Error("пустая тема письма")
	}
	// Ссылки отмены здесь НЕТ намеренно: отменять уже нечего, и живая ссылка в этом
	// письме означала бы вторую отмену той же брони.
	if strings.Contains(body, "/cancel/") {
		t.Errorf("в письме об отмене осталась ссылка отмены:\n%s", body)
	}
	for _, want := range []string{"Стрижка", "11:00 (Europe/Moscow)", "https://f.trillix.ru/r/anketa"} {
		if !strings.Contains(body, want) {
			t.Errorf("тело письма не содержит %q:\n%s", want, body)
		}
	}
}
