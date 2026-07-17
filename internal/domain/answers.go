package domain

import (
	"encoding/json"
	"fmt"
	"math"
	"net/mail"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Валидатор ответа респондента — самая ветвистая функция проекта (ARCHITECTURE
// §«Domain»). Проверяет карту ответов против *конкретной версии* схемы формы:
// обязательность, тип значения, принадлежность выбранных опций, длины. Чистая
// функция без HTTP и SQL: используется и при приёме ответа (фаза 5), и в тестах.
//
// Формат значений зеркалит клиентский тип Answer (web/shared/fields/answer.ts):
// текстовые типы и single_choice — JSON-строка, multi_choice — JSON-массив строк
// (id выбранных опций). number/date хранятся строкой (как их вводит респондент),
// формат проверяется здесь. Клиентская validation.ts — лишь подсказка; финальная
// инстанция — этот код.

// Лимиты длины ответа (в рунах). Вторичны к MaxBytesReader на теле (256 КБ), но
// дают внятную ошибку по конкретному полю раньше, чем распухнет весь документ.
const (
	MaxTextAnswerLen     = 5000  // short_text, email, number, date
	MaxLongTextAnswerLen = 20000 // long_text
)

// AnswerErrors — нарушения валидации ответа, по одному сообщению на block_id
// (ключ "" — для ответа на несуществующий блок, если id пуст). Реализует error и
// заворачивает ErrValidation: respond.go маппит на 422, а handler фазы 5 достанет
// карту через errors.As и положит её в fields конверта ошибки.
type AnswerErrors map[string]string

func (e AnswerErrors) Error() string {
	parts := make([]string, 0, len(e))
	for id, msg := range e {
		parts = append(parts, fmt.Sprintf("%s: %s", id, msg))
	}
	return "ответ не прошёл валидацию: " + strings.Join(parts, "; ")
}

// Is делает errors.Is(err, ErrValidation) истинным — единый маппинг на 422.
func (e AnswerErrors) Is(target error) bool { return target == ErrValidation }

// ValidateAnswers проверяет ответы против схемы. nil — ответ валиден. Иначе —
// AnswerErrors с сообщением под каждым проблемным block_id (собираются все
// нарушения за один проход, чтобы респондент увидел их разом, а не по одному).
func ValidateAnswers(schema FormSchema, answers map[string]json.RawMessage) error {
	errs := AnswerErrors{}

	known := make(map[string]struct{}, len(schema.Blocks))
	for i := range schema.Blocks {
		b := schema.Blocks[i]
		// Неотвечаемый блок (text) не ждёт ответа: не в known, не валидируем.
		// Присланный на него ответ попадёт ниже в «несуществующий вопрос».
		if b.Type.isContent() {
			continue
		}
		known[b.ID] = struct{}{}
		if msg := validateAnswer(b, answers[b.ID]); msg != "" {
			errs[b.ID] = msg
		}
	}

	// Ответ на блок, которого нет в схеме, — расхождение с формой (устаревшая
	// вкладка, ручной запрос): не молчим, а сообщаем под этим id.
	for id := range answers {
		if _, ok := known[id]; !ok {
			errs[id] = "ответ на несуществующий вопрос"
		}
	}

	if len(errs) == 0 {
		return nil
	}
	return errs
}

// validateAnswer проверяет один блок против сырого значения; "" — валиден.
// raw == nil означает «поля нет в ответах» (эквивалент пустого).
func validateAnswer(b Block, raw json.RawMessage) string {
	if b.Type.isChoice() {
		return validateChoiceAnswer(b, raw)
	}
	return validateTextAnswer(b, raw)
}

// validateTextAnswer — типы, чьё значение приходит JSON-строкой (short_text,
// long_text, email, number, date).
func validateTextAnswer(b Block, raw json.RawMessage) string {
	if len(raw) == 0 {
		if b.Required {
			return msgRequired
		}
		return ""
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return "ожидалась строка"
	}
	if v == "" {
		if b.Required {
			return msgRequired
		}
		return ""
	}

	limit := MaxTextAnswerLen
	if b.Type == BlockLongText {
		limit = MaxLongTextAnswerLen
	}
	if utf8.RuneCountInString(v) > limit {
		return fmt.Sprintf("длиннее %d символов", limit)
	}

	switch b.Type {
	case BlockEmail:
		if !validEmail(v) {
			return "некорректный email"
		}
	case BlockPhone:
		if !validPhone(v) {
			return "некорректный телефон"
		}
	case BlockNumber:
		if !validNumber(v) {
			return "введите число"
		}
	case BlockDate:
		if !validDate(v) {
			return "некорректная дата"
		}
	}
	return ""
}

// validateChoiceAnswer — одиночный выбор (single_choice, dropdown — строка-id) и
// multi_choice (массив id). Ветвление по isSingleChoice(), а не по конкретному
// типу: новый одиночный choice-тип иначе молча попадёт в ветку multi.
func validateChoiceAnswer(b Block, raw json.RawMessage) string {
	opts := make(map[string]struct{}, len(b.Settings.Options))
	for _, o := range b.Settings.Options {
		opts[o.ID] = struct{}{}
	}

	if b.Type.isSingleChoice() {
		if len(raw) == 0 {
			if b.Required {
				return msgRequired
			}
			return ""
		}
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return "ожидался выбор одного варианта"
		}
		if v == "" {
			if b.Required {
				return msgRequired
			}
			return ""
		}
		if _, ok := opts[v]; !ok {
			return "выбран неизвестный вариант"
		}
		return ""
	}

	// multi_choice.
	if len(raw) == 0 {
		if b.Required {
			return msgRequired
		}
		return ""
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return "ожидался список вариантов"
	}
	if len(ids) == 0 {
		if b.Required {
			return msgRequired
		}
		return ""
	}
	if len(ids) > MaxOptions {
		return fmt.Sprintf("больше %d вариантов", MaxOptions)
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, dup := seen[id]; dup {
			return "повторяющийся вариант"
		}
		seen[id] = struct{}{}
		if _, ok := opts[id]; !ok {
			return "выбран неизвестный вариант"
		}
	}
	return ""
}

const msgRequired = "обязательное поле"

// validEmail — адрес без имени и угловых скобок (net/mail допускает "Имя <a@b>",
// нам нужен голый адрес). Зеркалит по строгости клиентскую z.email().
func validEmail(v string) bool {
	addr, err := mail.ParseAddress(v)
	return err == nil && addr.Address == v && addr.Name == ""
}

// Границы числа цифр в телефоне. Зеркалят MIN/MAX_PHONE_DIGITS в
// web/shared/entities/formSchema.ts.
const (
	MinPhoneDigits = 5
	MaxPhoneDigits = 20
)

// validPhone — мягкая проверка: допустимые символы и количество цифр, НЕ формат
// конкретной страны (решение владельца, DEV-PLAN фаза 8.5 шаг 2). Жёсткая маска РФ
// отсекала бы легальные номера (+380, международные, запись через скобки/дефисы) —
// для формы ложный отказ дороже, чем принятая нестандартная запись. Зеркалит
// isValidPhone на фронте.
func validPhone(v string) bool {
	digits := 0
	for _, r := range v {
		switch {
		case r >= '0' && r <= '9':
			digits++
		case r == '+' || r == '(' || r == ')' || r == '-' || r == ' ':
			// Разделители записи — допустимы в любом месте: разбирать их взаимное
			// расположение значило бы вводить ту самую жёсткую маску.
		default:
			return false
		}
	}
	return digits >= MinPhoneDigits && digits <= MaxPhoneDigits
}

// validNumber — конечное число (NaN/Inf отвергаются, хотя ParseFloat их принимает).
func validNumber(v string) bool {
	f, err := strconv.ParseFloat(v, 64)
	return err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
}

// validDate — строгий ISO-день YYYY-MM-DD (time.Parse отвергает несуществующие дни).
func validDate(v string) bool {
	_, err := time.Parse("2006-01-02", v)
	return err == nil
}
