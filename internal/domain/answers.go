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

	"github.com/google/uuid"
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

// NormalizeAnswers — единственная точка приёма ответа (фаза 21): вычищает то, чего
// респондент не видел, и проверяет оставшееся. Возвращает карту, которую и надо писать
// в базу.
//
// Порядок именно такой. Сперва вычистка (StripHiddenAnswers), потом проверка: иначе
// обязательным оказался бы вопрос за невыполненным условием, а в базу попали бы ответы
// на вопросы, которых человек не видел. Клиент чистит ответ у себя тем же движком, но
// доверия к нему нет никакого — план считается здесь заново (инвариант 3 проекта).
func NormalizeAnswers(schema FormSchema, answers map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	clean := StripHiddenAnswers(schema.Blocks, answers)
	// План по УЖЕ очищенным ответам — тот же, что по исходным (инвариант logic.go), но
	// считать его надо от того, что будет сохранено: так «обязательные среди видимых»
	// и содержимое базы описывают одну и ту же форму.
	plan := PlanForm(schema.Blocks, clean)
	// Действие «скрыть кнопку» — не украшение: ветка-тупик обязана быть тупиком и для
	// того, кто шлёт запрос мимо формы. Ошибка формы целиком, а не под block_id: она
	// не про поле, и вешать её на произвольный вопрос значило бы подсветить в
	// интерфейсе не то место (инвариант безопасности 3).
	if plan.Blocked {
		return nil, fmt.Errorf("%w: форма не принимает ответ — условие скрывает кнопку отправки", ErrValidation)
	}
	if err := validateAnswers(schema, clean, plan); err != nil {
		return nil, err
	}
	return clean, nil
}

// ValidateAnswers проверяет ответы против схемы БЕЗ учёта условной логики. Оставлена
// для тестов и для кода, которому нужна чистая проверка формата; приём ответа ходит
// через NormalizeAnswers.
func ValidateAnswers(schema FormSchema, answers map[string]json.RawMessage) error {
	return validateAnswers(schema, answers, PlanForm(schema.Blocks, answers))
}

// validateAnswers — общая проверка против ПЛАНА: nil — ответ валиден. Иначе —
// AnswerErrors с сообщением под каждым проблемным block_id (собираются все
// нарушения за один проход, чтобы респондент увидел их разом, а не по одному).
func validateAnswers(schema FormSchema, answers map[string]json.RawMessage, plan Plan) error {
	errs := AnswerErrors{}

	known := make(map[string]struct{}, len(schema.Blocks))
	for i := range schema.Blocks {
		b := schema.Blocks[i]
		// Неотвечаемый блок (text) не ждёт ответа: не в known, не валидируем.
		// Присланный на него ответ попадёт ниже в «несуществующий вопрос».
		if b.Type.isContent() {
			continue
		}
		// Скрытый вопрос остаётся ИЗВЕСТНЫМ: ответ на него уже вычищен нормализацией,
		// а «несуществующим вопросом» его звать нельзя — он в форме есть, просто не был
		// показан. Проверять его нечего: обязательности у скрытого не бывает.
		known[b.ID] = struct{}{}
		if !plan.Visible[b.ID] {
			continue
		}
		if msg := validateAnswer(b, answers[b.ID], plan.Required[b.ID]); msg != "" {
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
func validateAnswer(b Block, raw json.RawMessage, required bool) string {
	if b.Type.isChoice() {
		return validateChoiceAnswer(b, raw, required)
	}
	if b.Type.isScaleLike() {
		return validateScaleAnswer(b, raw, required)
	}
	if b.Type == BlockConsent {
		return validateConsentAnswer(b, raw, required)
	}
	if b.Type == BlockFile {
		return validateFileAnswer(b, raw, required)
	}
	if b.Type == BlockSlot {
		return validateSlotAnswer(raw, required)
	}
	return validateTextAnswer(b, raw, required)
}

// validateSlotAnswer — запись на время (фаза 27).
//
// ⚠ У ЭТОГО ТИПА ДВА ФОРМАТА ЗНАЧЕНИЯ, И ПУТАТЬ ИХ НЕЛЬЗЯ.
//
//	НА ПРОВОДЕ — id брони, которую респондент придержал, выбрав время. Больше от
//	клиента не приезжает ничего: поверить присланному времени значило бы позволить
//	записаться на слот, которого никто не бронировал (инвариант 3).
//	В БАЗЕ — время начала строкой RFC3339, которое ПИШЕТ СЕРВЕР из строки bookings
//	при подтверждении. Ответ хранит снапшот, а не ссылку: время брони после
//	подтверждения не меняется, а таблица ответов, CSV и лист интеграции читают его
//	без единого джойна.
//
// Здесь проверяется первый формат — тот, что приходит с ответом. Существует ли бронь,
// той ли она формы и не отменена ли — вопросы к базе, и их задаёт приём ответа
// (submissions), как он же заявляет файлы. Этот файл остаётся чистой функцией.
func validateSlotAnswer(raw json.RawMessage, required bool) string {
	if len(raw) == 0 {
		if required {
			return msgRequired
		}
		return ""
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return "ожидалось выбранное время"
	}
	if v == "" {
		if required {
			return msgRequired
		}
		return ""
	}
	// Годен и id брони (пришёл от респондента), и время (уже записано сервером):
	// валидатор зовут оба пути — приём ответа и повторная проверка сохранённого.
	//
	// Id проверяется как UUID, а не через validateID: тот сторожит идентификаторы
	// БЛОКОВ (любая строка автора), а здесь значение обязано быть тем, что выдал
	// сервер, — иначе «четверг после обеда» проходит за бронь.
	if _, err := uuid.Parse(v); err == nil {
		return ""
	}
	if validRFC3339(v) {
		return ""
	}
	return "время записи не выбрано"
}

// validRFC3339 — время в том виде, в каком его пишет сервер (UTC, RFC3339).
func validRFC3339(v string) bool {
	_, err := time.Parse(time.RFC3339, v)
	return err == nil
}

// validateFileAnswer — файлы: ответ приходит массивом id загрузок, выданных
// сервером (design/answer-files.md §4.2), как multi_choice приходит массивом id
// опций.
//
// Здесь проверяется ФОРМА ответа, и только она: существуют ли эти загрузки, той ли
// они формы и совпал ли размер — вопросы к базе и хранилищу, а этот файл остаётся
// чистой функцией без SQL и HTTP. Заявление загрузок делает submissions при приёме;
// пропустить его нельзя — иначе в ответе окажется ссылка на чужой или несуществующий
// объект.
func validateFileAnswer(b Block, raw json.RawMessage, required bool) string {
	if len(raw) == 0 {
		if required {
			return msgRequired
		}
		return ""
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return "ожидался список файлов"
	}
	if len(ids) == 0 {
		if required {
			return msgRequired
		}
		return ""
	}
	maxFiles, _ := FileLimits(b)
	if len(ids) > maxFiles {
		return fmt.Sprintf("больше %d файлов", maxFiles)
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if err := validateID(id); err != nil {
			return "некорректный файл"
		}
		if _, dup := seen[id]; dup {
			return "повторяющийся файл"
		}
		seen[id] = struct{}{}
	}
	return ""
}

// ConsentYes — значение отмеченного согласия. Ответ хранится строкой, а не булевым
// (решение владельца): это конвенция проекта (number/date тоже строки), и пустая
// строка = «не отмечено» даёт обязательность даром — без спецслучая в required.
const ConsentYes = "yes"

// validateConsentAnswer — согласие: либо ConsentYes, либо пусто. Обязательность —
// обычный флаг required (решение владельца): необязательное согласие это реальный
// случай (подписка на рассылку, маркетинг-opt-in), поэтому спецслучая «consent
// всегда обязателен» в валидаторе нет. Текст согласия — label блока.
func validateConsentAnswer(b Block, raw json.RawMessage, required bool) string {
	if len(raw) == 0 {
		if required {
			return msgRequired
		}
		return ""
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return "ожидалась строка"
	}
	if v == "" {
		if required {
			return msgRequired
		}
		return ""
	}
	if v != ConsentYes {
		return "недопустимое значение согласия"
	}
	return ""
}

// validateScaleAnswer — шкала: ответ приходит строкой с целым числом (как number и
// date, конвенция проекта), которое обязано попадать в диапазон блока. Диапазон
// берётся из ТОЙ ЖЕ версии схемы, против которой валидируется ответ, поэтому смена
// диапазона владельцем не делает старые ответы невалидными задним числом.
func validateScaleAnswer(b Block, raw json.RawMessage, required bool) string {
	if len(raw) == 0 {
		if required {
			return msgRequired
		}
		return ""
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return "ожидалась строка"
	}
	if v == "" {
		if required {
			return msgRequired
		}
		return ""
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return "ожидалось целое число"
	}
	min, max := scaleRange(b)
	if n < min || n > max {
		return fmt.Sprintf("значение вне диапазона %d–%d", min, max)
	}
	return ""
}

// scaleRange — диапазон ответа блока с рядом делений: у рейтинга 1..число звёзд, у
// шкалы — из настроек с фолбэком на дефолт, если схема его не несёт (черновик без
// диапазона; редактор такой не создаёт). Зеркалит markRange на фронте.
func scaleRange(b Block) (int, int) {
	if b.Type == BlockRating {
		return 1, ratingStars(b)
	}
	min, max := DefaultScaleMin, DefaultScaleMax
	if b.Settings.ScaleMin != nil && b.Settings.ScaleMax != nil {
		min, max = *b.Settings.ScaleMin, *b.Settings.ScaleMax
	}
	return min, max
}

// validateTextAnswer — типы, чьё значение приходит JSON-строкой (short_text,
// long_text, email, number, date).
func validateTextAnswer(b Block, raw json.RawMessage, required bool) string {
	if len(raw) == 0 {
		if required {
			return msgRequired
		}
		return ""
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return "ожидалась строка"
	}
	if v == "" {
		if required {
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
func validateChoiceAnswer(b Block, raw json.RawMessage, required bool) string {
	opts := make(map[string]struct{}, len(b.Settings.Options))
	for _, o := range b.Settings.Options {
		opts[o.ID] = struct{}{}
	}

	if b.Type.isSingleChoice() {
		if len(raw) == 0 {
			if required {
				return msgRequired
			}
			return ""
		}
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return "ожидался выбор одного варианта"
		}
		if v == "" {
			if required {
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
		if required {
			return msgRequired
		}
		return ""
	}
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return "ожидался список вариантов"
	}
	if len(ids) == 0 {
		if required {
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
