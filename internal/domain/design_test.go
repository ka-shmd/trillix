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
			Font:     &DesignFont{Body: "inter", Heading: "golos"},
			Layout:   &DesignLayout{Width: "wide", FontSize: intp(18), Density: "roomy", Align: "center"},
			Controls: &DesignControls{Radius: intp(0), Outline: "border"},
			Button:   &DesignButton{Variant: "outline", Width: "full", Align: "center", Size: "lg"},
		}},

		"тема вне списка":            {design: &FormDesign{Theme: "auto"}, bad: "theme"},
		"цвет без решётки":           {design: &FormDesign{Palette: &DesignPalette{Text: "112233"}}, bad: "palette.text"},
		"цвет в верхнем регистре":    {design: &FormDesign{Palette: &DesignPalette{Accent: "#AABBCC"}}, bad: "palette.accent"},
		"цвет короткой формой":       {design: &FormDesign{Palette: &DesignPalette{Canvas: "#abc"}}, bad: "palette.canvas"},
		"цвет свободной нотацией":    {design: &FormDesign{Palette: &DesignPalette{Field: "rgb(0,0,0)"}}, bad: "palette.field"},
		"шрифт вне списка":           {design: &FormDesign{Font: &DesignFont{Body: "comic"}}, bad: "font.body"},
		"шрифт заголовка вне списка": {design: &FormDesign{Font: &DesignFont{Heading: "comic"}}, bad: "font.heading"},
		"ширина вне списка":          {design: &FormDesign{Layout: &DesignLayout{Width: "huge"}}, bad: "layout.width"},
		"плотность вне списка":       {design: &FormDesign{Layout: &DesignLayout{Density: "tight"}}, bad: "layout.density"},
		"выравнивание вне списка":    {design: &FormDesign{Layout: &DesignLayout{Align: "right"}}, bad: "layout.align"},
		"кегль ниже границы":         {design: &FormDesign{Layout: &DesignLayout{FontSize: intp(13)}}, bad: "fontSize"},
		"кегль выше границы":         {design: &FormDesign{Layout: &DesignLayout{FontSize: intp(21)}}, bad: "fontSize"},
		"кегль на нижней границе":    {design: &FormDesign{Layout: &DesignLayout{FontSize: intp(MinFontSize)}}},
		"кегль на верхней границе":   {design: &FormDesign{Layout: &DesignLayout{FontSize: intp(MaxFontSize)}}},
		"радиус ниже границы":        {design: &FormDesign{Controls: &DesignControls{Radius: intp(-1)}}, bad: "radius"},
		"радиус выше границы":        {design: &FormDesign{Controls: &DesignControls{Radius: intp(25)}}, bad: "radius"},
		"радиус ноль — прямые углы":  {design: &FormDesign{Controls: &DesignControls{Radius: intp(0)}}},
		"контур вне списка":          {design: &FormDesign{Controls: &DesignControls{Outline: "dotted"}}, bad: "controls.outline"},
		"вид кнопки вне списка":      {design: &FormDesign{Button: &DesignButton{Variant: "ghost"}}, bad: "button.variant"},
		"ширина кнопки вне списка":   {design: &FormDesign{Button: &DesignButton{Width: "half"}}, bad: "button.width"},
		"размер кнопки вне списка":   {design: &FormDesign{Button: &DesignButton{Size: "xl"}}, bad: "button.size"},
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
		raw := json.RawMessage(`{"schemaVersion":4,"blocks":[],
			"design":{"theme":"dark","palette":{"accent":"#00aa55"},"layout":{"fontSize":18}}}`)
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
		raw := json.RawMessage(`{"schemaVersion":4,"blocks":[],"design":{"theme":"auto"}}`)
		if _, err := ValidateSchema(raw); err == nil {
			t.Fatal("схема с неизвестной темой принята")
		}
	})

	t.Run("лишний ключ внутри design даёт 422", func(t *testing.T) {
		// DisallowUnknownFields обязан работать и на вложенном объекте: опечатка в
		// ключе оформления иначе осела бы мусором в JSONB и однажды была бы прочитана
		// как настройка.
		raw := json.RawMessage(`{"schemaVersion":4,"blocks":[],"design":{"themee":"dark"}}`)
		if _, err := ValidateSchema(raw); err == nil {
			t.Fatal("схема с лишним ключом оформления принята")
		}
	})

	t.Run("документ без design не меняется", func(t *testing.T) {
		// Контракт фазы: форма, у которой оформления не трогали, обязана вести себя
		// как до неё. Здесь это значит «поле остаётся nil и не синтезируется».
		s, err := ValidateSchema(json.RawMessage(`{"schemaVersion":4,"blocks":[]}`))
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
			Layout:   &DesignLayout{Width: "narrow", FontSize: intp(18), Density: "compact", Align: "center"},
			Controls: &DesignControls{Radius: intp(0)},
			Font:     &DesignFont{Body: "inter"},
		})
		want := map[string]string{
			"--rf-accent":      "#00aa55",
			"--rf-column":      "560px",
			"--rf-font-size":   "18px",
			"--rf-density":     "0.75",
			"--rf-align":       "center",
			"--rf-align-items": "center",
			"--rf-radius":      "0px",
			"--rf-font-family": "Inter, system-ui, -apple-system, sans-serif",
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
		want := "--rf-accent: #00aa55; --rf-canvas: #ffffff; --rf-text: #111111;"
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

func TestDesignThemeClass(t *testing.T) {
	cases := map[string]struct {
		design *FormDesign
		want   string
	}{
		"нет оформления":               {nil, ""},
		"светлая — дефолт, класса нет": {&FormDesign{Theme: "light"}, ""},
		"тема не задана":               {&FormDesign{}, ""},
		"тёмная":                       {&FormDesign{Theme: "dark"}, "rf-theme-dark"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			if got := DesignThemeClass(tc.design); got != tc.want {
				t.Fatalf("%q, ожидалось %q", got, tc.want)
			}
		})
	}
}
