package domain

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"
)

func TestValidateSchema_Valid(t *testing.T) {
	cases := map[string]string{
		"пустой каркас (дефолт БД, без schemaVersion)": `{"blocks":[]}`,
		"все семь типов": `{
			"schemaVersion":1,
			"blocks":[
				{"id":"blk_1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}},
				{"id":"blk_2","type":"long_text","label":"О себе","required":false,"settings":{}},
				{"id":"blk_3","type":"email","label":"Почта","required":true,"settings":{}},
				{"id":"blk_4","type":"number","label":"Возраст","required":false,"settings":{}},
				{"id":"blk_5","type":"date","label":"Дата","required":false,"settings":{}},
				{"id":"blk_6","type":"single_choice","label":"Откуда","required":false,"settings":{"options":[{"id":"o1","label":"Друзья"},{"id":"o2","label":"Поиск"}]}},
				{"id":"blk_7","type":"multi_choice","label":"Языки","required":false,"settings":{"options":[{"id":"o1","label":"Go"}]}}
			]
		}`,
		"неотвечаемый text-блок":               `{"blocks":[{"id":"b","type":"text","label":"Раздел А","required":false,"settings":{}}]}`,
		"картинка с imageKey и alt":            `{"blocks":[{"id":"b","type":"image","label":"","required":false,"settings":{"imageKey":"ws/deadbeef.png","alt":"Схема"}}]}`,
		"картинка без ключа — черновик":        `{"blocks":[{"id":"b","type":"image","label":"","required":false,"settings":{}}]}`,
		"submitLabel задан":                    `{"blocks":[],"submitLabel":"Готово"}`,
		"thankYouText задан":                   `{"blocks":[],"thankYouText":"Ждём вас на встрече!"}`,
		"redirectUrl https":                    `{"blocks":[],"redirectUrl":"https://example.com/thanks"}`,
		"redirectUrl http с портом и query":    `{"blocks":[],"redirectUrl":"http://example.com:8080/ok?from=form"}`,
		"оба поля экрана заданы":               `{"blocks":[],"thankYouText":"Спасибо!","redirectUrl":"https://example.com"}`,
		"placeholder у текстового поля":        `{"blocks":[{"id":"b","type":"short_text","label":"Имя","settings":{"placeholder":"Например, Иван"}}]}`,
		"choice без опций — валидный черновик": `{"blocks":[{"id":"b","type":"single_choice","label":"","required":false,"settings":{}}]}`,
		"пустой label — валидный черновик":     `{"blocks":[{"id":"b","type":"short_text","label":"","required":false,"settings":{}}]}`,
		"settings опущен":                      `{"blocks":[{"id":"b","type":"short_text","label":"x","required":false}]}`,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateSchema(json.RawMessage(raw)); err != nil {
				t.Fatalf("ожидалась валидная схема, получена ошибка: %v", err)
			}
		})
	}
}

func TestValidateSchema_Invalid(t *testing.T) {
	// Блоки собираются для превышений лимитов программно.
	manyBlocks := make([]string, MaxBlocks+1)
	for i := range manyBlocks {
		manyBlocks[i] = `{"id":"b` + strconv.Itoa(i) + `","type":"short_text","label":"x","settings":{}}`
	}
	tooManyBlocks := `{"blocks":[` + strings.Join(manyBlocks, ",") + `]}`

	manyOpts := make([]string, MaxOptions+1)
	for i := range manyOpts {
		manyOpts[i] = `{"id":"o` + strconv.Itoa(i) + `","label":"x"}`
	}
	tooManyOpts := `{"blocks":[{"id":"b","type":"single_choice","label":"x","settings":{"options":[` +
		strings.Join(manyOpts, ",") + `]}}]}`

	longLabel := `{"blocks":[{"id":"b","type":"short_text","label":"` + strings.Repeat("я", MaxLabelLen+1) + `","settings":{}}]}`
	longSubmit := `{"blocks":[],"submitLabel":"` + strings.Repeat("я", MaxSubmitLabelLen+1) + `"}`
	longPlaceholder := `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"placeholder":"` +
		strings.Repeat("я", MaxPlaceholderLen+1) + `"}}]}`
	longImageKey := `{"blocks":[{"id":"b","type":"image","label":"","settings":{"imageKey":"` +
		strings.Repeat("a", MaxImageKeyLen+1) + `"}}]}`
	longAlt := `{"blocks":[{"id":"b","type":"image","label":"","settings":{"alt":"` +
		strings.Repeat("я", MaxAltLen+1) + `"}}]}`
	longThankYou := `{"blocks":[],"thankYouText":"` + strings.Repeat("я", MaxThankYouTextLen+1) + `"}`
	longRedirect := `{"blocks":[],"redirectUrl":"https://example.com/` +
		strings.Repeat("a", MaxRedirectURLLen) + `"}`

	cases := map[string]string{
		"слишком длинный submitLabel": longSubmit,
		// Инвариант 4: значение уходит в window.location — чужая схема там это XSS.
		"redirect javascript:":         `{"blocks":[],"redirectUrl":"javascript:alert(document.cookie)"}`,
		"redirect JavaScript: капсом":  `{"blocks":[],"redirectUrl":"JavaScript:alert(1)"}`,
		"redirect data:":               `{"blocks":[],"redirectUrl":"data:text/html,<script>alert(1)</script>"}`,
		"redirect относительный путь":  `{"blocks":[],"redirectUrl":"/thanks"}`,
		"redirect без схемы":           `{"blocks":[],"redirectUrl":"example.com"}`,
		"redirect http без хоста":      `{"blocks":[],"redirectUrl":"http://"}`,
		"слишком длинный thankYouText": longThankYou,
		"слишком длинный redirectUrl":  longRedirect,
		"слишком длинный placeholder":  longPlaceholder,
		"битый JSON":                   `{"blocks":`,
		"хвост после документа":        `{"blocks":[]}{}`,
		"неизвестная schemaVersion":    `{"schemaVersion":2,"blocks":[]}`,
		"лишнее поле верхнего уровня":  `{"blocks":[],"extra":1}`,
		"лишнее поле блока":            `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{},"foo":1}]}`,
		"лишнее поле в settings":       `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"foo":1}}]}`,
		"неизвестный тип блока":        `{"blocks":[{"id":"b","type":"slider","label":"x","settings":{}}]}`,
		"пустой id блока":              `{"blocks":[{"id":"","type":"short_text","label":"x","settings":{}}]}`,
		"дубль id блоков":              `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{}},{"id":"b","type":"email","label":"y","settings":{}}]}`,
		"non-choice с опциями":         `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"options":[{"id":"o","label":"z"}]}}]}`,
		"imageKey на не-image":         `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"imageKey":"ws/x.png"}}]}`,
		"alt на не-image":              `{"blocks":[{"id":"b","type":"text","label":"x","settings":{"alt":"y"}}]}`,
		"image с опциями":              `{"blocks":[{"id":"b","type":"image","label":"","settings":{"options":[{"id":"o","label":"z"}]}}]}`,
		"слишком длинный imageKey":     longImageKey,
		"слишком длинный alt":          longAlt,
		"дубль id опций внутри блока":  `{"blocks":[{"id":"b","type":"single_choice","label":"x","settings":{"options":[{"id":"o","label":"a"},{"id":"o","label":"b"}]}}]}`,
		"пустой id опции":              `{"blocks":[{"id":"b","type":"single_choice","label":"x","settings":{"options":[{"id":"","label":"a"}]}}]}`,
		"слишком много блоков":         tooManyBlocks,
		"слишком много опций":          tooManyOpts,
		"слишком длинный label":        longLabel,
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ValidateSchema(json.RawMessage(raw))
			if err == nil {
				t.Fatalf("ожидалась ошибка, схема принята")
			}
			if !errors.Is(err, ErrValidation) {
				t.Fatalf("ошибка не обёрнута ErrValidation: %v", err)
			}
		})
	}
}
