package submissions

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/ka-shmd/trillix/internal/mail"
)

// Вложение «PDF ответа» в письме владельцу: то же, что даёт кнопка «Скачать PDF»,
// только добывается не по клику человека, а диспетчером outbox в момент доставки
// письма (ADR §10).
//
// Печать здесь ровно та же, что в ручке кабинета: подписанный токен + путь к
// печатной странице, origin которой знает сам принтер. Разница одна — прав
// пользователя не существует: письмо отправляем мы сами, адресат уже выбран (владелец
// пространства), и спрашивать «можно ли ЕМУ» не у кого.

// PrintAttachments — резолвер вложений для писем (реализация mail.AttachmentResolver).
// Собирается только там, где настроен принтер; без него письмо уходит без файла.
type PrintAttachments struct {
	svc     *Service
	printer PrintClient
	secret  []byte
	now     func() time.Time
}

func NewPrintAttachments(svc *Service, client PrintClient, formTokenSecret []byte) *PrintAttachments {
	return &PrintAttachments{svc: svc, printer: client, secret: derivePrintSecret(formTokenSecret), now: time.Now}
}

var _ mail.AttachmentResolver = (*PrintAttachments)(nil)

// Resolve печатает лист одного ответа. Ошибка означает «письмо уйдёт без вложения»
// (диспетчер её так и трактует), поэтому здесь не различаются «ответ удалён»,
// «принтер занят» и «принтер лежит»: все три — причина в логе, а не разная судьба
// письма.
func (a *PrintAttachments) Resolve(ctx context.Context, ref mail.AttachmentRef) (mail.File, error) {
	if ref.Kind != mail.KindSubmissionPDF {
		return mail.File{}, fmt.Errorf("print attachment: unknown kind %q", ref.Kind)
	}
	formID, err := uuid.Parse(ref.FormID)
	if err != nil {
		return mail.File{}, fmt.Errorf("print attachment: form id %q: %w", ref.FormID, err)
	}
	subID, err := uuid.Parse(ref.SubmissionID)
	if err != nil {
		return mail.File{}, fmt.Errorf("print attachment: submission id %q: %w", ref.SubmissionID, err)
	}

	// Имя формы и дата ответа — до печати: ответ мог быть удалён между постановкой
	// письма и доставкой, и тогда поднимать браузер незачем.
	access, err := a.svc.PrintAccessForDelivery(ctx, formID, subID)
	if err != nil {
		return mail.File{}, err
	}

	token := issuePrintToken(a.secret, formID, subID, a.now().Add(printTokenTTL))
	doc, err := a.printer.PDF(ctx, "/internal/print/doc/"+token)
	if err != nil {
		return mail.File{}, fmt.Errorf("print submission %s for email: %w", subID, err)
	}
	return mail.File{Name: PDFFileName(access), MIME: "application/pdf", Content: doc}, nil
}
