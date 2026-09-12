package integrations

import (
	"context"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/ka-shmd/trillix/internal/domain"
	"github.com/ka-shmd/trillix/internal/safehttp"
)

// Проверка ИЗНУТРИ пакета, и в этом всё дело: снаружи такой набор заголовков не
// собрать — ручка его отвергнет. Защита рассчитана ровно на дыру в проверке или
// на шифротекст, приехавший из базы старой версии.

// headerSpy — получатель, который только запоминает заголовки запроса.
type headerSpy struct{ header http.Header }

func (h *headerSpy) Validate(_ context.Context, raw string) (*url.URL, error) {
	return url.Parse(raw)
}

func (h *headerSpy) Post(_ context.Context, _ string, header http.Header, _ []byte) (safehttp.Response, error) {
	h.header = header.Clone()
	return safehttp.Response{StatusCode: http.StatusOK}, nil
}

// Свои заголовки автора ставятся первыми, наши пишутся поверх: перебить
// Content-Type или подпись нельзя. Иначе один заголовок в форме ломал бы у
// получателя и разбор тела, и проверку подлинности.
func TestSendWebhook_OursWinOverAuthorHeaders(t *testing.T) {
	spy := &headerSpy{}
	svc := &Service{key: testKey, egress: spy, now: func() time.Time { return time.Unix(1757671200, 0) }}

	sealed, err := sealWebhookHeaders(testKey,
		`[{"name":"Content-Type","value":"text/plain"},`+
			`{"name":"`+domain.WebhookSignatureHeader+`","value":"t=1,v1=подделка"},`+
			`{"name":"Authorization","value":"Bearer abc123"}]`)
	if err != nil {
		t.Fatalf("печать заголовков: %v", err)
	}
	secret, err := sealWebhookSecret(testKey, "секрет-проверки-подписи")
	if err != nil {
		t.Fatalf("печать секрета: %v", err)
	}

	if _, err := svc.sendWebhook(context.Background(), Webhook{
		URL: "https://hooks.example.com/x", HeadersSealed: sealed, SecretSealed: secret,
	}, []byte(`{"version":1}`)); err != nil {
		t.Fatalf("отправка: %v", err)
	}

	if got := spy.header.Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type перебит на %q", got)
	}
	if got := spy.header.Get(domain.WebhookSignatureHeader); got == "t=1,v1=подделка" {
		t.Fatal("подпись перебита значением автора")
	}
	// Свой заголовок, который нашим не является, при этом доехал.
	if got := spy.header.Get("Authorization"); got != "Bearer abc123" {
		t.Fatalf("Authorization = %q", got)
	}
}

// Шифротекст, переживший ротацию FORM_TOKEN_SECRET, не открывается. Отправить
// запрос без заголовков нельзя: получатель, который требует ключ, ответил бы 401,
// и автор пошёл бы чинить адрес.
func TestSendWebhook_UnreadableHeadersStopDelivery(t *testing.T) {
	spy := &headerSpy{}
	svc := &Service{key: testKey, egress: spy, now: time.Now}

	_, err := svc.sendWebhook(context.Background(), Webhook{
		URL: "https://hooks.example.com/x", HeadersSealed: []byte("шифротекст от прошлого ключа"),
	}, []byte(`{}`))
	if err == nil {
		t.Fatal("запрос ушёл с нечитаемыми заголовками")
	}
	permanent, reason := webhookFailureReason(0, err)
	if !permanent || reason == "" {
		t.Fatalf("приговор: permanent=%v reason=%q — ожидалась поломка с причиной", permanent, reason)
	}
	if spy.header != nil {
		t.Fatal("получатель всё же получил запрос")
	}
}
