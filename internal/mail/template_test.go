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

func TestRenderSubmissionDigest(t *testing.T) {
	subject, body, err := Render(EmailMessage{
		Template: TemplateSubmissionDigest,
		Data:     map[string]any{"form_title": "Анкета", "link": "https://app/forms/s/responses", "count": 5},
	})
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if subject == "" {
		t.Error("пустая тема письма")
	}
	for _, want := range []string{"Анкета", "5", "https://app/forms/s/responses"} {
		if !strings.Contains(body, want) {
			t.Errorf("тело дайджеста не содержит %q:\n%s", want, body)
		}
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
		Template: TemplateSubmissionDigest,
		Data:     map[string]any{"form_title": "Анкета", "link": "https://x", "count": 1},
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
		Template: TemplateSubmissionDigest,
		Data:     map[string]any{"form_title": "Анкета", "link": "https://x", "count": 2},
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
