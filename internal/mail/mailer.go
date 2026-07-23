package mail

import (
	"context"
	"log/slog"
)

// Channel — канал доставки строки outbox. Пока один; вебхуки/телега лягут сюда же
// новыми значениями и веткой в диспетчере, без переделки схемы.
const ChannelEmail = "email"

// Template именует письмо (какой текст и тема). Конкретные шаблоны регистрируются
// фазами-потребителями (сброс пароля, уведомление о новом ответе — следующие слайсы);
// здесь только тип, чтобы каркас не знал про частные письма.
type Template string

// EmailMessage — намерение доставки одного письма: кому, по какому шаблону, с
// какими данными. Это и есть payload строки outbox канала email (сериализуется в
// JSONB). Рендер шаблона в тему/тело — забота реализации Mailer: провайдер рендерит
// и шлёт, dev-LogMailer в слайсе A не рендерит (шаблонов ещё нет) и логирует факт.
type EmailMessage struct {
	To       string         `json:"to"`
	Template Template       `json:"template"`
	Data     map[string]any `json:"data,omitempty"`
}

// Mailer доставляет одно письмо во внешний мир. Реализации: LogMailer (dev — в лог,
// провайдер не нужен) и клиент провайдера (слайс E — один HTTP-вызов). Send обязан
// быть идемпотентно-безопасным на стороне вызывающего: диспетчер не отличает
// «письмо ушло, но ответ потерялся» от «не ушло» и при сбое ретраит — редкий
// дубль письма приемлемее потерянного письма.
type Mailer interface {
	Send(ctx context.Context, msg EmailMessage) error
}

// LogMailer — транспорт dev-контура: «доставляет» письмо, записывая факт в лог.
// Позволяет гонять весь цикл сброса пароля локально без почтового провайдера.
//
// Логируем получателя и шаблон, но НЕ Data: данные шаблона могут нести токен
// (ссылка сброса) — а токены в лог не пишутся (инвариант 2). Когда появятся
// шаблоны с телом (следующий слайс), тело письма для глазной проверки в dev
// смотрится в Mailpit (prod-local), не в логах приложения.
type LogMailer struct {
	Log  *slog.Logger
	From string
}

func (m LogMailer) Send(_ context.Context, msg EmailMessage) error {
	m.Log.Info("email delivered via log transport (dev)",
		slog.String("from", m.From),
		slog.String("to", msg.To),
		slog.String("template", string(msg.Template)))
	return nil
}

var _ Mailer = LogMailer{}
