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
		"все отвечаемые типы": `{
			"schemaVersion":1,
			"blocks":[
				{"id":"blk_1","type":"short_text","label":"Имя","description":"","required":true,"settings":{}},
				{"id":"blk_2","type":"long_text","label":"О себе","required":false,"settings":{}},
				{"id":"blk_3","type":"email","label":"Почта","required":true,"settings":{}},
				{"id":"blk_4","type":"number","label":"Возраст","required":false,"settings":{}},
				{"id":"blk_8","type":"phone","label":"Телефон","settings":{}},
				{"id":"blk_9","type":"scale","label":"Оценка","settings":{"scaleMin":1,"scaleMax":5}},
				{"id":"blk_10","type":"dropdown","label":"Город","settings":{"options":[{"id":"o1","label":"Мск"}]}},
				{"id":"blk_5","type":"date","label":"Дата","required":false,"settings":{}},
				{"id":"blk_6","type":"single_choice","label":"Откуда","required":false,"settings":{"options":[{"id":"o1","label":"Друзья"},{"id":"o2","label":"Поиск"}]}},
				{"id":"blk_7","type":"multi_choice","label":"Языки","required":false,"settings":{"options":[{"id":"o1","label":"Go"}]}}
			]
		}`,
		"неотвечаемый text-блок":               `{"blocks":[{"id":"b","type":"text","label":"Раздел А","required":false,"settings":{}}]}`,
		"картинка с imageKey":                  `{"blocks":[{"id":"b","type":"image","label":"","required":false,"settings":{"imageKey":"ws/deadbeef.png"}}]}`,
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
		// v2: вопрос как группа блоков (фаза 8.7).
		"v2: группа title+поле":       `{"schemaVersion":2,"blocks":[{"id":"t1","groupId":"g1","type":"title","text":"Имя"},{"id":"b1","groupId":"g1","type":"short_text","settings":{}}]}`,
		"v2: голое поле без подписи":  `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"email","settings":{"placeholder":"you@ex.com"}}]}`,
		"v2: consent несёт свой text": `{"schemaVersion":2,"blocks":[{"id":"c1","groupId":"g1","type":"consent","text":"Соглашаюсь","required":true,"settings":{}}]}`,
		"v2: контент между подписью и полем": `{"schemaVersion":2,"blocks":[
			{"id":"l1","groupId":"g1","type":"label","text":"Логотип"},
			{"id":"im","groupId":"g1","type":"image","settings":{"imageKey":"ws/x.png"}},
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}}
		]}`,
		"v2: секционный heading своей группой": `{"schemaVersion":2,"blocks":[{"id":"h1","groupId":"g1","type":"heading","text":"О компании"},{"id":"b1","groupId":"g2","type":"short_text","settings":{}}]}`,
		// Фаза 13.6: half-ширина у whitelist-типов и колонки вариантов у choice-карточек.
		"width half у short_text":         `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"width":"half"}}]}`,
		"width half у dropdown":           `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"dropdown","settings":{"width":"half","options":[{"id":"o1","label":"Мск"}]}}]}`,
		"optionColumns 2 у single_choice": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"optionColumns":2,"options":[{"id":"o1","label":"Да"},{"id":"o2","label":"Нет"}]}}]}`,
		"optionColumns 2 у multi_choice":  `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"multi_choice","settings":{"optionColumns":2,"options":[{"id":"o1","label":"Go"}]}}]}`,
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

	longLabel := `{"blocks":[{"id":"b","type":"short_text","label":"` + strings.Repeat("я", MaxTextLen+1) + `","settings":{}}]}`
	longSubmit := `{"blocks":[],"submitLabel":"` + strings.Repeat("я", MaxSubmitLabelLen+1) + `"}`
	longPlaceholder := `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"placeholder":"` +
		strings.Repeat("я", MaxPlaceholderLen+1) + `"}}]}`
	longImageKey := `{"blocks":[{"id":"b","type":"image","label":"","settings":{"imageKey":"` +
		strings.Repeat("a", MaxImageKeyLen+1) + `"}}]}`
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
		"неизвестная schemaVersion":    `{"schemaVersion":99,"blocks":[]}`,
		"лишнее поле верхнего уровня":  `{"blocks":[],"extra":1}`,
		"лишнее поле блока":            `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{},"foo":1}]}`,
		"лишнее поле в settings":       `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"foo":1}}]}`,
		"неизвестный тип блока":        `{"blocks":[{"id":"b","type":"slider","label":"x","settings":{}}]}`,
		"пустой id блока":              `{"blocks":[{"id":"","type":"short_text","label":"x","settings":{}}]}`,
		"дубль id блоков":              `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{}},{"id":"b","type":"email","label":"y","settings":{}}]}`,
		"non-choice с опциями":         `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"options":[{"id":"o","label":"z"}]}}]}`,
		"imageKey на не-image":         `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"imageKey":"ws/x.png"}}]}`,
		// alt удалён из контракта целиком (фаза 13): отвергается даже у image.
		"alt удалён из контракта":       `{"blocks":[{"id":"b","type":"image","label":"","settings":{"imageKey":"ws/x.png","alt":"y"}}]}`,
		"image с опциями":               `{"blocks":[{"id":"b","type":"image","label":"","settings":{"options":[{"id":"o","label":"z"}]}}]}`,
		"слишком длинный imageKey":      longImageKey,
		"дубль id опций внутри блока":   `{"blocks":[{"id":"b","type":"single_choice","label":"x","settings":{"options":[{"id":"o","label":"a"},{"id":"o","label":"b"}]}}]}`,
		"пустой id опции":               `{"blocks":[{"id":"b","type":"single_choice","label":"x","settings":{"options":[{"id":"","label":"a"}]}}]}`,
		"слишком много блоков":          tooManyBlocks,
		"слишком много опций":           tooManyOpts,
		"слишком длинный текст подписи": longLabel,
		// v2: правила групп и собственного текста (фаза 8.7).
		"v2: text у отвечаемого не-consent": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","text":"нельзя","settings":{}}]}`,
		"v2: text у image":   `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"image","text":"нельзя","settings":{}}]}`,
		"v2: пустой groupId": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"","type":"short_text","settings":{}}]}`,
		"v2: группа разорвана чужим блоком": `{"schemaVersion":2,"blocks":[{"id":"a","groupId":"g1","type":"title","text":"A"},{"id":"b","groupId":"g2","type":"short_text","settings":{}},{"id":"c","groupId":"g1","type":"email","settings":{}}]}`,
		"v2: два отвечаемых в одной группе": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{}},{"id":"b2","groupId":"g1","type":"email","settings":{}}]}`,
		// Фаза 13.6: ширина и колонки вариантов вне whitelist / вне допустимых значений.
		"width у long_text (не whitelist)":     `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"long_text","settings":{"width":"half"}}]}`,
		"width у single_choice (не whitelist)": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"width":"half"}}]}`,
		"width неизвестное значение":           `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"width":"third"}}]}`,
		"width full не хранится":               `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"width":"full"}}]}`,
		"optionColumns у dropdown":             `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"dropdown","settings":{"optionColumns":2,"options":[{"id":"o1","label":"Мск"}]}}]}`,
		"optionColumns у short_text":           `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"optionColumns":2}}]}`,
		"optionColumns 3 недопустимо":          `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"optionColumns":3,"options":[{"id":"o1","label":"Да"}]}}]}`,
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

// Диапазон шкалы. Ключевой кейс — ноль: ScaleMin/ScaleMax сделаны указателями
// именно потому, что 0 — законный минимум (NPS 0–10), а с `omitempty` у int он
// вылетал бы из JSON и «не задано» стало бы неотличимо от «задано 0».
func TestValidateSchema_Scale(t *testing.T) {
	valid := map[string]string{
		"диапазон 1–5":                   `{"blocks":[{"id":"s","type":"scale","label":"Оценка","settings":{"scaleMin":1,"scaleMax":5}}]}`,
		"NPS 0–10 (ноль не теряется)":    `{"blocks":[{"id":"s","type":"scale","label":"NPS","settings":{"scaleMin":0,"scaleMax":10}}]}`,
		"шкала без диапазона — черновик": `{"blocks":[{"id":"s","type":"scale","label":"","settings":{}}]}`,
	}
	for name, raw := range valid {
		t.Run("валидна: "+name, func(t *testing.T) {
			s, err := ValidateSchema(json.RawMessage(raw))
			if err != nil {
				t.Fatalf("ожидалась валидная схема: %v", err)
			}
			// Ноль обязан доехать до типов, а не превратиться в «не задано».
			// После апгрейда v1→v2 шкала — уже не Blocks[0] (перед ней блок-подпись).
			if name == "NPS 0–10 (ноль не теряется)" {
				var min *int
				for _, b := range s.Blocks {
					if b.Type == BlockScale {
						min = b.Settings.ScaleMin
					}
				}
				if min == nil || *min != 0 {
					t.Fatalf("scaleMin=0 потерян при разборе: %v", min)
				}
			}
		})
	}

	invalid := map[string]string{
		"min больше max":          `{"blocks":[{"id":"s","type":"scale","label":"x","settings":{"scaleMin":5,"scaleMax":2}}]}`,
		"min равен max":           `{"blocks":[{"id":"s","type":"scale","label":"x","settings":{"scaleMin":3,"scaleMax":3}}]}`,
		"max выше потолка":        `{"blocks":[{"id":"s","type":"scale","label":"x","settings":{"scaleMin":1,"scaleMax":11}}]}`,
		"min ниже нуля":           `{"blocks":[{"id":"s","type":"scale","label":"x","settings":{"scaleMin":-1,"scaleMax":5}}]}`,
		"задан только один конец": `{"blocks":[{"id":"s","type":"scale","label":"x","settings":{"scaleMax":5}}]}`,
		"шкала у не-scale":        `{"blocks":[{"id":"b","type":"short_text","label":"x","settings":{"scaleMin":1,"scaleMax":5}}]}`,
	}
	for name, raw := range invalid {
		t.Run("невалидна: "+name, func(t *testing.T) {
			if _, err := ValidateSchema(json.RawMessage(raw)); err == nil {
				t.Fatal("ожидалась ошибка, схема принята")
			} else if !errors.Is(err, ErrValidation) {
				t.Fatalf("ошибка не обёрнута ErrValidation: %v", err)
			}
		})
	}
}
