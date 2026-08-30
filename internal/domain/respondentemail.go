package domain

import (
	"encoding/json"
	"net/mail"
	"unicode/utf8"
)

// Письмо респонденту — то, что человек получает на свою почту, отправив форму
// (docs/design/respondent-email.md). ЖИВЫЕ данные (колонка forms.respondent_email),
// как и письмо владельцу: письмо не документ формы, снапшот версии его не несёт, и
// правка обязана действовать со следующего же ответа, без перепубликации (ADR §10).
//
// От письма владельцу отличается ровно одним полем — SourceBlockID, — и это отличие
// определяющее. У владельца адресат известен из аккаунта; здесь адрес приезжает
// ОТВЕТОМ, то есть недоверенным вводом, и письмо уходит с нашего домена на адрес,
// который ввёл кто угодно. Отсюда всё остальное: свой ключ тарифа
// (entitlements.FormRespondentEmail), потолок писем на форму и неудаляемый подвал
// шаблона (mail.TemplateRespondentReceipt) — обвязка описана в спеке §5.
//
// Своего типа полей, кроме SourceBlockID, здесь нет: имя отправителя, Reply-To, тема
// и текст — те же и с теми же потолками, что у NotifyEmail. Два набора констант на
// один бланк означали бы, что в одно поле влезает то, что не влезает в такое же.

// RespondentEmail — настройка письма респонденту. Хранится в forms.respondent_email
// как JSONB; отсутствие настройки (NULL) и настройка из пустых полей — одно
// состояние, и второе в базу не попадает (см. Empty).
type RespondentEmail struct {
	// SourceBlockID — id вопроса типа email, из ответа на который берётся АДРЕС
	// получателя. Вопрос выбирает автор явно (спека §3): «первый email-вопрос
	// формы» менял бы получателя писем молча, при правке полотна.
	//
	// СУЩЕСТВОВАНИЕ блока здесь не проверяется — по тому же правилу, что у ref
	// подстановки (spans.go): вопрос удаляют в билдере уже после того, как бланк
	// сохранён, и «источник пропал» — это состояние, а не невалидные данные.
	// Проверяют его двое: экран настроек красной строкой в бланке и путь отправки,
	// который без адреса просто не шлёт письма.
	SourceBlockID string `json:"sourceBlockId,omitempty"`
	// FromName — имя в заголовке From. Сам адрес отправителя остаётся сервисным:
	// домен, с которого мы шлём, автору не принадлежит.
	FromName string `json:"fromName,omitempty"`
	// ReplyTo — куда ответит почтовый клиент респондента, если он нажмёт «Ответить».
	// Здесь у поля есть смысл, которого нет у письма владельцу: это единственный
	// способ дать респонденту обратную связь с автором формы.
	ReplyTo string `json:"replyTo,omitempty"`
	// Subject и Body — тема и текст СПАНАМИ, тем же форматом, что у NotifyEmail
	// (mentions.md §10): спан с полем Ref — подстановка ответа, её разворачивает
	// сервер при постановке письма в outbox, и до почты доезжает плоский текст.
	Subject []Span `json:"subject,omitempty"`
	Body    []Span `json:"body,omitempty"`
	// AttachPDF — приложить печатный лист ответа. Документ печатается в момент
	// ДОСТАВКИ письма (ADR §10), то есть настройка действует со следующего ответа.
	AttachPDF bool `json:"attachPdf,omitempty"`
}

// Empty — настройка ничего не переопределяет. Пустая в базу не пишется: колонке
// достаётся NULL, и у «не настраивали» остаётся ровно одно представление.
//
// ⚠ Пустая настройка при включённом тумблере — рабочее состояние, а не ошибка:
// письмо уйдёт дефолтным шаблоном. Не уйдёт оно только без адресата, а адресат —
// это SourceBlockID, и его отсутствие Empty не описывает.
func (r *RespondentEmail) Empty() bool {
	return r == nil ||
		(r.SourceBlockID == "" && r.FromName == "" && r.ReplyTo == "" &&
			len(r.Subject) == 0 && len(r.Body) == 0 && !r.AttachPDF)
}

// ValidateRespondentEmail — серверная проверка настройки (инвариант 3, независимо от
// фронта). Чистая функция без HTTP/SQL; нарушение → ErrValidation (→ 422).
func ValidateRespondentEmail(r *RespondentEmail) error {
	if r == nil {
		return nil
	}
	if r.SourceBlockID != "" {
		if err := validateID(r.SourceBlockID); err != nil {
			return schemaErr("respondentEmail: sourceBlockId: %v", err)
		}
	}
	if n := utf8.RuneCountInString(r.FromName); n > MaxNotifyFromNameLen {
		return schemaErr("respondentEmail: fromName длиннее %d символов", MaxNotifyFromNameLen)
	}
	if n := utf8.RuneCountInString(r.ReplyTo); n > MaxTextAnswerLen {
		return schemaErr("respondentEmail: replyTo длиннее %d символов", MaxTextAnswerLen)
	}
	for _, f := range []struct {
		name  string
		spans []Span
		max   int
	}{
		{"subject", r.Subject, MaxNotifySubjectLen},
		{"body", r.Body, MaxNotifyBodyLen},
	} {
		if err := validateSpansLimit(f.spans, f.max); err != nil {
			return schemaErr("respondentEmail: %s: %v", f.name, err)
		}
	}
	// Reply-To проверяется строго, как у письма владельцу: битый адрес отвергнет
	// почтовый провайдер, то есть письмо пропадёт молча.
	if r.ReplyTo != "" {
		addr, err := mail.ParseAddress(r.ReplyTo)
		if err != nil || addr.Address != r.ReplyTo || addr.Name != "" {
			return schemaErr("respondentEmail: replyTo — нужен адрес вида name@example.com")
		}
	}
	return nil
}

// RespondentAddress — адрес, на который уйдёт письмо: ответ респондента на вопрос
// SourceBlockID. Пустая строка значит «письма нет» и покрывает ВСЕ случаи, которых
// у настройки четыре: источник не выбран, вопрос удалён из схемы, вопрос не типа
// email, ответа нет (пропущен или скрыт логикой).
//
// ⚠ Тип блока проверяется здесь, а не только в интерфейсе, и это не перестраховка:
// значение уходит в заголовок To письма, которое шлём МЫ, и указать источником
// длинный текст значило бы отдать поле получателя произвольной строке респондента.
// Разбор адреса (ParseAddress) — вторая половина той же защиты: ответ на вопрос
// типа email валидируется на приёме, но письмо ставится по живой схеме, а ответ
// принадлежит той версии, на которую отвечали.
func RespondentAddress(r *RespondentEmail, schema FormSchema, answers map[string]json.RawMessage) string {
	if r == nil || r.SourceBlockID == "" {
		return ""
	}
	var src *Block
	for i, blk := range schema.Blocks {
		if blk.ID == r.SourceBlockID {
			src = &schema.Blocks[i]
			break
		}
	}
	if src == nil || src.Type != BlockEmail {
		return ""
	}
	raw, ok := answers[r.SourceBlockID]
	if !ok {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || value == "" {
		return ""
	}
	addr, err := mail.ParseAddress(value)
	if err != nil || addr.Address != value || addr.Name != "" {
		return ""
	}
	return value
}
