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

func TestRenderUnknownTemplate(t *testing.T) {
	_, _, err := Render(EmailMessage{Template: "no-such-template"})
	if err == nil {
		t.Error("неизвестный шаблон обязан вернуть ошибку")
	}
}
