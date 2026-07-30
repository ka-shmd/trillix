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
		// Фаза 13.6: бит ряда у whitelist-типов и у вариантов.
		"column right у short_text": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":"right"}}]}`,
		"column right у dropdown":   `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"dropdown","settings":{"column":"right","options":[{"id":"o1","label":"Мск"}]}}]}`,
		"column right у варианта":   `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да"},{"id":"o2","label":"Нет","column":"right"}]}}]}`,
		// Инертный флаг легален (спека §5): левого соседа нет, но 422 быть не должно —
		// иначе undo и промежуточные состояния драга ловили бы отказ автосейва.
		"column right у первого блока — инертен, но валиден": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"email","settings":{"column":"right"}},{"id":"b2","groupId":"g2","type":"long_text","settings":{}}]}`,
		"column right у первого варианта — инертен":          `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"multi_choice","settings":{"options":[{"id":"o1","label":"Go","column":"right"}]}}]}`,
		// Фаза 15 (спека §6.3): подпись — законный носитель бита на обоих уровнях.
		// На первом блоке группы он значит «моя группа справа от предыдущей» (носитель
		// переехал сюда апгрейдом v3→v4), внутри группы — «справа от подписи».
		// Документы даны уже в v4: в v3 такой бит апгрейд бы двигал.
		"column right у подписи — кросс-групповой носитель": `{"schemaVersion":4,"blocks":[
			{"id":"t1","groupId":"g1","type":"title","text":[{"t":"Город"}]},
			{"id":"f1","groupId":"g1","type":"short_text","settings":{}},
			{"id":"t2","groupId":"g2","type":"title","text":[{"t":"Индекс"}],"settings":{"column":"right"}},
			{"id":"f2","groupId":"g2","type":"short_text","settings":{}}
		]}`,
		"column right у label внутри группы — ряд «подпись | поле»": `{"schemaVersion":4,"blocks":[
			{"id":"t","groupId":"g1","type":"label","text":[{"t":"Индекс"}]},
			{"id":"f","groupId":"g1","type":"short_text","settings":{"column":"right"}}
		]}`,
		// Двухколоночная секция (спека §11, решение владельца 2026-07-29): у ключа два
		// значения. Явная форма — канон, неявная (левый элемент без ключа) остаётся
		// читаемой: так выглядят формы, собранные до этапа.
		"column left у обоих участников левой колонки": `{"schemaVersion":4,"blocks":[
			{"id":"l1","groupId":"g1","type":"short_text","settings":{"column":"left"}},
			{"id":"l2","groupId":"g2","type":"email","settings":{"column":"left"}},
			{"id":"r1","groupId":"g3","type":"phone","settings":{"column":"right"}}
		]}`,
		"column left у подписи":  `{"schemaVersion":4,"blocks":[{"id":"t","groupId":"g1","type":"title","text":[{"t":"Город"}],"settings":{"column":"left"}}]}`,
		"column left у варианта": `{"schemaVersion":4,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да","column":"left"},{"id":"o2","label":"Нет","column":"right"}]}}]}`,
		// Whitelist коротких контролов отменён (2026-07-29): бит законен у любого типа,
		// включая длинный ответ, выбор и лэйаут-блоки. Что читается в половину колонки —
		// решает автор формы, а не схема.
		"column right у long_text":     `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"long_text","settings":{"column":"right"}}]}`,
		"column right у single_choice": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"column":"right"}}]}`,
		"column right у контентного text": `{"schemaVersion":4,"blocks":[
			{"id":"b1","groupId":"g1","type":"text","text":[{"t":"абзац"}],"settings":{"column":"right"}}
		]}`,
		// Фаза 15: заголовок формы — блок документа (спека §3.2).
		"form_title первой строкой": `{"schemaVersion":3,"blocks":[
			{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}]},
			{"id":"t1","groupId":"g1","type":"title","text":[{"t":"Имя"}]},
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}}
		]}`,
		"form_title с разметкой":            `{"schemaVersion":3,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета ","m":["b"]},{"t":"2026","color":"#c026d3"}]}]}`,
		"form_title пустой — черновик":      `{"schemaVersion":3,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[]}]}`,
		"схема без form_title — как раньше": `{"schemaVersion":3,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{}}]}`,
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
		"column неизвестное значение":       `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":"third"}}]}`,
		// Единственный тип вне рядов (решение владельца 2026-07-29, отменившее whitelist
		// фазы 13.6): заголовок формы. Исключён по устройству, а не по виду — он
		// рисуется вне потока вопросов, и соседей по ряду у него не бывает.
		"column у form_title":                 `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}],"settings":{"column":"right"}}]}`,
		"column третьего значения":            `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"short_text","settings":{"column":"middle"}}]}`,
		"column у варианта вне двух значений": `{"schemaVersion":2,"blocks":[{"id":"b1","groupId":"g1","type":"single_choice","settings":{"options":[{"id":"o1","label":"Да","column":"center"}]}}]}`,
		// Фаза 15: инварианты заголовка формы (спека §3.2).
		"два form_title": `{"schemaVersion":3,"blocks":[
			{"id":"f1","groupId":"g1","type":"form_title","text":[{"t":"А"}]},
			{"id":"f2","groupId":"g2","type":"form_title","text":[{"t":"Б"}]}
		]}`,
		"form_title не первым блоком": `{"schemaVersion":3,"blocks":[
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}},
			{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}]}
		]}`,
		"form_title в группе вопроса": `{"schemaVersion":3,"blocks":[
			{"id":"ft","groupId":"g1","type":"form_title","text":[{"t":"Анкета"}]},
			{"id":"b1","groupId":"g1","type":"short_text","settings":{}}
		]}`,
		"слишком длинный заголовок формы": `{"schemaVersion":3,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"` +
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
			raw: `{"schemaVersion":4,"blocks":[{"id":"b","groupId":"g","type":"short_text","settings":{}}]}`,
		},
		"блок пуст — документ высказался пустотой": {
			raw:       `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[]}]}`,
			wantSpoke: true,
		},
		"блок с текстом": {
			raw:       `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета"}]}]}`,
			wantText:  "Анкета",
			wantSpoke: true,
		},
		"разметка в плоский текст": {
			raw:       `{"schemaVersion":4,"blocks":[{"id":"ft","groupId":"gft","type":"form_title","text":[{"t":"Анкета ","m":["b"]},{"t":"2026"}]}]}`,
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
	raw := `{"schemaVersion":4,"blocks":[{"id":"b","groupId":"g","type":"short_text","settings":{}}]}`
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
	s, _ := ValidateSchema(json.RawMessage(`{"schemaVersion":4,"blocks":[]}`))
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
	raw := `{"schemaVersion":4,"blocks":[` + strings.Join(blocks, ",") + `]}`
	if _, err := ValidateSchema(json.RawMessage(raw)); err != nil {
		t.Fatalf("потолок + заголовок должны проходить: %v", err)
	}
	// Но потолок остаётся потолком: 201 блок автора отвергается и с заголовком.
	blocks = append(blocks, `{"id":"bx","groupId":"gx","type":"short_text","settings":{}}`)
	raw = `{"schemaVersion":4,"blocks":[` + strings.Join(blocks, ",") + `]}`
	if _, err := ValidateSchema(json.RawMessage(raw)); err == nil {
		t.Fatal("201 блок автора должен отвергаться")
	}
}
