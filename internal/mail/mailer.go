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
// JSONB). Рендер шаблона в тему/тело — общий (Render), реализация Mailer его
// вызывает (dev-LogMailer) либо игнорирует, если провайдер рендерит у себя.
type EmailMessage struct {
	To       string         `json:"to"`
	Template Template       `json:"template"`
	Data     map[string]any `json:"data,omitempty"`
	// Перебивки АВТОРА ФОРМЫ (письмо о новом ответе, миграция 0042). Пусто —
	// письмо идёт шаблоном целиком; заполнено — заменяет соответствующую часть.
	// Адрес отправителя не перебивается никогда: домен, с которого мы шлём, автору
	// не принадлежит, и подменённый From стоил бы репутации всего сервиса.
	//
	// Живут в payload строки outbox наравне с Data: письмо отправляется ПОЗЖЕ
	// постановки, и лезть за настройкой формы в момент доставки диспетчер не может
	// — формы к тому времени может уже не быть.
	FromName string `json:"fromName,omitempty"`
	ReplyTo  string `json:"replyTo,omitempty"`
	Subject  string `json:"subject,omitempty"`
	Body     string `json:"body,omitempty"`
	// Attachments — ССЫЛКИ на вложения, а не сами файлы: документ печатается в
	// момент доставки (ADR §10). Печать при постановке легла бы на путь приёма
	// ответа — самый нагруженный эндпоинт продукта, — а готовый PDF в payload это
	// сотни КБ base64 в JSONB, лежащие в базе и бэкапах до отправки.
	Attachments []AttachmentRef `json:"attachments,omitempty"`
	// Files — уже добытые вложения. `json:"-"` — мина: попади они в payload, каждое
	// письмо с PDF записывало бы файл в строку outbox, ровно то, чего решение
	// избегает. Заполняется диспетчером перед вызовом Mailer и живёт только в памяти.
	Files []File `json:"-"`
}

// KindSubmissionPDF — единственный вид вложения: печатный лист одного ответа формы.
const KindSubmissionPDF = "submission_pdf"

// AttachmentRef — чем письмо называет своё вложение, пока оно ещё не добыто. Тот же
// приём, что у канала gsheets: payload несёт идентификаторы, а данные читает тот,
// кто умеет их читать.
type AttachmentRef struct {
	Kind         string `json:"kind"`
	FormID       string `json:"formId"`
	SubmissionID string `json:"submissionId"`
}

// File — добытое вложение: имя, каким оно ляжет в почтовый клиент, тип и байты.
type File struct {
	Name    string
	MIME    string
	Content []byte
}

// AttachmentResolver добывает вложение по ссылке в момент доставки. Реализация живёт
// в модуле, который умеет печатать (submissions): пакет mail не знает ни про формы,
// ни про ответы, и знать не должен.
//
// Ошибка резолвера НЕ откладывает письмо: уведомление важнее вложения, и владелец
// получает письмо без PDF с явной строкой о неудаче (шаблон submission_digest).
type AttachmentResolver interface {
	Resolve(ctx context.Context, ref AttachmentRef) (File, error)
}

// Mailer доставляет одно письмо во внешний мир. Реализации: LogMailer (dev — в лог,
// провайдер не нужен) и клиент провайдера (слайс E — один HTTP-вызов). Send обязан
// быть идемпотентно-безопасным на стороне вызывающего: диспетчер не отличает
// «письмо ушло, но ответ потерялся» от «не ушло» и при сбое ретраит — редкий
// дубль письма приемлемее потерянного письма.
type Mailer interface {
	Send(ctx context.Context, msg EmailMessage) error
}

// LogMailer — транспорт dev-контура: «доставляет» письмо, печатая его в лог. Это
// способ прочитать письмо локально без провайдера — почтовый ящик dev (POST-MVP
// шаг 8: «реализация Mailer, пишущая письма в лог/файл»).
//
// Тело письма содержит ссылку сброса с токеном, поэтому пишется ТОЛЬКО на уровне
// Debug: dev работает на debug и письмо видит, а prod/prod-local — на info, куда
// тело с токеном не попадает никогда (инвариант 2/7 не нарушается). На info
// остаётся лишь факт «письмо доставлено» без чувствительных данных. Транспорт log
// — для dev; прод обязан выбрать провайдерский транспорт (иначе письмо не уходит:
// LogMailer наружу ничего не шлёт — сбой заметен, не тих).
type LogMailer struct {
	Log  *slog.Logger
	From string
}

func (m LogMailer) Send(_ context.Context, msg EmailMessage) error {
	subject, body, err := Render(msg)
	if err != nil {
		return err
	}
	m.Log.Info("email delivered (dev log transport)",
		slog.String("from", m.From),
		slog.String("to", msg.To),
		slog.String("subject", subject),
		slog.Int("attachments", len(msg.Files)))
	// Тело с токеном — только на debug (в проде уровень info, сюда не дойдёт).
	m.Log.Debug("email body (dev log transport)", slog.String("body", body))
	return nil
}

var _ Mailer = LogMailer{}
