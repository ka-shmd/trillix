package mail

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
)

// Тело письма (со ссылкой сброса и токеном) обязано писаться ТОЛЬКО на debug:
// dev видит его как почтовый ящик, prod/prod-local на info — нет (инвариант 2/7).
func TestLogMailer_BodyOnlyAtDebug(t *testing.T) {
	const secret = "SECRET-TOKEN-abc123"
	msg := EmailMessage{
		To:       "user@example.com",
		Template: TemplatePasswordReset,
		Data:     map[string]any{"link": "https://app.trillix.ru/reset-password?token=" + secret},
	}

	var infoBuf bytes.Buffer
	infoLog := slog.New(slog.NewTextHandler(&infoBuf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := (LogMailer{Log: infoLog, From: "from@localhost"}).Send(context.Background(), msg); err != nil {
		t.Fatalf("Send (info): %v", err)
	}
	if strings.Contains(infoBuf.String(), secret) {
		t.Errorf("токен попал в лог на уровне info:\n%s", infoBuf.String())
	}

	var debugBuf bytes.Buffer
	debugLog := slog.New(slog.NewTextHandler(&debugBuf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	if err := (LogMailer{Log: debugLog, From: "from@localhost"}).Send(context.Background(), msg); err != nil {
		t.Fatalf("Send (debug): %v", err)
	}
	if !strings.Contains(debugBuf.String(), secret) {
		t.Errorf("на debug тело письма (ссылка сброса) должно быть видно для локального теста:\n%s", debugBuf.String())
	}
}
