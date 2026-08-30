package mail

import (
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
