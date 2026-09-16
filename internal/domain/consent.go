package domain

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Согласие на обработку персональных данных — настройка формы, а не блок полотна
// (docs/design/privacy-consent.md). Галочка рисуется под кнопкой отправки, а текст
// согласия и политики собирается из реквизитов оператора (типовой) или вставляется
// автором (свой). Хранится ревизиями: form_consent_revisions, одна строка на
// сохранение, и ответ ссылается на ту, при которой принят.
//
// Оператор персональных данных — автор формы, а не Trillix (ч. 3 ст. 6 152-ФЗ):
// Trillix обрабатывает ответы по его поручению. Поэтому типовой текст без реквизитов
// автора пуст, и назвать оператора за него продукт не может.

// ConsentDocMode — откуда берётся текст документа.
type ConsentDocMode string

const (
	// ConsentDocTemplate — типовой текст, собранный из реквизитов (consentdoc.go).
	ConsentDocTemplate ConsentDocMode = "template"
	// ConsentDocCustom — текст автора, хранится в ревизии как есть. Ссылки на внешний
	// документ нет намеренно: содержимое по ссылке не видно и может быть подменено
	// (решение владельца 2026-09-16).
	ConsentDocCustom ConsentDocMode = "custom"
)

// ConsentDocKind — какой из двух документов.
type ConsentDocKind string

const (
	ConsentDocConsent ConsentDocKind = "consent"
	ConsentDocPolicy  ConsentDocKind = "policy"
)

// Потолки полей в рунах. Зеркалят web/app/src/entities/consent.ts.
const (
	MaxConsentOperatorNameLen    = 300
	MaxConsentOperatorAddressLen = 500
	MaxConsentEmailLen           = 254
	MaxConsentPurposeLen         = 1000
	MaxConsentRetentionLen       = 500
	// Политика обработки — длинный документ: у настоящих политик 15–40 тысяч знаков.
	MaxConsentDocTextLen = 60000
)

// ConsentOperator — реквизиты оператора, которые попадают в типовой текст.
type ConsentOperator struct {
	// Name — наименование организации или ФИО индивидуального предпринимателя.
	Name string `json:"name"`
	// INN — необязателен: у физического лица его в документе может не быть.
	INN     string `json:"inn"`
	Address string `json:"address"`
	// Email — куда субъект направляет отзыв согласия и запросы.
	Email string `json:"email"`
}

// ConsentDoc — один документ: источник текста и сам текст для своего.
type ConsentDoc struct {
	Mode ConsentDocMode `json:"mode"`
	// Text — текст автора. Читается только при Mode = custom, но хранится при любом:
	// переключение на типовой и обратно не теряет вставленное.
	Text string `json:"text"`
}

// ConsentSettings — всё, что лежит в form_consent_revisions.settings.
type ConsentSettings struct {
	Operator ConsentOperator `json:"operator"`
	// Purpose и Retention — пусто означает формулировку по умолчанию типового текста
	// (DefaultConsentPurpose / DefaultConsentRetention).
	Purpose   string     `json:"purpose"`
	Retention string     `json:"retention"`
	Consent   ConsentDoc `json:"consent"`
	Policy    ConsentDoc `json:"policy"`
}

// NormalizeConsentSettings обрезает пробелы по краям однострочных полей и
// подставляет типовой источник документу без режима. Тексты документов не
// трогаются: переносы строк в них — часть документа.
func NormalizeConsentSettings(s ConsentSettings) ConsentSettings {
	s.Operator.Name = strings.TrimSpace(s.Operator.Name)
	s.Operator.INN = strings.TrimSpace(s.Operator.INN)
	s.Operator.Address = strings.TrimSpace(s.Operator.Address)
	s.Operator.Email = strings.TrimSpace(s.Operator.Email)
	s.Purpose = strings.TrimSpace(s.Purpose)
	s.Retention = strings.TrimSpace(s.Retention)
	if s.Consent.Mode == "" {
		s.Consent.Mode = ConsentDocTemplate
	}
	if s.Policy.Mode == "" {
		s.Policy.Mode = ConsentDocTemplate
	}
	return s
}

// ValidateConsentSettings — проверка раздела перед записью ревизии. Ждёт уже
// нормализованные настройки. Нарушение → ErrValidation (→ 422).
//
// Потолки длины проверяются всегда, обязательность — только у ВКЛЮЧЁННОГО согласия:
// выключенный раздел законно недозаполнен (автор выключил согласие посреди ввода).
// Реквизиты обязательны, только если хоть один документ типовой: свой текст несёт
// их сам.
func ValidateConsentSettings(enabled bool, s ConsentSettings) error {
	for _, f := range []struct {
		name string
		v    string
		max  int
	}{
		{"наименование оператора", s.Operator.Name, MaxConsentOperatorNameLen},
		{"адрес оператора", s.Operator.Address, MaxConsentOperatorAddressLen},
		{"email для отзыва согласия", s.Operator.Email, MaxConsentEmailLen},
		{"цель обработки", s.Purpose, MaxConsentPurposeLen},
		{"срок обработки", s.Retention, MaxConsentRetentionLen},
		{"текст согласия", s.Consent.Text, MaxConsentDocTextLen},
		{"текст политики", s.Policy.Text, MaxConsentDocTextLen},
	} {
		if utf8.RuneCountInString(f.v) > f.max {
			return fmt.Errorf("%w: %s длиннее %d символов", ErrValidation, f.name, f.max)
		}
	}
	for _, d := range []struct {
		name string
		doc  ConsentDoc
	}{{"согласия", s.Consent}, {"политики", s.Policy}} {
		if d.doc.Mode != ConsentDocTemplate && d.doc.Mode != ConsentDocCustom {
			return fmt.Errorf("%w: неизвестный источник текста %s", ErrValidation, d.name)
		}
	}
	if s.Operator.INN != "" && !validINN(s.Operator.INN) {
		return fmt.Errorf("%w: ИНН — 10 или 12 цифр", ErrValidation)
	}
	if s.Operator.Email != "" && !validEmail(s.Operator.Email) {
		return fmt.Errorf("%w: email для отзыва согласия — нужен адрес вида name@example.com", ErrValidation)
	}
	if !enabled {
		return nil
	}

	if s.Consent.Mode == ConsentDocTemplate || s.Policy.Mode == ConsentDocTemplate {
		switch {
		case s.Operator.Name == "":
			return fmt.Errorf("%w: укажите наименование оператора или ФИО", ErrValidation)
		case s.Operator.Address == "":
			return fmt.Errorf("%w: укажите адрес оператора", ErrValidation)
		case s.Operator.Email == "":
			return fmt.Errorf("%w: укажите email для отзыва согласия", ErrValidation)
		}
	}
	if s.Consent.Mode == ConsentDocCustom && strings.TrimSpace(s.Consent.Text) == "" {
		return fmt.Errorf("%w: вставьте текст согласия", ErrValidation)
	}
	if s.Policy.Mode == ConsentDocCustom && strings.TrimSpace(s.Policy.Text) == "" {
		return fmt.Errorf("%w: вставьте текст политики", ErrValidation)
	}
	return nil
}

// validINN — 10 цифр у организации, 12 у физического лица и ИП. Контрольная сумма не
// проверяется: опечатку автор видит в предпросмотре документа.
func validINN(v string) bool {
	if len(v) != 10 && len(v) != 12 {
		return false
	}
	for _, r := range v {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
