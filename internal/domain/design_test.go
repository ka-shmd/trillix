package domain

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func intp(v int) *int { return &v }

// boolp — тот же хелпер для флага: у controls.fullWidth законно только true, и
// указатель нужен, чтобы отличить «не задан» от записанного false (тот отвергается).
func boolp(v bool) *bool { return &v }

// Валидатор оформления. Таблица того же состава, что designSchema.test.ts на фронте:
// расхождение видно диффом, потому что названия кейсов совпадают.
func TestValidateDesign(t *testing.T) {
	cases := map[string]struct {
		design *FormDesign
		bad    string // подстрока ошибки; пусто — документ принимается
	}{
		"nil — оформление не трогали":      {design: nil},
		"пустой объект — всё по умолчанию": {design: &FormDesign{}},
		"полный набор": {design: &FormDesign{
			Theme: "dark",
			Palette: &DesignPalette{
				Canvas: "#111111", Field: "#1a1a1a", Text: "#eeeeee",
				Muted: "#999999", Accent: "#00aa55", Button: "#00aa55", ButtonText: "#ffffff",
			},
			Font:     "inter",
			Layout:   &DesignLayout{Width: intp(860), FontSize: intp(18), Density: "roomy", Align: "center"},
			Controls: &DesignControls{Radius: intp(0), Outline: "border"},
			Button:   &DesignButton{Variant: "outline", Width: "full", Align: "center", Weight: "bold", Size: "lg"},
		}},

		"тема вне списка":           {design: &FormDesign{Theme: "auto"}, bad: "theme"},
		"цвет без решётки":          {design: &FormDesign{Palette: &DesignPalette{Text: "112233"}}, bad: "palette.text"},
		"цвет в верхнем регистре":   {design: &FormDesign{Palette: &DesignPalette{Accent: "#AABBCC"}}, bad: "palette.accent"},
		"цвет короткой формой":      {design: &FormDesign{Palette: &DesignPalette{Canvas: "#abc"}}, bad: "palette.canvas"},
		"цвет свободной нотацией":   {design: &FormDesign{Palette: &DesignPalette{Field: "rgb(0,0,0)"}}, bad: "palette.field"},
		"шрифт вне списка":          {design: &FormDesign{Font: "comic"}, bad: "font"},
		"ширина ниже границы":       {design: &FormDesign{Layout: &DesignLayout{Width: intp(399)}}, bad: "layout.width"},
		"ширина выше границы":       {design: &FormDesign{Layout: &DesignLayout{Width: intp(1201)}}, bad: "layout.width"},
		"ширина на границах":        {design: &FormDesign{Layout: &DesignLayout{Width: intp(MinColumn)}}},
		"плотность вне списка":      {design: &FormDesign{Layout: &DesignLayout{Density: "tight"}}, bad: "layout.density"},
		"выравнивание вне списка":   {design: &FormDesign{Layout: &DesignLayout{Align: "right"}}, bad: "layout.align"},
		"кегль ниже границы":        {design: &FormDesign{Layout: &DesignLayout{FontSize: intp(13)}}, bad: "fontSize"},
		"кегль выше границы":        {design: &FormDesign{Layout: &DesignLayout{FontSize: intp(21)}}, bad: "fontSize"},
		"кегль на нижней границе":   {design: &FormDesign{Layout: &DesignLayout{FontSize: intp(MinFontSize)}}},
		"кегль на верхней границе":  {design: &FormDesign{Layout: &DesignLayout{FontSize: intp(MaxFontSize)}}},
		"радиус ниже границы":       {design: &FormDesign{Controls: &DesignControls{Radius: intp(-1)}}, bad: "radius"},
		"радиус выше границы":       {design: &FormDesign{Controls: &DesignControls{Radius: intp(25)}}, bad: "radius"},
		"радиус ноль — прямые углы": {design: &FormDesign{Controls: &DesignControls{Radius: intp(0)}}},
		"контур вне списка":         {design: &FormDesign{Controls: &DesignControls{Outline: "dotted"}}, bad: "controls.outline"},
		"вид кнопки вне списка":     {design: &FormDesign{Button: &DesignButton{Variant: "ghost"}}, bad: "button.variant"},
		"ширина кнопки вне списка":  {design: &FormDesign{Button: &DesignButton{Width: "half"}}, bad: "button.width"},
		"размер кнопки вне списка":  {design: &FormDesign{Button: &DesignButton{Size: "xl"}}, bad: "button.size"},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			err := validateDesign(tc.design)
			if tc.bad == "" {
				if err != nil {
					t.Fatalf("документ должен приниматься, получено: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("ожидалась ошибка про %q, документ принят", tc.bad)
			}
			if !strings.Contains(err.Error(), tc.bad) {
				t.Fatalf("ошибка не про %q: %v", tc.bad, err)
			}
		})
	}
}

// Оформление приезжает через ValidateSchema, а не мимо неё: у валидатора один вход,
// и проверка, вызываемая только в тесте, не защищает ничего.
// ШИРИНА ПОЛЯ — ПОТОЛОК И ФЛАГ. `false` отвергается не из придирчивости: дефолт во
// всей фазе хранится отсутствием ключа, и записанный `false` дал бы документ,
// отличающийся от исходного при одинаковом виде. Зеркало на фронте —
// `z.literal(true).optional()`.
func TestValidateDesign_FieldWidth(t *testing.T) {
	ok := []*FormDesign{
		{Controls: &DesignControls{FullWidth: boolp(true)}},
		{Controls: &DesignControls{Width: intp(MinFieldWidth)}},
		{Controls: &DesignControls{Width: intp(MaxFieldWidth)}},
		// Флаг и число вместе законны: число ждёт возврата к фиксированной ширине.
		{Controls: &DesignControls{FullWidth: boolp(true), Width: intp(480)}},
		{Controls: &DesignControls{}},
	}
	for i, d := range ok {
		if err := validateDesign(d); err != nil {
			t.Fatalf("случай %d обязан приниматься: %v", i, err)
		}
	}
	bad := []*FormDesign{
		{Controls: &DesignControls{FullWidth: boolp(false)}},
		{Controls: &DesignControls{Width: intp(MinFieldWidth - 1)}},
		{Controls: &DesignControls{Width: intp(MaxFieldWidth + 1)}},
	}
	for i, d := range bad {
		if err := validateDesign(d); err == nil {
			t.Fatalf("случай %d обязан отвергаться", i)
		}
	}
}

// Та же настройка на выходе: потолок печатается числом, флаг — процентами и сильнее
// числа. Значения сверяются с таблицей на фронте (design.test.ts, тот же состав).
func TestDesignVars_FieldWidth(t *testing.T) {
	cases := map[string]struct {
		design *FormDesign
		want   string
	}{
		"число":                      {&FormDesign{Controls: &DesignControls{Width: intp(480)}}, "480px"},
		"полная ширина":              {&FormDesign{Controls: &DesignControls{FullWidth: boolp(true)}}, "100%"},
		"флаг сильнее числа":         {&FormDesign{Controls: &DesignControls{FullWidth: boolp(true), Width: intp(480)}}, "100%"},
		"не задано — переменной нет": {&FormDesign{Controls: &DesignControls{}}, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			got := DesignVars(tc.design)["--rf-input-max"]
			if got != tc.want {
				t.Fatalf("%q, ожидалось %q", got, tc.want)
			}
		})
	}
}

// Высота контрола. Диапазон отдельный от ширины: у высоты низ упирается в строку
// 16/1.5, а не в читаемость поля. Кнопка едет за этой же переменной — она объявлена
// как var(--rf-control-h), поэтому своей ветки в таблице не имеет.
func TestValidateDesign_FieldHeight(t *testing.T) {
	for _, d := range []*FormDesign{
		{Controls: &DesignControls{Height: intp(MinFieldHeight)}},
		{Controls: &DesignControls{Height: intp(MaxFieldHeight)}},
	} {
		if err := validateDesign(d); err != nil {
			t.Fatalf("границы обязаны приниматься: %v", err)
		}
	}
	for _, d := range []*FormDesign{
		{Controls: &DesignControls{Height: intp(MinFieldHeight - 1)}},
		{Controls: &DesignControls{Height: intp(MaxFieldHeight + 1)}},
	} {
		if err := validateDesign(d); err == nil {
			t.Fatal("значение вне диапазона обязано отвергаться")
		}
	}
	if got := DesignVars(&FormDesign{Controls: &DesignControls{Height: intp(44)}})["--rf-control-h"]; got != "44px" {
		t.Fatalf("--rf-control-h = %q, ожидалось 44px", got)
	}
}

// Толщина края. Ноль законен — кольцо исчезает, слои тени остаются; проверяется он
// отдельно, потому что именно его съедает проверка «на истинность» вместо nil.
func TestValidateDesign_BorderWidth(t *testing.T) {
	for _, d := range []*FormDesign{
		{Controls: &DesignControls{BorderWidth: intp(MinBorderWidth)}},
		{Controls: &DesignControls{BorderWidth: intp(MaxBorderWidth)}},
	} {
		if err := validateDesign(d); err != nil {
			t.Fatalf("границы обязаны приниматься: %v", err)
		}
	}
	if err := validateDesign(&FormDesign{Controls: &DesignControls{BorderWidth: intp(MaxBorderWidth + 1)}}); err == nil {
		t.Fatal("значение вне диапазона обязано отвергаться")
	}
	if got := DesignVars(&FormDesign{Controls: &DesignControls{BorderWidth: intp(0)}})["--rf-ring-w"]; got != "0px" {
		t.Fatalf("--rf-ring-w при нуле = %q, ожидалось 0px", got)
	}
	if got := DesignVars(&FormDesign{Palette: &DesignPalette{Border: "#d0d0d0"}})["--rf-ring"]; got != "#d0d0d0" {
		t.Fatalf("--rf-ring = %q", got)
	}
}

// Тень: в документ попадает только СНЯТИЕ. `true` отвергается — тень это дефолт, а
// дефолт хранится отсутствием ключа (то же правило, что у controls.fullWidth).
func TestValidateDesign_Shadow(t *testing.T) {
	if err := validateDesign(&FormDesign{Controls: &DesignControls{Shadow: boolp(false)}}); err != nil {
		t.Fatalf("false обязан проходить: %v", err)
	}
	if err := validateDesign(&FormDesign{Controls: &DesignControls{Shadow: boolp(true)}}); err == nil {
		t.Fatal("true обязан отвергаться — тень по умолчанию хранится отсутствием ключа")
	}
}

// Воздух вокруг поля. Ноль законен у обоих — поле без боковых полей и вопросы
// вплотную; он же и проверяется, потому что его съедает проверка «на истинность».
func TestValidateDesign_Spacing(t *testing.T) {
	ok := &FormDesign{Controls: &DesignControls{PaddingX: intp(0), MarginBottom: intp(0)}}
	if err := validateDesign(ok); err != nil {
		t.Fatalf("ноль обязан проходить: %v", err)
	}
	vars := DesignVars(ok)
	if vars["--rf-input-px"] != "0px" || vars["--rf-space-q"] != "0px" {
		t.Fatalf("ноль обязан печататься: %v", vars)
	}
	for _, d := range []*FormDesign{
		{Controls: &DesignControls{PaddingX: intp(MaxPaddingX + 1)}},
		{Controls: &DesignControls{MarginBottom: intp(MaxMarginBottom + 1)}},
	} {
		if err := validateDesign(d); err == nil {
			t.Fatal("значение вне диапазона обязано отвергаться")
		}
	}
}

// Три режима ширины кнопки. Число читается только в fixed; заданный режим без числа
// печатает дефолт, иначе кнопка молча осталась бы «по тексту».
func TestDesignVars_ButtonWidth(t *testing.T) {
	cases := map[string]struct {
		button *DesignButton
		want   string
	}{
		"по тексту":               {&DesignButton{Width: "auto"}, ""},
		"во всю ширину":           {&DesignButton{Width: "full"}, "100%"},
		"фиксированная числом":    {&DesignButton{Width: "fixed", WidthPx: intp(260)}, "260px"},
		"фиксированная без числа": {&DesignButton{Width: "fixed"}, "200px"},
		"число вне режима молчит": {&DesignButton{Width: "auto", WidthPx: intp(260)}, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := DesignVars(&FormDesign{Button: tc.button})["--rf-submit-width"]; got != tc.want {
				t.Fatalf("%q, ожидалось %q", got, tc.want)
			}
		})
	}
	if err := validateDesign(&FormDesign{Button: &DesignButton{WidthPx: intp(MaxButtonWidth + 1)}}); err == nil {
		t.Fatal("ширина вне диапазона обязана отвергаться")
	}
}

// Высота кнопки: число сильнее готового размера и только по высоте.
func TestDesignVars_ButtonHeight(t *testing.T) {
	vars := DesignVars(&FormDesign{Button: &DesignButton{Size: "lg", Height: intp(52)}})
	if vars["--rf-submit-h"] != "52px" {
		t.Fatalf("--rf-submit-h = %q, ожидалось 52px", vars["--rf-submit-h"])
	}
	if vars["--rf-submit-px"] != "2rem" || vars["--rf-submit-ratio"] != "1" {
		t.Fatalf("поля и кегль обязаны остаться от размера lg: %v", vars)
	}
	if err := validateDesign(&FormDesign{Button: &DesignButton{Height: intp(MaxButtonHeight + 1)}}); err == nil {
		t.Fatal("высота вне диапазона обязана отвергаться")
	}
}

// Положение кнопки — ТРИ значения (у выравнивания текста формы их два). Слева дефолт
// и не печатается; справа — flex-end, потому что настройка задаёт justify-content РЯДА.
func TestDesignVars_ButtonAlign(t *testing.T) {
	cases := map[string]string{"left": "", "center": "center", "right": "flex-end"}
	for align, want := range cases {
		t.Run(align, func(t *testing.T) {
			got := DesignVars(&FormDesign{Button: &DesignButton{Align: align}})["--rf-submit-justify"]
			if got != want {
				t.Fatalf("%q, ожидалось %q", got, want)
			}
		})
	}
	if err := validateDesign(&FormDesign{Button: &DesignButton{Align: "justify"}}); err == nil {
		t.Fatal("значение вне списка обязано отвергаться")
	}
	// Кегль и скругление — свои токены поверх общих.
	vars := DesignVars(&FormDesign{Button: &DesignButton{FontSize: intp(18), Radius: intp(8)}})
	if vars["--rf-submit-size"] != "18px" || vars["--rf-submit-radius"] != "8px" {
		t.Fatalf("свои токены кнопки не напечатаны: %v", vars)
	}
}

// Воздух кнопки: верхний свой и добавочный (ноль печатается — это выбор «без
// добавки»), боковые поля сильнее готового размера.
func TestDesignVars_ButtonSpacing(t *testing.T) {
	if got := DesignVars(&FormDesign{Button: &DesignButton{MarginTop: intp(0)}})["--rf-submit-mt"]; got != "0px" {
		t.Fatalf("--rf-submit-my при нуле = %q, ожидалось 0px", got)
	}
	vars := DesignVars(&FormDesign{Button: &DesignButton{Size: "lg", PaddingX: intp(28)}})
	if vars["--rf-submit-px"] != "28px" || vars["--rf-submit-h"] != "2.75rem" {
		t.Fatalf("число обязано перебить только поля: %v", vars)
	}
	if err := validateDesign(&FormDesign{Button: &DesignButton{MarginTop: intp(MaxButtonMarginTop + 1)}}); err == nil {
		t.Fatal("значение вне диапазона обязано отвергаться")
	}
}

func TestValidateSchema_Design(t *testing.T) {
	t.Run("принимается в составе схемы", func(t *testing.T) {
		raw := json.RawMessage(`{"schemaVersion":1,"blocks":[],
			"design":{"theme":"dark","font":"inter","palette":{"accent":"#00aa55"},"layout":{"fontSize":18}}}`)
		s, err := ValidateSchema(raw)
		if err != nil {
			t.Fatalf("схема с оформлением отвергнута: %v", err)
		}
		if s.Design == nil || s.Design.Theme != "dark" {
			t.Fatalf("оформление не доехало: %+v", s.Design)
		}
		if s.Design.Layout == nil || s.Design.Layout.FontSize == nil || *s.Design.Layout.FontSize != 18 {
			t.Fatalf("кегль не доехал: %+v", s.Design.Layout)
		}
	})

	t.Run("мусор внутри design даёт 422", func(t *testing.T) {
		raw := json.RawMessage(`{"schemaVersion":1,"blocks":[],"design":{"theme":"auto"}}`)
		if _, err := ValidateSchema(raw); err == nil {
			t.Fatal("схема с неизвестной темой принята")
		}
	})

	t.Run("лишний ключ внутри design даёт 422", func(t *testing.T) {
		// DisallowUnknownFields обязан работать и на вложенном объекте: опечатка в
		// ключе оформления иначе осела бы мусором в JSONB и однажды была бы прочитана
		// как настройка.
		raw := json.RawMessage(`{"schemaVersion":1,"blocks":[],"design":{"themee":"dark"}}`)
		if _, err := ValidateSchema(raw); err == nil {
			t.Fatal("схема с лишним ключом оформления принята")
		}
	})

	t.Run("документ без design не меняется", func(t *testing.T) {
		// Контракт фазы: форма, у которой оформления не трогали, обязана вести себя
		// как до неё. Здесь это значит «поле остаётся nil и не синтезируется».
		s, err := ValidateSchema(json.RawMessage(`{"schemaVersion":1,"blocks":[]}`))
		if err != nil {
			t.Fatalf("схема без оформления отвергнута: %v", err)
		}
		if s.Design != nil {
			t.Fatalf("design синтезирован там, где его не было: %+v", s.Design)
		}
		out, err := json.Marshal(s)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(out), "design") {
			t.Fatalf("ключ design появился в сериализации: %s", out)
		}
	})

	t.Run("старый документ поднимается без оформления", func(t *testing.T) {
		// Апгрейдер v1→v4 про design не знает и знать не должен: поле необязательное,
		// версию оно не поднимает.
		s, err := ValidateSchema(json.RawMessage(`{"blocks":[]}`))
		if err != nil {
			t.Fatalf("v1-документ отвергнут: %v", err)
		}
		if s.Design != nil {
			t.Fatalf("апгрейд придумал оформление: %+v", s.Design)
		}
	})
}

func TestDesignVars(t *testing.T) {
	t.Run("nil и пустой дают пустую карту", func(t *testing.T) {
		if got := DesignVars(nil); len(got) != 0 {
			t.Fatalf("nil дал переменные: %v", got)
		}
		if got := DesignVars(&FormDesign{}); len(got) != 0 {
			t.Fatalf("пустое оформление дало переменные: %v", got)
		}
	})

	t.Run("тема сама по себе переменных не даёт", func(t *testing.T) {
		// Тема выражается классом (color-scheme переменной не выразить), поэтому
		// форма только с темой не должна печатать ни одного объявления.
		if got := DesignVars(&FormDesign{Theme: "dark"}); len(got) != 0 {
			t.Fatalf("тема дала переменные: %v", got)
		}
	})

	t.Run("заданное переводится, незаданное молчит", func(t *testing.T) {
		got := DesignVars(&FormDesign{
			Palette:  &DesignPalette{Accent: "#00aa55"},
			Layout:   &DesignLayout{Width: intp(560), FontSize: intp(18), Density: "compact", Align: "center"},
			Controls: &DesignControls{Radius: intp(0)},
			Font:     "inter",
		})
		want := map[string]string{
			"--rf-accent":       "#00aa55",
			"--rf-accent-badge": "#00aa55",
			"--rf-column":       "560px",
			"--rf-font-size":    "18px",
			"--rf-density":      "0.75",
			"--rf-align":        "center",
			"--rf-align-items":  "center",
			"--rf-radius":       "0px",
			"--rf-font-family":  "Inter, system-ui, -apple-system, sans-serif",
		}
		if len(got) != len(want) {
			t.Fatalf("состав переменных разошёлся:\nполучено %v\nождалось %v", got, want)
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s = %q, ожидалось %q", k, got[k], v)
			}
		}
	})

	t.Run("радиус 0 печатается, а не пропадает", func(t *testing.T) {
		// Ловушка «нулевое значение неотличимо от незаданного»: прямые углы — это
		// выбор автора, и он обязан доехать до CSS.
		got := DesignVars(&FormDesign{Controls: &DesignControls{Radius: intp(0)}})
		if got["--rf-radius"] != "0px" {
			t.Fatalf("радиус 0 потерян: %v", got)
		}
	})
}

func TestDesignStyleAttr(t *testing.T) {
	t.Run("ключи отсортированы", func(t *testing.T) {
		// Обход map в Go рандомизирован, а строка уезжает в HTML публичной страницы:
		// прыгающий порядок ломал бы и сравнение с фронтом, и кеширование ответа.
		d := &FormDesign{
			Palette: &DesignPalette{Text: "#111111", Accent: "#00aa55", Canvas: "#ffffff"},
		}
		want := "--rf-accent: #00aa55; --rf-accent-badge: #00aa55; --rf-canvas: #ffffff; --rf-text: #111111;"
		for i := 0; i < 20; i++ {
			if got := DesignStyleAttr(d); got != want {
				t.Fatalf("прогон %d: %q, ожидалось %q", i, got, want)
			}
		}
	})

	t.Run("пусто для формы без оформления", func(t *testing.T) {
		if got := DesignStyleAttr(nil); got != "" {
			t.Fatalf("непустой style у формы без оформления: %q", got)
		}
	})
}

func TestDesignClasses(t *testing.T) {
	cases := map[string]struct {
		design *FormDesign
		want   string
	}{
		"нет оформления":               {nil, ""},
		"светлая — дефолт, класса нет": {&FormDesign{Theme: "light"}, ""},
		"тема не задана":               {&FormDesign{}, ""},
		"тёмная":                       {&FormDesign{Theme: "dark"}, "rf-theme-dark"},
		"контур рамкой":                {&FormDesign{Controls: &DesignControls{Outline: "border"}}, "rf-outline-border"},
		"без контура":                  {&FormDesign{Controls: &DesignControls{Outline: "none"}}, "rf-outline-none"},
		"тень — дефолт, класса нет":    {&FormDesign{Controls: &DesignControls{Outline: "shadow"}}, ""},
		"снятая тень":                  {&FormDesign{Controls: &DesignControls{Shadow: boolp(false)}}, "rf-shadow-off"},
		"контурная кнопка":             {&FormDesign{Button: &DesignButton{Variant: "outline"}}, "rf-btn-outline"},
		"заливка — дефолт, класса нет": {&FormDesign{Button: &DesignButton{Variant: "solid"}}, ""},
		"всё сразу — порядок стабилен": {
			&FormDesign{
				Theme:    "dark",
				Controls: &DesignControls{Outline: "border", Shadow: boolp(false)},
				Button:   &DesignButton{Variant: "outline"},
			},
			"rf-theme-dark rf-outline-border rf-shadow-off rf-btn-outline",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := DesignClasses(tc.design); got != tc.want {
				t.Fatalf("%q, ожидалось %q", got, tc.want)
			}
		})
	}
}

func TestDesignVars_Button(t *testing.T) {
	t.Run("положение — justify ряда, а не align-self кнопки", func(t *testing.T) {
		// Кнопка лежит в .rf-nav — это flex-СТРОКА, и align-self двигал бы её по
		// вертикали, где двигать нечего. Первая редакция слайса ошиблась именно осью:
		// значение в стиле стояло, а кнопка не двигалась ни на одной поверхности.
		got := DesignVars(&FormDesign{Button: &DesignButton{Align: "center"}})
		if got["--rf-submit-justify"] != "center" {
			t.Fatalf("--rf-submit-justify = %q, ожидалось center", got["--rf-submit-justify"])
		}
		if _, ok := got["--rf-submit-self"]; ok {
			t.Fatal("--rf-submit-self вернулась — положение задаётся рядом, а не кнопкой")
		}
	})

	t.Run("во всю ширину плюс центр — обе переменные, центр инертен", func(t *testing.T) {
		// Растянутой кнопке двигаться некуда, но отдельной ветки для этого нет
		// намеренно: инертное правило равно отсутствующему (тот же приём, что в
		// условной логике), а панель этот выбор и так не даёт сделать.
		got := DesignVars(&FormDesign{Button: &DesignButton{Width: "full", Align: "center"}})
		if got["--rf-submit-width"] != "100%" {
			t.Fatalf("--rf-submit-width = %q", got["--rf-submit-width"])
		}
		if got["--rf-submit-justify"] != "center" {
			t.Fatalf("--rf-submit-justify = %q", got["--rf-submit-justify"])
		}
	})

	t.Run("средний размер переменных не печатает", func(t *testing.T) {
		// md — дефолт fields.css; печатать для него переменные значило бы писать в
		// документ то, что и так есть.
		got := DesignVars(&FormDesign{Button: &DesignButton{Size: "md"}})
		if len(got) != 0 {
			t.Fatalf("средний размер дал переменные: %v", got)
		}
	})

	t.Run("толщина: дефолтная ступень молчит, остальные печатают число", func(t *testing.T) {
		// "semibold" — дефолт fields.css (--rf-submit-weight: 600). Кейсы того же
		// состава, что в design.test.ts на фронте: смысл настройки машине не сверить,
		// его держат зеркальные таблицы (шапка design_parity_test.go).
		if got := DesignVars(&FormDesign{Button: &DesignButton{Weight: "semibold"}}); len(got) != 0 {
			t.Fatalf("дефолтная ступень дала переменные: %v", got)
		}
		for weight, want := range map[string]string{"normal": "400", "bold": "700"} {
			got := DesignVars(&FormDesign{Button: &DesignButton{Weight: weight}})["--rf-submit-weight"]
			if got != want {
				t.Errorf("толщина %q = %q, ожидалось %q", weight, got, want)
			}
		}
		if err := validateDesign(&FormDesign{Button: &DesignButton{Weight: "black"}}); err == nil {
			t.Error("ступень вне списка обязана отвергаться")
		}
	})

	t.Run("крупный размер даёт три метрики", func(t *testing.T) {
		got := DesignVars(&FormDesign{Button: &DesignButton{Size: "lg"}})
		want := map[string]string{"--rf-submit-h": "2.75rem", "--rf-submit-px": "2rem", "--rf-submit-ratio": "1"}
		if len(got) != len(want) {
			t.Fatalf("состав разошёлся: %v", got)
		}
		for k, v := range want {
			if got[k] != v {
				t.Errorf("%s = %q, ожидалось %q", k, got[k], v)
			}
		}
	})
}

// Цвет строки браузера: холст автора сильнее темы, тема сильнее умолчания, а
// умолчание не печатает мету вовсе — светлый холст и так белый, а зафиксированная
// мета отняла бы у браузера право решать самому.
func TestDesignThemeColor(t *testing.T) {
	cases := []struct {
		name string
		d    *FormDesign
		want string
	}{
		{"нет оформления", nil, ""},
		{"светлая по умолчанию", &FormDesign{}, ""},
		{"тёмная тема", &FormDesign{Theme: "dark"}, designDarkCanvas},
		{"свой холст", &FormDesign{Palette: &DesignPalette{Canvas: "#fff8e7"}}, "#fff8e7"},
		{"свой холст поверх тёмной", &FormDesign{Theme: "dark", Palette: &DesignPalette{Canvas: "#101014"}}, "#101014"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := DesignThemeColor(c.d); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestDesignFontFiles(t *testing.T) {
	// Незаданный шрифт — это дефолт, а не «нечего качать»: таких форм большинство, и
	// именно им preload нужнее всего.
	want := designFontFiles[DesignFontDefault]
	if got := DesignFontFiles(nil); !slices.Equal(got, want) {
		t.Fatalf("форма без оформления обязана качать дефолтное семейство %v, получено %v", want, got)
	}
	if got := DesignFontFiles(&FormDesign{}); !slices.Equal(got, want) {
		t.Fatalf("шрифт не выбран → дефолтное семейство %v, получено %v", want, got)
	}
	if got := DesignFontFiles(&FormDesign{Font: "inter"}); len(got) != 2 || got[0] != "inter-cyrillic" {
		t.Fatalf("ожидались оба подмножества Inter, кириллица первой; получено %v", got)
	}
}

// Дефолт — платная настройка ровно тогда, когда он ЗАПИСАН: пока ключа нет, автор
// ничего не выбирал. Проверяется на шрифте, потому что исключение для одного семейства
// стало бы дырой в гейте.
func TestDesignPaidFeatures_Font(t *testing.T) {
	has := func(d *FormDesign) bool {
		return slices.Contains(DesignPaidFeatures(d), "шрифт")
	}
	if has(&FormDesign{}) {
		t.Error("шрифт не выбран — платить не за что")
	}
	if !has(&FormDesign{Font: "lora"}) {
		t.Error("семейство выбрано явно — это выбор автора")
	}
	if !has(&FormDesign{Font: DesignFontDefault}) {
		t.Error("записанный дефолт — тоже выбор: панель его не пишет, но схема принимает")
	}
}

// Бейджа в оформлении больше нет: намерение автора живёт колонкой forms.branding
// (ADR §10, миграция 0038). Ключ обязан ОТВЕРГАТЬСЯ, а не молча оседать в JSONB:
// вернись он в документ, на один вопрос «показывать ли бейдж» отвечали бы два
// места, и однажды по-разному. Документы, у которых ключ был, чистит та же
// миграция (migrations/branding_test.go).
func TestValidateDesign_BrandingKeyGone(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"blocks":[],"design":{"branding":false}}`)
	if _, err := ValidateSchema(raw); err == nil {
		t.Fatal("схема с design.branding принята — ключ обязан быть неизвестным")
	}
}

// Свой CSS формы: два рубежа — объём и `</`. Разобрать CSS валидатор не может и не
// пытается; всё остальное закрывает CSP (спека §10.1).
func TestValidateDesign_CustomCSS(t *testing.T) {
	ok := func(css string) *FormDesign { return &FormDesign{CSS: css} }

	if err := validateDesign(ok(".rf-page { padding: 0 }")); err != nil {
		t.Fatalf("обычный CSS обязан приниматься: %v", err)
	}
	// Руны, а не байты: кириллица в комментарии не должна съедать лимит вдвое быстрее.
	if err := validateDesign(ok(strings.Repeat("я", MaxCustomCSSLen))); err != nil {
		t.Fatalf("CSS ровно по лимиту обязан приниматься: %v", err)
	}
	if err := validateDesign(ok(strings.Repeat("я", MaxCustomCSSLen+1))); err == nil {
		t.Fatal("CSS сверх лимита обязан отвергаться")
	}
	for _, bad := range []string{"</style><script>alert(1)</script>", ".a{}\n</STYLE"} {
		if err := validateDesign(ok(bad)); err == nil {
			t.Fatalf("`</` обязано отвергаться: %q", bad)
		}
	}
}

// Своё имя блока — строгая форма. Пробел означал бы второй класс, заглавные — пару
// `.Foo`/`.foo`, которую автор не сможет воспроизвести.
func TestValidateSchema_BlockClass(t *testing.T) {
	schema := func(cls string) json.RawMessage {
		return json.RawMessage(`{"schemaVersion":1,"blocks":[
			{"id":"b1","groupId":"g1","type":"short_text","class":"` + cls + `"}]}`)
	}
	for _, good := range []string{"promo", "my-block", "a", "a1-b2"} {
		if _, err := ValidateSchema(schema(good)); err != nil {
			t.Errorf("class %q обязан приниматься: %v", good, err)
		}
	}
	for _, bad := range []string{"Promo", "two words", "-lead", "1st", "very-long-name-that-goes-past-the-limit"} {
		if _, err := ValidateSchema(schema(bad)); err == nil {
			t.Errorf("class %q обязан отвергаться", bad)
		}
	}
}
