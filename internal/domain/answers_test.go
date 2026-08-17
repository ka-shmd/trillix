package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// choice собирает choice-блок с опциями по их id (label = id — для теста неважен).
func choice(id string, t BlockType, required bool, optIDs ...string) Block {
	b := Block{ID: id, Type: t, Required: required}
	for _, o := range optIDs {
		b.Settings.Options = append(b.Settings.Options, Option{ID: o, Label: o})
	}
	return b
}

func field(id string, t BlockType, required bool) Block {
	return Block{ID: id, Type: t, Required: required}
}

// raws переводит литералы JSON в карту сырых ответов, как её отдаёт разбор тела.
func raws(m map[string]string) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(m))
	for k, v := range m {
		out[k] = json.RawMessage(v)
	}
	return out
}

// allTypes — форма со всеми отвечаемыми типами, все необязательные (общий стенд
// валидных проверок). choice-блоки несут по две опции o1/o2.
func allTypes(required bool) FormSchema {
	return FormSchema{
		SchemaVersion: SchemaVersion,
		Blocks: []Block{
			field("short", BlockShortText, required),
			field("long", BlockLongText, required),
			field("mail", BlockEmail, required),
			field("tel", BlockPhone, required),
			field("num", BlockNumber, required),
			field("date", BlockDate, required),
			choice("single", BlockSingleChoice, required, "o1", "o2"),
			choice("drop", BlockDropdown, required, "o1", "o2"),
			choice("multi", BlockMultiChoice, required, "o1", "o2"),
		},
	}
}

func TestValidateAnswers_Valid(t *testing.T) {
	cases := map[string]struct {
		schema  FormSchema
		answers map[string]string
	}{
		"все типы заполнены верно": {
			allTypes(false),
			map[string]string{
				"short":  `"Иван"`,
				"long":   `"длинный текст"`,
				"mail":   `"a@b.co"`,
				"tel":    `"+7 900 123-45-67"`,
				"num":    `"42"`,
				"date":   `"2024-01-02"`,
				"single": `"o1"`,
				"drop":   `"o2"`,
				"multi":  `["o1","o2"]`,
			},
		},
		"необязательные пропущены целиком": {allTypes(false), map[string]string{}},
		"необязательные заданы пустыми": {
			allTypes(false),
			map[string]string{"short": `""`, "mail": `""`, "single": `""`, "multi": `[]`},
		},
		"число дробное и отрицательное": {
			FormSchema{Blocks: []Block{field("n", BlockNumber, true)}},
			map[string]string{"n": `"-3.14"`},
		},
		"число ноль":                {FormSchema{Blocks: []Block{field("n", BlockNumber, true)}}, map[string]string{"n": `"0"`}},
		"multi_choice один вариант": {allTypes(false), map[string]string{"multi": `["o2"]`}},
		"обязательные все заполнены": {
			allTypes(true),
			map[string]string{
				"short": `"x"`, "long": `"y"`, "mail": `"a@b.co"`, "tel": `"+79001234567"`,
				"num": `"1"`, "date": `"2024-12-31"`, "single": `"o2"`, "drop": `"o1"`,
				"multi": `["o1"]`,
			},
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ValidateAnswers(c.schema, raws(c.answers)); err != nil {
				t.Fatalf("ожидался валидный ответ, получена ошибка: %v", err)
			}
		})
	}
}

func TestValidateAnswers_Invalid(t *testing.T) {
	cases := map[string]struct {
		schema   FormSchema
		answers  map[string]string
		badBlock string // block_id, под которым ждём сообщение в карте
	}{
		// Обязательность (по типам).
		"required short пустой":         {allTypes(true), map[string]string{"short": `""`}, "short"},
		"required short пропущен":       {FormSchema{Blocks: []Block{field("short", BlockShortText, true)}}, map[string]string{}, "short"},
		"required multi пустой список":  {FormSchema{Blocks: []Block{choice("multi", BlockMultiChoice, true, "o1")}}, map[string]string{"multi": `[]`}, "multi"},
		"required single пустая строка": {FormSchema{Blocks: []Block{choice("single", BlockSingleChoice, true, "o1")}}, map[string]string{"single": `""`}, "single"},

		// Формат.
		"email кривой":         {FormSchema{Blocks: []Block{field("mail", BlockEmail, true)}}, map[string]string{"mail": `"нет-собаки"`}, "mail"},
		"число не число":       {FormSchema{Blocks: []Block{field("num", BlockNumber, true)}}, map[string]string{"num": `"abc"`}, "num"},
		"число NaN":            {FormSchema{Blocks: []Block{field("num", BlockNumber, true)}}, map[string]string{"num": `"NaN"`}, "num"},
		"число Inf":            {FormSchema{Blocks: []Block{field("num", BlockNumber, true)}}, map[string]string{"num": `"Inf"`}, "num"},
		"дата неверный формат": {FormSchema{Blocks: []Block{field("date", BlockDate, true)}}, map[string]string{"date": `"2024/01/02"`}, "date"},
		"дата несуществующая":  {FormSchema{Blocks: []Block{field("date", BlockDate, true)}}, map[string]string{"date": `"2024-13-40"`}, "date"},

		// Принадлежность опций.
		"single чужой id": {allTypes(false), map[string]string{"single": `"zzz"`}, "single"},
		// dropdown — одиночный выбор: ждёт строку-id, как single_choice. Массив тут
		// означал бы, что тип уехал в ветку multi.
		"dropdown чужой id":        {allTypes(false), map[string]string{"drop": `"zzz"`}, "drop"},
		"dropdown как массив":      {allTypes(false), map[string]string{"drop": `["o1"]`}, "drop"},
		"required dropdown пустой": {FormSchema{Blocks: []Block{choice("d", BlockDropdown, true, "o1")}}, map[string]string{"d": `""`}, "d"},
		"multi чужой id":           {allTypes(false), map[string]string{"multi": `["o1","zzz"]`}, "multi"},
		"multi дубли id":           {allTypes(false), map[string]string{"multi": `["o1","o1"]`}, "multi"},

		// Неверный JSON-тип значения.
		"short как число":         {allTypes(false), map[string]string{"short": `42`}, "short"},
		"single как массив":       {allTypes(false), map[string]string{"single": `["o1"]`}, "single"},
		"multi как строка":        {allTypes(false), map[string]string{"multi": `"o1"`}, "multi"},
		"multi элемент не строка": {allTypes(false), map[string]string{"multi": `[1,2]`}, "multi"},

		// Ответ на несуществующий блок.
		"лишний block_id": {allTypes(false), map[string]string{"ghost": `"x"`}, "ghost"},

		// Длина.
		"short слишком длинный": {
			FormSchema{Blocks: []Block{field("short", BlockShortText, false)}},
			map[string]string{"short": `"` + strings.Repeat("я", MaxTextAnswerLen+1) + `"`},
			"short",
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			err := ValidateAnswers(c.schema, raws(c.answers))
			if err == nil {
				t.Fatalf("ожидалась ошибка валидации, получено nil")
			}
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("ошибка не оборачивает ErrValidation: %v", err)
			}
			var fields AnswerErrors
			if !errors.As(err, &fields) {
				t.Fatalf("ошибка не несёт карту полей AnswerErrors: %v", err)
			}
			if _, ok := fields[c.badBlock]; !ok {
				t.Fatalf("ожидалось сообщение под block_id %q, карта: %v", c.badBlock, fields)
			}
		})
	}
}

// Согласие: «yes» или пусто. Обязательность — обычный флаг required (решение
// владельца), а не правило типа: необязательное согласие это маркетинг-opt-in.
func TestValidateAnswers_Consent(t *testing.T) {
	req := FormSchema{Blocks: []Block{field("c", BlockConsent, true)}}
	opt := FormSchema{Blocks: []Block{field("c", BlockConsent, false)}}

	if err := ValidateAnswers(req, raws(map[string]string{"c": `"yes"`})); err != nil {
		t.Fatalf("отмеченное обязательное согласие валидно: %v", err)
	}
	// Ключевой кейс: неотмеченное обязательное согласие обязано падать. Именно ради
	// него ответ хранится строкой — пустое значение ловится общим required.
	if err := ValidateAnswers(req, raws(map[string]string{"c": `""`})); err == nil {
		t.Fatal("неотмеченное обязательное согласие принято")
	}
	if err := ValidateAnswers(req, raws(map[string]string{})); err == nil {
		t.Fatal("пропущенное обязательное согласие принято")
	}
	// Необязательное согласие можно не отмечать (opt-in).
	if err := ValidateAnswers(opt, raws(map[string]string{"c": `""`})); err != nil {
		t.Fatalf("неотмеченное необязательное согласие валидно: %v", err)
	}
	// Чужое значение — не согласие.
	if err := ValidateAnswers(opt, raws(map[string]string{"c": `"no"`})); err == nil {
		t.Fatal("произвольное значение согласия принято")
	}
}

// Шкала: ответ — строка с целым числом в диапазоне ТОЙ версии схемы, против
// которой валидируется (смена диапазона не делает старые ответы невалидными).
func TestValidateAnswers_Scale(t *testing.T) {
	scale := func(id string, required bool, min, max int) Block {
		b := Block{ID: id, Type: BlockScale, Required: required}
		b.Settings.ScaleMin, b.Settings.ScaleMax = &min, &max
		return b
	}
	nps := FormSchema{Blocks: []Block{scale("s", true, 0, 10)}}

	if err := ValidateAnswers(nps, raws(map[string]string{"s": `"0"`})); err != nil {
		t.Fatalf("ноль — законное значение NPS-шкалы: %v", err)
	}
	if err := ValidateAnswers(nps, raws(map[string]string{"s": `"10"`})); err != nil {
		t.Fatalf("верхняя граница включительна: %v", err)
	}
	for name, v := range map[string]string{
		"выше максимума": `"11"`,
		"ниже минимума":  `"-1"`,
		"не целое":       `"3.5"`,
		"не число":       `"пять"`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateAnswers(nps, raws(map[string]string{"s": v})); err == nil {
				t.Fatalf("ожидалась ошибка для %s", v)
			}
		})
	}
	// Диапазон блока, а не глобальный: 7 вне 1–5.
	if err := ValidateAnswers(FormSchema{Blocks: []Block{scale("s", false, 1, 5)}},
		raws(map[string]string{"s": `"7"`})); err == nil {
		t.Fatal("значение вне диапазона блока принято")
	}
}

// Телефон проверяется МЯГКО (решение владельца): символы и число цифр, не формат
// страны. Тест фиксирует именно это: нестандартные, но легальные записи проходят —
// жёсткая маска РФ отсекала бы их, и это дороже ложного пропуска.
func TestValidPhone(t *testing.T) {
	valid := []string{
		"+7 900 123-45-67",  // РФ с разделителями
		"+79001234567",      // РФ слитно
		"8(900)123-45-67",   // городская запись со скобками
		"+380 44 123 4567",  // не РФ — маска страны отсекла бы
		"12345",             // минимум цифр
		"+1 (212) 555-0123", // США
	}
	for _, v := range valid {
		t.Run("валиден: "+v, func(t *testing.T) {
			if !validPhone(v) {
				t.Fatalf("ожидался валидный телефон: %q", v)
			}
		})
	}

	invalid := map[string]string{
		"буквы":                 "позвоните мне",
		"цифр меньше минимума":  "1234",
		"цифр больше максимума": "123456789012345678901",
		"пусто":                 "",
		"недопустимый символ":   "+7_900_1234567",
		"email вместо номера":   "a@b.co",
	}
	for name, v := range invalid {
		t.Run("невалиден: "+name, func(t *testing.T) {
			if validPhone(v) {
				t.Fatalf("ожидался невалидный телефон: %q", v)
			}
		})
	}
}

// Неотвечаемый блок (text) исключён из валидации: ответа не требует (даже с
// required=true в данных) и не участвует в проверке. Присланный на него ответ —
// «несуществующий вопрос», как и для любого чужого id.
func TestValidateAnswers_TextBlockNonAnswerable(t *testing.T) {
	schema := FormSchema{Blocks: []Block{
		{ID: "intro", Type: BlockText, Text: TextFromString("Добро пожаловать"), Required: true},
		field("name", BlockShortText, true),
	}}

	if err := ValidateAnswers(schema, raws(map[string]string{"name": `"Иван"`})); err != nil {
		t.Fatalf("text без ответа должен быть валиден: %v", err)
	}

	err := ValidateAnswers(schema, raws(map[string]string{"name": `"Иван"`, "intro": `"x"`}))
	var fields AnswerErrors
	if !errors.As(err, &fields) {
		t.Fatalf("ответ на text-блок должен дать AnswerErrors, получено: %v", err)
	}
	if _, ok := fields["intro"]; !ok {
		t.Fatalf("ожидалось сообщение под intro (несуществующий вопрос), карта: %v", fields)
	}
}

// Файлы: ответ — массив id загрузок, выданных сервером. Здесь проверяется ФОРМА
// ответа; существуют ли эти загрузки и той ли они формы — вопрос к базе, и его
// задаёт приём ответа, а не чистая функция.
func TestValidateAnswers_File(t *testing.T) {
	block := func(required bool, maxFiles int) FormSchema {
		b := Block{ID: "f", GroupID: "g", Type: BlockFile, Required: required}
		b.Settings.MaxFiles = maxFiles
		return FormSchema{Blocks: []Block{b}}
	}

	if err := ValidateAnswers(block(true, 3), raws(map[string]string{"f": `["u1","u2"]`})); err != nil {
		t.Fatalf("два файла при потолке три: %v", err)
	}
	if err := ValidateAnswers(block(false, 0), nil); err != nil {
		t.Fatalf("необязательный без файлов: %v", err)
	}

	for name, v := range map[string]string{
		"строка вместо массива": `"u1"`,
		"повтор одной загрузки": `["u1","u1"]`,
		"пустой id":             `["" ]`,
		"больше потолка":        `["u1","u2","u3"]`,
	} {
		t.Run(name, func(t *testing.T) {
			if err := ValidateAnswers(block(false, 2), raws(map[string]string{"f": v})); err == nil {
				t.Fatalf("ожидалась ошибка для %s", v)
			}
		})
	}

	// Обязательный: пустой массив — это «не ответил», а не «ответил ничем».
	if err := ValidateAnswers(block(true, 2), raws(map[string]string{"f": `[]`})); err == nil {
		t.Fatal("пустой список принят у обязательного вопроса")
	}

	// Дефолт потолка: блок без настроек принимает один файл, не два.
	if err := ValidateAnswers(block(false, 0), raws(map[string]string{"f": `["u1","u2"]`})); err == nil {
		t.Fatal("дефолтный потолок (1 файл) не сработал")
	}
}
