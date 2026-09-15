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
				{"id":"blk_1","groupId":"g1","type":"short_text","required":true,"settings":{}},
				{"id":"blk_2","groupId":"g2","type":"long_text","settings":{}},
				{"id":"blk_3","groupId":"g3","type":"email","required":true,"settings":{}},
				{"id":"blk_4","groupId":"g4","type":"number","settings":{}},
				{"id":"blk_8","groupId":"g5","type":"phone","settings":{}},
				{"id":"blk_9","groupId":"g6","type":"scale","settings":{"scaleMin":1,"scaleMax":5}},
				{"id":"blk_10","groupId":"g7","type":"dropdown","settings":{"options":[{"id":"o1","label":"Мск"}]}},
				{"id":"blk_5","groupId":"g8","type":"date","settings":{}},
				{"id":"blk_6","groupId":"g9","type":"single_choice","settings":{"options":[{"id":"o1","label":"Друзья"},{"id":"o2","label":"Поиск"}]}},
				{"id":"blk_7","groupId":"g10","type":"multi_choice","settings":{"options":[{"id":"o1","label":"Go"}]}},
				{"id":"blk_11","groupId":"g11","type":"consent","text":[{"t":"Соглашаюсь"}],"required":true,"settings":{}}
			]
		}`,
		"неотвечаемый text-блок":            `{"blocks":[{"id":"b","groupId":"g1","type":"text","text":[{"t":"Раздел А"}],"settings":{}}]}`,
		"картинка с imageKey":               `{"blocks":[{"id":"b","groupId":"g1","type":"image","settings":{"imageKey":"ws/deadbeef.png"}}]}`,
		"картинка без ключа — черновик":     `{"blocks":[{"id":"b","groupId":"g1","type":"image","settings":{}}]}`,
		"submitLabel задан":                 `{"blocks":[],"submitLabel":"Готово"}`,
		"thankYouText задан":                `{"blocks":[],"thankYouText":"Ждём вас на встрече!"}`,
		"redirectUrl https":                 `{"blocks":[],"redirectUrl":"https://example.com/thanks"}`,
		"redirectUrl http с портом и query": `{"blocks":[],"redirectUrl":"http://example.com:8080/ok?from=form"}`,
		"оба поля экрана заданы":            `{"blocks":[],"thankYouText":"Спасибо!","redirectUrl":"https://example.com"}`,
		"placeholder у текстового поля":     `{"blocks":[{"id":"b","groupId":"g1","type":"short_text","settings":{"placeholder":"Например, Иван"}}]}`,
		// Настройки страницы у разрыва (2026-08-21). Зеркало «формSchema — валидные» на
		// фронте. Условия действия флага thankYou кросс-блочны и потому не проверяются
		// схемой ни на одной стороне: флаг инертен, а не невалиден.
		"имя страницы у разрыва":     `{"blocks":[{"id":"b","groupId":"g1","type":"short_text","settings":{}},{"id":"pb","groupId":"g2","type":"page_break","settings":{"pageName":"Контакты"}}]}`,
		"имя страницы ровно в лимит": `{"blocks":[{"id":"pb","groupId":"g1","type":"page_break","settings":{"pageName":"` + strings.Repeat("я", MaxPageNameLen) + `"}}]}`,
		// Текст кнопки «Далее» — настройка того же разрыва, что и имя страницы, но про
		// ДРУГУЮ сторону: имя открывает страницу за разрывом, кнопка закрывает страницу
		// перед ним.
		"текст «Далее» у разрыва":     `{"blocks":[{"id":"b","groupId":"g1","type":"short_text","settings":{}},{"id":"pb","groupId":"g2","type":"page_break","settings":{"nextLabel":"Продолжить"}}]}`,
		"текст «Далее» ровно в лимит": `{"blocks":[{"id":"pb","groupId":"g1","type":"page_break","settings":{"nextLabel":"` + strings.Repeat("я", MaxSubmitLabelLen) + `"}}]}`,
		"флаг страницы «Спасибо» у разрыва": `{"blocks":[
			{"id":"b","groupId":"g1","type":"short_text","settings":{}},
			{"id":"pb","groupId":"g2","type":"page_break","settings":{"thankYou":true}},
			{"id":"h","groupId":"g3","type":"heading","text":[{"t":"Спасибо!"}]}
		]}`,
		"инертный флаг «Спасибо» на разрыве в конце": `{"blocks":[{"id":"b","groupId":"g1","type":"short_text","settings":{}},{"id":"pb","groupId":"g2","type":"page_break","settings":{"thankYou":true}}]}`,
		"вопрос на странице «Спасибо» — флаг инертен, документ валиден": `{"blocks":[
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}},
			{"id":"pb","groupId":"g2","type":"page_break","settings":{"thankYou":true}},
			{"id":"b2","groupId":"g3","type":"email","settings":{}}
		]}`,
		"пустое имя страницы у не-разрыва":  `{"blocks":[{"id":"b","groupId":"g1","type":"short_text","settings":{"pageName":""}}]}`,
		"пустой текст «Далее» у не-разрыва": `{"blocks":[{"id":"b","groupId":"g1","type":"short_text","settings":{"nextLabel":""}}]}`,
		"thankYou false у не-разрыва":       `{"blocks":[{"id":"b","groupId":"g1","type":"short_text","settings":{"thankYou":false}}]}`,
		// Доли колонок (2026-08-22): ряд с ними валиден, и НЕСХОДЯЩИЙСЯ ряд тоже —
		// сумма кросс-блочна, её считает раскладчик фронта, а не схема.
		"доли колонок сходятся":                `{"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":1,"columnWidth":70}},{"id":"b2","groupId":"g2","type":"email","settings":{"column":2,"columnWidth":30}}]}`,
		"доли колонок не сходятся":             `{"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":1,"columnWidth":70}},{"id":"b2","groupId":"g2","type":"email","settings":{"column":2,"columnWidth":70}}]}`,
		"доля колонки у варианта":              `{"blocks":[{"id":"b","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да","column":1,"columnWidth":60},{"id":"o2","label":"Нет","column":2,"columnWidth":40}]}}]}`,
		"choice без опций — валидный черновик": `{"blocks":[{"id":"b","groupId":"g1","type":"single_choice","settings":{}}]}`,
		"файл без настроек — дефолты":          `{"blocks":[{"id":"b","groupId":"g1","type":"file","settings":{}}]}`,
		"файл с настройками":                   `{"blocks":[{"id":"b","groupId":"g1","type":"file","settings":{"maxFiles":3,"maxFileSize":5,"accept":["document","table"]}}]}`,
		"пустая подпись — валидный черновик":   `{"blocks":[{"id":"b","groupId":"g1","type":"title","text":[]}]}`,
		"settings опущен":                      `{"blocks":[{"id":"b","groupId":"g1","type":"short_text"}]}`,
		// Имя вопроса (фаза 16, этап 16.4) — необязательное переопределение у отвечаемого.
		"имя у отвечаемого блока":    `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","name":"fio","settings":{}}]}`,
		"имя ровно в лимит":          `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","name":"` + strings.Repeat("я", MaxQuestionNameLen) + `","settings":{}}]}`,
		"пустое имя = имя не задано": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"title","text":[{"t":"Вопрос"}],"name":""}]}`,
		// v2: вопрос как группа блоков (фаза 8.7).
		"группа title+поле":       `{"schemaVersion":1,"blocks":[{"id":"t1","groupId":"g1","type":"title","text":[{"t":"Имя"}]},{"id":"b1","groupId":"g1","type":"short_text","settings":{}}]}`,
		"голое поле без подписи":  `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"email","settings":{"placeholder":"you@ex.com"}}]}`,
		"consent несёт свой text": `{"schemaVersion":1,"blocks":[{"id":"c1","groupId":"g1","type":"consent","text":[{"t":"Соглашаюсь"}],"required":true,"settings":{}}]}`,
		"контент между подписью и полем": `{"schemaVersion":1,"blocks":[
			{"id":"l1","groupId":"g1","type":"label","text":[{"t":"Логотип"}]},
			{"id":"im","groupId":"g1","type":"image","settings":{"imageKey":"ws/x.png"}},
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}}
		]}`,
		"секционный heading своей группой": `{"schemaVersion":1,"blocks":[{"id":"h1","groupId":"g1","type":"heading","text":[{"t":"О компании"}]},{"id":"b1","groupId":"g2","type":"short_text","settings":{}}]}`,
		// Три уровня заголовка (2026-08-22) — три типа, различающиеся только видом.
		"заголовки второго и третьего уровня": `{"schemaVersion":1,"blocks":[{"id":"h2","groupId":"g1","type":"heading_2","text":[{"t":"Подраздел"}]},{"id":"h3","groupId":"g2","type":"heading_3","text":[{"t":"Пункт"}]}]}`,
		// Фаза 13.6: бит ряда у whitelist-типов и у вариантов.
		"column right у short_text": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":2}}]}`,
		"column right у dropdown":   `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"dropdown","settings":{"column":2,"options":[{"id":"o1","label":"Мск"}]}}]}`,
		"column right у варианта":   `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да"},{"id":"o2","label":"Нет","column":2}]}}]}`,
		// Инертный флаг легален (спека §5): левого соседа нет, но 422 быть не должно —
		// иначе undo и промежуточные состояния драга ловили бы отказ автосейва.
		"column right у первого блока — инертен, но валиден": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"email","settings":{"column":2}},{"id":"b2","groupId":"g2","type":"long_text","settings":{}}]}`,
		"column right у первого варианта — инертен":          `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"multi_choice","settings":{"options":[{"id":"o1","label":"Go","column":2}]}}]}`,
		// Подпись — законный носитель бита: на первом блоке группы он ставит в колонку
		// вопрос целиком.
		"column right у подписи — кросс-групповой носитель": `{"schemaVersion":1,"blocks":[
			{"id":"t1","groupId":"g1","type":"title","text":[{"t":"Город"}]},
			{"id":"f1","groupId":"g1","type":"short_text","settings":{}},
			{"id":"t2","groupId":"g2","type":"title","text":[{"t":"Индекс"}],"settings":{"column":2}},
			{"id":"f2","groupId":"g2","type":"short_text","settings":{}}
		]}`,
		// Бит на поле ВНУТРИ группы валиден поблочно (кросс-блочное условие не проверяется):
		// так лежат документы, собранные до ADR §10 2026-09-14, — редактор читает их секцией.
		"column у поля внутри группы — валиден поблочно": `{"schemaVersion":1,"blocks":[
			{"id":"t","groupId":"g1","type":"label","text":[{"t":"Индекс"}]},
			{"id":"f","groupId":"g1","type":"short_text","settings":{"column":2}}
		]}`,
		// Двухколоночная секция (спека §11, решение владельца 2026-07-29): у ключа два
		// значения. Явная форма — канон, неявная (левый элемент без ключа) остаётся
		// читаемой: так выглядят формы, собранные до этапа.
		"column left у обоих участников левой колонки": `{"schemaVersion":1,"blocks":[
			{"id":"l1","groupId":"g1","type":"short_text","settings":{"column":1}},
			{"id":"l2","groupId":"g2","type":"email","settings":{"column":1}},
			{"id":"r1","groupId":"g3","type":"phone","settings":{"column":2}}
		]}`,
		"column left у подписи":  `{"schemaVersion":1,"blocks":[{"id":"t","groupId":"g1","type":"title","text":[{"t":"Город"}],"settings":{"column":1}}]}`,
		"column left у варианта": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да","column":1},{"id":"o2","label":"Нет","column":2}]}}]}`,
		// Whitelist коротких контролов отменён (2026-07-29): бит законен у любого типа,
		// включая длинный ответ, выбор и лэйаут-блоки. Что читается в половину колонки —
		// решает автор формы, а не схема.
		"column right у long_text":     `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"long_text","settings":{"column":2}}]}`,
		"column right у single_choice": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"column":2}}]}`,
		"column right у контентного text": `{"schemaVersion":1,"blocks":[
			{"id":"b1","groupId":"g1","type":"text","text":[{"t":"абзац"}],"settings":{"column":2}}
		]}`,
		// Фаза 15: заголовок формы — блок документа (спека §3.2).
		"form_title первой строкой": `{"schemaVersion":1,"blocks":[
			{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}]},
			{"id":"t1","groupId":"g1","type":"title","text":[{"t":"Имя"}]},
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}}
		]}`,
		"form_title с разметкой":            `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета ","m":["b"]},{"t":"2026","color":"#c026d3"}]}]}`,
		"form_title пустой — черновик":      `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[]}]}`,
		"схема без form_title — как раньше": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{}}]}`,
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
		manyBlocks[i] = `{"id":"b` + strconv.Itoa(i) + `","groupId":"g_b` + strconv.Itoa(i) + `","type":"short_text","settings":{}}`
	}
	tooManyBlocks := `{"blocks":[` + strings.Join(manyBlocks, ",") + `]}`

	manyOpts := make([]string, MaxOptions+1)
	for i := range manyOpts {
		manyOpts[i] = `{"id":"o` + strconv.Itoa(i) + `","label":"x"}`
	}
	tooManyOpts := `{"blocks":[{"id":"b","groupId":"g_b","type":"single_choice","settings":{"options":[` +
		strings.Join(manyOpts, ",") + `]}}]}`

	longLabel := `{"blocks":[{"id":"b","groupId":"g_b","type":"title","text":[{"t":"` +
		strings.Repeat("я", MaxTextLen+1) + `"}]}]}`
	longSubmit := `{"blocks":[],"submitLabel":"` + strings.Repeat("я", MaxSubmitLabelLen+1) + `"}`
	longPlaceholder := `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{"placeholder":"` +
		strings.Repeat("я", MaxPlaceholderLen+1) + `"}}]}`
	longImageKey := `{"blocks":[{"id":"b","groupId":"g_b","type":"image","settings":{"imageKey":"` +
		strings.Repeat("a", MaxImageKeyLen+1) + `"}}]}`
	longName := `{"schemaVersion":1,"blocks":[{"id":"b","groupId":"g1","type":"short_text","name":"` +
		strings.Repeat("я", MaxQuestionNameLen+1) + `","settings":{}}]}`
	longPageName := `{"blocks":[{"id":"pb","groupId":"g1","type":"page_break","settings":{"pageName":"` +
		strings.Repeat("я", MaxPageNameLen+1) + `"}}]}`
	longNextLabel := `{"blocks":[{"id":"pb","groupId":"g1","type":"page_break","settings":{"nextLabel":"` +
		strings.Repeat("я", MaxSubmitLabelLen+1) + `"}}]}`
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
		"слишком длинное имя вопроса":  longName,
		// Имя называет колонку CSV и шаг воронки — у неотвечаемого называть нечего.
		"имя у подписи":               `{"schemaVersion":1,"blocks":[{"id":"t","groupId":"g1","type":"title","text":[{"t":"Вопрос"}],"name":"q1"}]}`,
		"имя у контента":              `{"schemaVersion":1,"blocks":[{"id":"p","groupId":"g1","type":"text","text":[{"t":"Пояснение"}],"name":"q1"}]}`,
		"битый JSON":                  `{"blocks":`,
		"хвост после документа":       `{"blocks":[]}{}`,
		"неизвестная schemaVersion":   `{"schemaVersion":99,"blocks":[]}`,
		"лишнее поле верхнего уровня": `{"blocks":[],"extra":1}`,
		"лишнее поле блока":           `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{},"foo":1}]}`,
		"лишнее поле в settings":      `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{"foo":1}}]}`,
		"неизвестный тип блока":       `{"blocks":[{"id":"b","groupId":"g_b","type":"slider","settings":{}}]}`,
		"пустой id блока":             `{"blocks":[{"id":"","type":"short_text","settings":{}}]}`,
		"дубль id блоков":             `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{}},{"id":"b","groupId":"g_b","type":"email","settings":{}}]}`,
		"non-choice с опциями":        `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{"options":[{"id":"o","label":"z"}]}}]}`,
		"imageKey на не-image":        `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{"imageKey":"ws/x.png"}}]}`,
		// Настройки страницы принадлежат разрыву (2026-08-21): на чужом типе они
		// бессмысленны и отвергаются, как imageKey у не-картинки.
		"имя страницы на не-разрыве":    `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{"pageName":"Контакты"}}]}`,
		"флаг «Спасибо» на не-разрыве":  `{"blocks":[{"id":"b","groupId":"g_b","type":"heading","text":[{"t":"x"}],"settings":{"thankYou":true}}]}`,
		"слишком длинное имя страницы":  longPageName,
		"текст «Далее» на не-разрыве":   `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{"nextLabel":"Продолжить"}}]}`,
		"слишком длинный текст «Далее»": longNextLabel,
		// alt удалён из контракта целиком (фаза 13): отвергается даже у image.
		"alt удалён из контракта":       `{"blocks":[{"id":"b","groupId":"g_b","type":"image","settings":{"imageKey":"ws/x.png","alt":"y"}}]}`,
		"image с опциями":               `{"blocks":[{"id":"b","groupId":"g_b","type":"image","settings":{"options":[{"id":"o","label":"z"}]}}]}`,
		"слишком длинный imageKey":      longImageKey,
		"дубль id опций внутри блока":   `{"blocks":[{"id":"b","groupId":"g_b","type":"single_choice","settings":{"options":[{"id":"o","label":"a"},{"id":"o","label":"b"}]}}]}`,
		"пустой id опции":               `{"blocks":[{"id":"b","groupId":"g_b","type":"single_choice","settings":{"options":[{"id":"","label":"a"}]}}]}`,
		"слишком много блоков":          tooManyBlocks,
		"слишком много опций":           tooManyOpts,
		"слишком длинный текст подписи": longLabel,
		// v2: правила групп и собственного текста (фаза 8.7).
		"text у отвечаемого не-consent": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","text":[{"t":"нельзя"}],"settings":{}}]}`,
		"text у image":   `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"image","text":[{"t":"нельзя"}],"settings":{}}]}`,
		"пустой groupId": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"","type":"short_text","settings":{}}]}`,
		"группа разорвана чужим блоком":              `{"schemaVersion":1,"blocks":[{"id":"a","groupId":"g1","type":"title","text":[{"t":"A"}]},{"id":"b","groupId":"g2","type":"short_text","settings":{}},{"id":"c","groupId":"g1","type":"email","settings":{}}]}`,
		"два отвечаемых в одной группе":              `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{}},{"id":"b2","groupId":"g1","type":"email","settings":{}}]}`,
		"column строкой (формат до номеров колонок)": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":"right"}}]}`,
		// Единственный тип вне рядов (решение владельца 2026-07-29, отменившее whitelist
		// фазы 13.6): заголовок формы. Исключён по устройству, а не по виду — он
		// рисуется вне потока вопросов, и соседей по ряду у него не бывает.
		"column у form_title": `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}],"settings":{"column":2}}]}`,
		// Потолок колонок — единственное, что валидатор о ряде знает: где элемент
		// окажется, решает раскладчик, а сколько колонок бывает — контракт.
		"column выше потолка":          `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":` + strconv.Itoa(MaxColumns+1) + `}}]}`,
		"column отрицательный":         `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":-1}}]}`,
		"column варианта выше потолка": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да","column":` + strconv.Itoa(MaxColumns+1) + `}]}}]}`,
		// Доля колонки (2026-08-22): диапазон и запрет у типа вне рядов — всё, что
		// валидатор о ширине знает. Сходимость суммы по ряду кросс-блочна и намеренно
		// не проверяется, как «секция открыта» у самой колонки.
		"columnWidth выше потолка":          `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"columnWidth":` + strconv.Itoa(ColumnWidthTotal+1) + `}}]}`,
		"columnWidth отрицательный":         `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"columnWidth":-1}}]}`,
		"columnWidth у form_title":          `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}],"settings":{"columnWidth":50}}]}`,
		"columnWidth варианта выше потолка": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да","columnWidth":` + strconv.Itoa(ColumnWidthTotal+1) + `}]}}]}`,
		// Фаза 24: настройки файла. Потолки — предел АВТОРА: подпись загрузки сверх них
		// не выдаётся, поэтому настройка, которую нельзя исполнить, обязана краснеть в
		// редакторе, а не тихо не работать у респондента.
		"maxFiles выше потолка":         `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"file","settings":{"maxFiles":` + strconv.Itoa(MaxFilesUpperBound+1) + `}}]}`,
		"maxFiles отрицательный":        `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"file","settings":{"maxFiles":-1}}]}`,
		"maxFileSize выше потолка":      `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"file","settings":{"maxFileSize":` + strconv.Itoa(MaxFileSizeUpperBoundMiB+1) + `}}]}`,
		"неизвестное семейство":         `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"file","settings":{"accept":["binary"]}}]}`,
		"повтор семейства":              `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"file","settings":{"accept":["image","image"]}}]}`,
		"настройки файла на чужом типе": `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"maxFiles":2}}]}`,
		// Фаза 15: инварианты заголовка формы (спека §3.2).
		"два form_title": `{"schemaVersion":1,"blocks":[
			{"id":"f1","groupId":"g1","type":"form_title","text":[{"t":"А"}]},
			{"id":"f2","groupId":"g2","type":"form_title","text":[{"t":"Б"}]}
		]}`,
		"form_title не первым блоком": `{"schemaVersion":1,"blocks":[
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}},
			{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}]}
		]}`,
		"form_title в группе вопроса": `{"schemaVersion":1,"blocks":[
			{"id":"ft","groupId":"g1","type":"form_title","text":[{"t":"Анкета"}]},
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}}
		]}`,
		"слишком длинный заголовок формы": `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"` +
			strings.Repeat("я", MaxFormTitleLen+1) + `"}]}]}`,
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
		"диапазон 1–5":                   `{"blocks":[{"id":"s","groupId":"g1","type":"scale","settings":{"scaleMin":1,"scaleMax":5}}]}`,
		"NPS 0–10 (ноль не теряется)":    `{"blocks":[{"id":"s","groupId":"g1","type":"scale","settings":{"scaleMin":0,"scaleMax":10}}]}`,
		"шкала без диапазона — черновик": `{"blocks":[{"id":"s","groupId":"g1","type":"scale","settings":{}}]}`,
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
		"min больше max":          `{"blocks":[{"id":"s","groupId":"g_s","type":"scale","settings":{"scaleMin":5,"scaleMax":2}}]}`,
		"min равен max":           `{"blocks":[{"id":"s","groupId":"g_s","type":"scale","settings":{"scaleMin":3,"scaleMax":3}}]}`,
		"max выше потолка":        `{"blocks":[{"id":"s","groupId":"g_s","type":"scale","settings":{"scaleMin":1,"scaleMax":11}}]}`,
		"min ниже нуля":           `{"blocks":[{"id":"s","groupId":"g_s","type":"scale","settings":{"scaleMin":-1,"scaleMax":5}}]}`,
		"задан только один конец": `{"blocks":[{"id":"s","groupId":"g_s","type":"scale","settings":{"scaleMax":5}}]}`,
		"шкала у не-scale":        `{"blocks":[{"id":"b","groupId":"g_b","type":"short_text","settings":{"scaleMin":1,"scaleMax":5}}]}`,
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

// --- Заголовок формы (фаза 15) ---

// FormTitle различает «блока нет» и «блок пуст». Это не мелочь: от ответа зависит,
// звать ли колонку forms.title. Спутать их значит вернуть респонденту служебное
// «Untitled form» у формы, где автор заголовок стёр намеренно.
func TestFormTitle_AbsentVsEmpty(t *testing.T) {
	cases := map[string]struct {
		raw       string
		wantText  string
		wantSpoke bool
	}{
		"блока нет — документ не высказался": {
			raw: `{"schemaVersion":1,"blocks":[{"id":"b","groupId":"g","type":"short_text","settings":{}}]}`,
		},
		"блок пуст — документ высказался пустотой": {
			raw:       `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[]}]}`,
			wantSpoke: true,
		},
		"блок с текстом": {
			raw:       `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}]}]}`,
			wantText:  "Анкета",
			wantSpoke: true,
		},
		"разметка в плоский текст": {
			raw:       `{"schemaVersion":1,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета ","m":["b"]},{"t":"2026"}]}]}`,
			wantText:  "Анкета 2026",
			wantSpoke: true,
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			s, err := ValidateSchema(json.RawMessage(tc.raw))
			if err != nil {
				t.Fatalf("схема не прошла: %v", err)
			}
			text, spoke := FormTitle(s)
			if text != tc.wantText || spoke != tc.wantSpoke {
				t.Fatalf("FormTitle = (%q, %v), ждали (%q, %v)", text, spoke, tc.wantText, tc.wantSpoke)
			}
		})
	}
}

// Синтез заголовка из колонки: блок дописывается ПЕРВЫМ, с детерминированным id.
// Случайный id означал бы новый блок на каждый заход в билдер — лишний дифф
// автосейва и лишний PATCH на пустом месте.
func TestEnsureFormTitle_SynthesizesDeterministically(t *testing.T) {
	raw := `{"schemaVersion":1,"blocks":[{"id":"b","groupId":"g","type":"short_text","settings":{}}]}`
	s, err := ValidateSchema(json.RawMessage(raw))
	if err != nil {
		t.Fatalf("схема не прошла: %v", err)
	}
	out := EnsureFormTitle(s, "Анкета", "form-1")
	if len(out.Blocks) != 2 {
		t.Fatalf("ждали 2 блока, получили %d", len(out.Blocks))
	}
	ft := out.Blocks[0]
	if ft.Type != BlockFormTitle || ft.ID != "ft_form-1" || ft.GroupID != "g_ft_form-1" {
		t.Fatalf("блок заголовка собран неверно: %+v", ft)
	}
	if PlainText(ft.Text) != "Анкета" {
		t.Fatalf("текст заголовка = %q", PlainText(ft.Text))
	}
	// Синтезированный документ обязан быть валидным — иначе первый же автосейв
	// вернул бы 422 на то, что дописал сам сервер.
	js, err := json.Marshal(out)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if _, err := ValidateSchema(js); err != nil {
		t.Fatalf("синтезированная схема невалидна: %v", err)
	}
	// Повторный вызов ничего не добавляет: документ уже высказался.
	if again := EnsureFormTitle(out, "Другое", "form-1"); len(again.Blocks) != 2 || PlainText(again.Blocks[0].Text) != "Анкета" {
		t.Fatalf("повторный синтез переписал документ: %+v", again.Blocks)
	}
}

// Пустое название колонки даёт блок с пустым текстом — законное состояние
// черновика, а не «заголовка нет»: дальше документ уже говорит сам за себя.
func TestEnsureFormTitle_EmptyTitleGivesEmptyBlock(t *testing.T) {
	s, _ := ValidateSchema(json.RawMessage(`{"schemaVersion":1,"blocks":[]}`))
	out := EnsureFormTitle(s, "", "form-1")
	if len(out.Blocks) != 1 || len(out.Blocks[0].Text) != 0 {
		t.Fatalf("ждали один блок с пустым текстом, получили %+v", out.Blocks)
	}
	if _, spoke := FormTitle(out); !spoke {
		t.Fatal("после синтеза документ обязан считаться высказавшимся")
	}
}

// Потолок блоков считает блоки АВТОРА: форма, собранная ровно на потолке до фазы 15,
// после синтеза заголовка получает 201 блок — и обязана остаться валидной. Иначе
// автор открывает её, а автосейв молча отвечает 422 на документ, который сервер
// дописал сам.
func TestValidateSchema_FormTitleDoesNotCountAgainstMaxBlocks(t *testing.T) {
	blocks := make([]string, 0, MaxBlocks+1)
	blocks = append(blocks, `{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}]}`)
	for i := 0; i < MaxBlocks; i++ {
		blocks = append(blocks, `{"id":"b`+strconv.Itoa(i)+`","groupId":"g`+strconv.Itoa(i)+`","type":"short_text","settings":{}}`)
	}
	raw := `{"schemaVersion":1,"blocks":[` + strings.Join(blocks, ",") + `]}`
	if _, err := ValidateSchema(json.RawMessage(raw)); err != nil {
		t.Fatalf("потолок + заголовок должны проходить: %v", err)
	}
	// Но потолок остаётся потолком: 201 блок автора отвергается и с заголовком.
	blocks = append(blocks, `{"id":"bx","groupId":"gx","type":"short_text","settings":{}}`)
	raw = `{"schemaVersion":1,"blocks":[` + strings.Join(blocks, ",") + `]}`
	if _, err := ValidateSchema(json.RawMessage(raw)); err == nil {
		t.Fatal("201 блок автора должен отвергаться")
	}
}

// --- Оформление страницы: обложка и логотип ---

// Зеркало describe('обложка и логотип') в web/app/src/entities/formSchema.test.ts.
func TestValidateSchema_CoverAndLogo(t *testing.T) {
	longKey := strings.Repeat("a", MaxImageKeyLen+1)

	valid := map[string]string{
		"обложки нет вовсе":       `{"schemaVersion":1,"blocks":[]}`,
		"обложка цветом":          `{"schemaVersion":1,"blocks":[],"cover":{"color":"#ff8800"}}`,
		"обложка картинкой":       `{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/deadbeef.jpg"}}`,
		"обложка со сдвигом":      `{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/x.jpg","y":20}}`,
		"сдвиг у верхней границы": `{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/x.jpg","y":100}}`,
		"дробный сдвиг":           `{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/x.jpg","y":12.35}}`,
		"логотип":                 `{"schemaVersion":1,"blocks":[],"logo":{"imageKey":"ws/logo.png"}}`,
		"логотип с размером": `{"schemaVersion":1,"blocks":[],` +
			`"logo":{"imageKey":"ws/logo.png","width":140,"height":80,"radius":0}}`,
		"логотип у границ размера": `{"schemaVersion":1,"blocks":[],` +
			`"logo":{"imageKey":"ws/logo.png","width":24,"height":240,"radius":120}}`,
		"высота обложки":            `{"schemaVersion":1,"blocks":[],"cover":{"color":"#ff8800","height":40}}`,
		"высота обложки у картинки": `{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/x.jpg","height":5}}`,
		"обложка и логотип вместе": `{"schemaVersion":1,"blocks":[],` +
			`"cover":{"imageKey":"ws/x.jpg","y":0},"logo":{"imageKey":"ws/logo.png"}}`,
	}
	for name, raw := range valid {
		t.Run("валидна: "+name, func(t *testing.T) {
			if _, err := ValidateSchema(json.RawMessage(raw)); err != nil {
				t.Fatalf("ожидалась валидная схема: %v", err)
			}
		})
	}

	invalid := map[string]string{
		"обложка пуста":            `{"schemaVersion":1,"blocks":[],"cover":{}}`,
		"цвет и картинка разом":    `{"schemaVersion":1,"blocks":[],"cover":{"color":"#ffffff","imageKey":"ws/x.jpg"}}`,
		"цвет не hex":              `{"schemaVersion":1,"blocks":[],"cover":{"color":"red"}}`,
		"цвет в верхнем регистре":  `{"schemaVersion":1,"blocks":[],"cover":{"color":"#FF8800"}}`,
		"цвет со свободным CSS":    `{"schemaVersion":1,"blocks":[],"cover":{"color":"url(javascript:alert(1))"}}`,
		"сдвиг без картинки":       `{"schemaVersion":1,"blocks":[],"cover":{"color":"#ff8800","y":30}}`,
		"сдвиг выше потолка":       `{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/x.jpg","y":101}}`,
		"сдвиг ниже нуля":          `{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/x.jpg","y":-1}}`,
		"слишком длинный ключ":     `{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"` + longKey + `"}}`,
		"лишний ключ у обложки":    `{"schemaVersion":1,"blocks":[],"cover":{"color":"#ff8800","x":10}}`,
		"логотип с пустым ключом":  `{"schemaVersion":1,"blocks":[],"logo":{"imageKey":""}}`,
		"логотип с длинным ключом": `{"schemaVersion":1,"blocks":[],"logo":{"imageKey":"` + longKey + `"}}`,
		"логотип без ключа":        `{"schemaVersion":1,"blocks":[],"logo":{}}`,
		"логотип уже минимума": `{"schemaVersion":1,"blocks":[],` +
			`"logo":{"imageKey":"ws/logo.png","width":23}}`,
		"логотип выше потолка": `{"schemaVersion":1,"blocks":[],` +
			`"logo":{"imageKey":"ws/logo.png","height":241}}`,
		"скругление логотипа выше потолка": `{"schemaVersion":1,"blocks":[],` +
			`"logo":{"imageKey":"ws/logo.png","radius":121}}`,
		"отрицательное скругление логотипа": `{"schemaVersion":1,"blocks":[],` +
			`"logo":{"imageKey":"ws/logo.png","radius":-1}}`,
		"высота обложки ниже минимума": `{"schemaVersion":1,"blocks":[],"cover":{"color":"#ff8800","height":4}}`,
		"высота обложки выше потолка":  `{"schemaVersion":1,"blocks":[],"cover":{"color":"#ff8800","height":76}}`,
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

// Ноль сдвига обязан пережить разбор: «нет ключа» = центр, y:0 = прижата верхом, и
// перепутать их значит незаметно сдвигать чужие обложки на середину.
func TestValidateSchema_CoverYZeroSurvives(t *testing.T) {
	s, err := ValidateSchema(json.RawMessage(`{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/x.jpg","y":0}}`))
	if err != nil {
		t.Fatalf("схема должна быть валидной: %v", err)
	}
	if s.Cover == nil || s.Cover.Y == nil {
		t.Fatal("y:0 потерян при разборе")
	}
	if got := s.Cover.CoverY(); got != 0 {
		t.Fatalf("CoverY() = %v, ожидалось 0", got)
	}

	s, err = ValidateSchema(json.RawMessage(`{"schemaVersion":1,"blocks":[],"cover":{"imageKey":"ws/x.jpg"}}`))
	if err != nil {
		t.Fatalf("схема должна быть валидной: %v", err)
	}
	if got := s.Cover.CoverY(); got != DefaultCoverY {
		t.Fatalf("CoverY() без ключа = %v, ожидалось %v", got, DefaultCoverY)
	}
}

// Разрыв страницы (фаза 19). Go про страницы не знает: разбиение выводит раскладчик
// фронта, а сюда разрыв приезжает обычным неотвечаемым блоком. Проверяем ровно то, что
// от контракта требуется, — что он принимается и что правила контента к нему применены.
func TestValidateSchema_PageBreak(t *testing.T) {
	valid := map[string]string{
		"разрыв между вопросами": `{"schemaVersion":1,"blocks":[
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}},
			{"id":"p1","groupId":"gp","type":"page_break"},
			{"id":"b2","groupId":"g2","type":"email","settings":{}}
		]}`,
		// Вырожденные раскладки — законные промежуточные состояния набора и драга:
		// схема их принимает, пустую страницу выкидывает раскладчик (splitPages).
		"разрыв первым блоком": `{"schemaVersion":1,"blocks":[{"id":"p1","groupId":"gp","type":"page_break"},{"id":"b1","groupId":"g1","type":"email","settings":{}}]}`,
		"два разрыва подряд":   `{"schemaVersion":1,"blocks":[{"id":"p1","groupId":"gp1","type":"page_break"},{"id":"p2","groupId":"gp2","type":"page_break"}]}`,
		"разрыв последним":     `{"schemaVersion":1,"blocks":[{"id":"b1","groupId":"g1","type":"email","settings":{}},{"id":"p1","groupId":"gp","type":"page_break"}]}`,
		"разрыв в форме с v1":  `{"schemaVersion":1,"blocks":[{"id":"p1","groupId":"gp","type":"page_break"}]}`,
	}
	for name, raw := range valid {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateSchema(json.RawMessage(raw)); err != nil {
				t.Fatalf("схема отвергнута: %v", err)
			}
		})
	}

	invalid := map[string]string{
		// Ряд делить не может — как и заголовок формы: разрыв граница раскладки, а не
		// её элемент.
		"разрыв с битом ряда": `{"schemaVersion":1,"blocks":[
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}},
			{"id":"p1","groupId":"gp","type":"page_break","settings":{"column":2}}
		]}`,
		// Своего текста не несёт: название страницы — отдельный heading, а не второе
		// место, где у формы заводится текст.
		"разрыв с текстом": `{"schemaVersion":1,"blocks":[{"id":"p1","groupId":"gp","type":"page_break","text":[{"t":"Страница 2"}]}]}`,
		// Имя вопроса — только у отвечаемых: у разрыва нет ни колонки CSV, ни шага воронки.
		"разрыв с именем вопроса": `{"schemaVersion":1,"blocks":[{"id":"p1","groupId":"gp","type":"page_break","name":"page2"}]}`,
	}
	for name, raw := range invalid {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateSchema(json.RawMessage(raw)); err == nil {
				t.Fatal("схема принята, ждали ошибку")
			}
		})
	}
}

// Форма с записью обязана иметь ОБЯЗАТЕЛЬНЫЙ вопрос о почте: без адреса письмо о
// записи молча не уходит, а с ним не уходит и ссылка отмены (отчёт владельца
// 2026-09-04). Проверка живёт отдельной функцией, потому что спрашивают её двое —
// гейт публикации и предупреждение на полотне.
func TestSlotNeedsEmail(t *testing.T) {
	parse := func(t *testing.T, raw string) FormSchema {
		t.Helper()
		s, err := ValidateSchema(json.RawMessage(raw))
		if err != nil {
			t.Fatalf("схема не разобралась: %v", err)
		}
		return s
	}

	cases := []struct {
		name   string
		schema string
		needs  bool
	}{
		{"без записи почта не нужна", `{"blocks":[{"id":"q1","groupId":"g1","type":"short_text","settings":{}}]}`, false},
		{"запись без почты", `{"blocks":[{"id":"s1","groupId":"g1","type":"slot","settings":{}}]}`, true},
		{"запись и необязательная почта", `{"blocks":[
			{"id":"s1","groupId":"g1","type":"slot","settings":{}},
			{"id":"e1","groupId":"g2","type":"email","settings":{}}
		]}`, true},
		{"запись и обязательная почта", `{"blocks":[
			{"id":"s1","groupId":"g1","type":"slot","settings":{}},
			{"id":"e1","groupId":"g2","type":"email","required":true,"settings":{}}
		]}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := SlotNeedsEmail(parse(t, c.schema)); got != c.needs {
				t.Fatalf("SlotNeedsEmail = %v, ожидалось %v", got, c.needs)
			}
		})
	}
}

// Вопрос о записи в форме один: одна отправка — одна бронь (фаза 27,
// design/booking.md §4.3).
func TestValidateSchema_SlotOnlyOne(t *testing.T) {
	one := `{"blocks":[{"id":"s1","groupId":"g1","type":"slot","settings":{}}]}`
	if _, err := ValidateSchema(json.RawMessage(one)); err != nil {
		t.Fatalf("один вопрос о записи отвергнут: %v", err)
	}

	two := `{"blocks":[
		{"id":"s1","groupId":"g1","type":"slot","settings":{}},
		{"id":"s2","groupId":"g2","type":"slot","settings":{}}
	]}`
	err := ValidateSchema2(t, two)
	if err == nil {
		t.Fatal("два вопроса о записи приняты, ожидался отказ")
	}
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("ошибка не ErrValidation: %v", err)
	}

	// Расписание схема не хранит и не спрашивает: оно живёт живой колонкой, а
	// незаполненный выбор держит гейт публикации, а не валидатор документа.
	withSettings := `{"blocks":[{"id":"s1","groupId":"g1","type":"slot","settings":{"scheduleId":"x"}}]}`
	if err := ValidateSchema2(t, withSettings); err == nil {
		t.Fatal("настройка расписания в схеме принята — её там быть не должно")
	}
}

// ValidateSchema2 — обёртка ради читаемости таблиц выше: ошибка без второго значения.
func ValidateSchema2(t *testing.T, raw string) error {
	t.Helper()
	_, err := ValidateSchema(json.RawMessage(raw))
	return err
}

// Формат значения у записи на время — два, и валидатор обязан принять оба:
// id брони приезжает от респондента, время записывает сервер.
func TestValidateAnswers_Slot(t *testing.T) {
	schema := FormSchema{Blocks: []Block{
		{ID: "s1", GroupID: "g1", Type: BlockSlot, Required: true},
	}}
	ok := func(name, value string) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			answers := map[string]json.RawMessage{"s1": json.RawMessage(value)}
			if _, err := NormalizeAnswers(schema, answers); err != nil {
				t.Fatalf("значение отвергнуто: %v", err)
			}
		})
	}
	bad := func(name, value string) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			answers := map[string]json.RawMessage{"s1": json.RawMessage(value)}
			if _, err := NormalizeAnswers(schema, answers); err == nil {
				t.Fatal("значение принято, ожидался отказ")
			}
		})
	}
	ok("id брони от респондента", `"01937b1e-7c2a-7c9a-9d3e-4f5a6b7c8d9e"`)
	ok("время, записанное сервером", `"2026-09-11T08:00:00Z"`)
	bad("произвольная строка", `"четверг после обеда"`)
	bad("объект", `{"bookingId":"x"}`)
	bad("пусто при обязательном вопросе", `""`)
}
