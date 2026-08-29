package domain

import (
	"net/mail"
	"unicode/utf8"
)

// Письмо о новом ответе — то, что владелец формы получает на свою почту. ЖИВЫЕ
// данные (колонка forms.notify_email), а не поле схемы, по тому же правилу, что
// карточка ссылки: письмо не документ, который увидит респондент, снапшот версии
// его не несёт, и правка обязана действовать со следующего же ответа, без
// перепубликации (ADR §10).
//
// Настраивается НЕ ВСЁ письмо. Адрес отправителя один на сервис (домен, с которого
// мы шлём) и автору не принадлежит; получатель — владелец аккаунта, и подставить
// вместо него посторонний адрес нельзя: письма уходят нашими руками, и произвольный
// получатель превратил бы форму в рассыльщик. Автору остаются имя отправителя,
// Reply-To, тема и текст.
//
// Все поля необязательны и каждое независимо: пустое значит «взять дефолт»
// (internal/mail, шаблон submission_digest), а не «отправить пустоту».

const (
	// MaxNotifyFromNameLen — имя отправителя в заголовке From. Короткий ярлык, не
	// текст: тот же класс, что имя площадки в карточке ссылки.
	MaxNotifyFromNameLen = 100
	// MaxNotifySubjectLen — тема письма. Почтовые клиенты обрезают её куда раньше,
	// но потолок здесь про хранение, а не про показ.
	MaxNotifySubjectLen = 200
	// MaxNotifyBodyLen — текст письма. Тот же потолок, что у текста благодарности:
	// оба — короткое письменное сообщение автора, и разные границы означали бы, что
	// в одном месте помещается то, что не помещается в другом.
	MaxNotifyBodyLen = MaxThankYouTextLen
)

// NotifyEmail — настройка письма о новом ответе. Хранится в forms.notify_email как
// JSONB; отсутствие настройки (NULL) и настройка из пустых строк — одно состояние,
// и второе в базу не попадает (см. Empty).
type NotifyEmail struct {
	// FromName — имя в заголовке From. Сам адрес отправителя остаётся сервисным.
	FromName string `json:"fromName,omitempty"`
	// ReplyTo — куда ответит почтовый клиент, если владелец нажмёт «Ответить».
	// Голый адрес без имени — как и везде в продукте.
	ReplyTo string `json:"replyTo,omitempty"`
	// Subject — тема письма.
	Subject string `json:"subject,omitempty"`
	// Body — текст письма. Подстановок (@Форма, @Все ответы) ЕЩЁ НЕТ: текст уходит
	// как есть — задача в BACKLOG.md. Ссылку на таблицу ответов дефолтный шаблон
	// добавляет сам, свой текст её не получает.
	Body string `json:"body,omitempty"`
}

// Empty — настройка ничего не переопределяет. Пустая в базу не пишется: колонке
// достаётся NULL, и у «не настраивали» остаётся ровно одно представление.
func (n *NotifyEmail) Empty() bool {
	return n == nil || (n.FromName == "" && n.ReplyTo == "" && n.Subject == "" && n.Body == "")
}

// ValidateNotifyEmail — серверная проверка настройки (инвариант 3, независимо от
// фронта). Чистая функция без HTTP/SQL; нарушение → ErrValidation (→ 422).
func ValidateNotifyEmail(n *NotifyEmail) error {
	if n == nil {
		return nil
	}
	for _, f := range []struct {
		name string
		v    string
		max  int
	}{
		{"fromName", n.FromName, MaxNotifyFromNameLen},
		{"replyTo", n.ReplyTo, MaxTextAnswerLen},
		{"subject", n.Subject, MaxNotifySubjectLen},
		{"body", n.Body, MaxNotifyBodyLen},
	} {
		if n := utf8.RuneCountInString(f.v); n > f.max {
			return schemaErr("notifyEmail: %s длиннее %d символов", f.name, f.max)
		}
	}
	// Reply-To проверяется строго: битый адрес здесь не «некрасиво», а письмо,
	// которое отвергнет почтовый провайдер, — то есть молча пропавшее уведомление.
	if n.ReplyTo != "" {
		addr, err := mail.ParseAddress(n.ReplyTo)
		if err != nil || addr.Address != n.ReplyTo || addr.Name != "" {
			return schemaErr("notifyEmail: replyTo — нужен адрес вида name@example.com")
		}
	}
	return nil
}
