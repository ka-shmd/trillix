package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func intp(v int) *int { return &v }

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
			Button:   &DesignButton{Variant: "outline", Width: "full", Align: "center", Size: "lg"},
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
		"контурная кнопка":             {&FormDesign{Button: &DesignButton{Variant: "outline"}}, "rf-btn-outline"},
		"заливка — дефолт, класса нет": {&FormDesign{Button: &DesignButton{Variant: "solid"}}, ""},
		"всё сразу — порядок стабилен": {
			&FormDesign{
				Theme:    "dark",
				Controls: &DesignControls{Outline: "border"},
				Button:   &DesignButton{Variant: "outline"},
			},
			"rf-theme-dark rf-outline-border rf-btn-outline",
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
	if got := DesignFontFiles(nil); got != nil {
		t.Fatalf("нет оформления → нечего качать, получено %v", got)
	}
	if got := DesignFontFiles(&FormDesign{Font: "system"}); got != nil {
		t.Fatalf("системный стек весит 0 байт и файлов не имеет, получено %v", got)
	}
	if got := DesignFontFiles(&FormDesign{Font: "inter"}); len(got) != 2 || got[0] != "inter-cyrillic" {
		t.Fatalf("ожидались оба подмножества Inter, кириллица первой; получено %v", got)
	}
}

// branding — намерение «бейдж не показывать», и значение у него ровно одно.
// Указатель, а не bool: omitempty стёр бы false при канонизации снапшота, то есть
// публикация молча возвращала бы бейдж на форму, с которой его сняли.
func TestValidateDesign_Branding(t *testing.T) {
	no := false
	yes := true

	if err := validateDesign(&FormDesign{Branding: &no}); err != nil {
		t.Fatalf("branding: false обязан приниматься: %v", err)
	}
	if err := validateDesign(&FormDesign{Branding: &yes}); err == nil {
		t.Fatal("branding: true обязан отвергаться — «показывать» это отсутствие ключа")
	}

	// Канонизация: false переживает marshal→unmarshal, отсутствие остаётся отсутствием.
	raw, err := json.Marshal(&FormDesign{Branding: &no})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"branding":false`) {
		t.Fatalf("branding: false потерялся при сериализации: %s", raw)
	}
	raw, err = json.Marshal(&FormDesign{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "branding") {
		t.Fatalf("незаданный branding не должен появляться в документе: %s", raw)
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
